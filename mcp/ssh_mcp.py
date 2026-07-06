#!/usr/bin/env python3
"""
SSH MCP Server — Windsurf 零卡顿架构
═══════════════════════════════════════════════════════════════
  Windsurf ←stdio→ FastMCP ←async→ asyncssh ←TCP→ Kali Linux
═══════════════════════════════════════════════════════════════

技术选型 (2个依赖, 零手写轮子):
  asyncssh  → 原生 async SSH, 单连接多路复用, 永不阻塞事件循环
  FastMCP   → MCP stdio 传输, Windsurf 原生支持

抗卡顿设计:
  ① 全 async def 工具     → 事件循环永不被阻塞 (根治 paramiko 卡死)
  ② SSH 通道复用           → 1条TCP跑N个命令, 无需连接池
  ③ asyncio.wait_for      → 所有操作硬超时兜底
  ④ 断线自动重连           → 透明恢复, keepalive 防空闲断连
  ⑤ 每窗口独立进程         → 多窗口天然隔离, 零竞争

vs 旧架构 (paramiko):
  ✗ paramiko 是阻塞库 → 需要 ThreadPoolExecutor + sync→async 包装
  ✗ 连接池 + 线程锁 → 200行样板代码
  ✗ FastMCP call_fn_with_arg_validation 对 sync 函数直接调用 → 卡死
  ✓ asyncssh 原生 async → 零包装, 零线程池, 零猴子补丁

依赖安装: pip install "mcp[cli]" asyncssh
"""

import asyncio
import base64
import logging
import os
import random
import re
import sys
import time
import warnings
from typing import Optional

# ═══════════════════════════════════════════════════════════════
# 静默一切噪音 — MCP stdio 协议需要干净的 stdout/stderr
# ═══════════════════════════════════════════════════════════════
warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

import asyncssh
from mcp.server.fastmcp import FastMCP

# ═══════════════════════════════════════════════════════════════
# 配置 (全部从环境变量读取，不内置任何凭据默认值)
#   必须设置 SSH_HOST / SSH_USER / SSH_PASS（或改用 SSH_ALIAS 走密钥）。
#   缺失时连接会失败并提示，绝不回退到硬编码的主机/密码。
# ═══════════════════════════════════════════════════════════════
DEFAULT_SSH = {
    "host":     os.getenv("SSH_HOST", ""),
    "port":     int(os.getenv("SSH_PORT", "22")),
    "username": os.getenv("SSH_USER", ""),
    "password": os.getenv("SSH_PASS", ""),
}

# SSH 别名模式: 设置后通过本地 ssh 命令连接，支持 ProxyCommand/cloudflared 等隧道
SSH_ALIAS = os.getenv("SSH_ALIAS", "")

MAX_OUTPUT       = 200_000   # 单次最大输出字符
CMD_TIMEOUT      = 120       # 命令默认超时 (秒)
CONNECT_TIMEOUT  = 15        # SSH 连接超时
KEEPALIVE        = 15        # keepalive 间隔 (防空闲断连)

# ═══════════════════════════════════════════════════════════════
# 抗封禁 / 限速 / 代理出口轮换 (针对高防目标)
#   高防目标有 WAF / 速率限制 / IPS。默认速率打过去几分钟内源 IP 就被 ban，
#   之后所有工具全部超时。这里提供多层缓解：
#     ① 命令间最小间隔 + 抖动 —— low-and-slow，降低触发速率阈值的概率。
#        - 进程内闸门 _rate_gate()：本 MCP 进程内的相邻命令间隔。
#        - 跨 solver 共享闸门 _shared_pace_prefix()：所有 solver 的 MCP 进程都 SSH
#          进同一台 Kali，用 Kali 上的 flock+时间戳文件做「跨进程」节流，避免 N 个
#          并发 solver 打同一目标时源 IP 的实际 QPS 叠加成 N 倍（开 ATTACK_RATE_SHARED=1）。
#     ② 封禁信号检测 _detect_ban()：输出里出现 403/429/验证码/Cloudflare 拦截页/连续超时时，
#        在返回文本前挂 [ANTI-BAN WARN] 横幅。现覆盖一次性命令 + 后台任务 poll。
#     ③ 代理出口轮换 —— ATTACK_PROXY_POOL 配了 socks5/http 代理池后，ssh_execute_proxied
#        与 ssh_exec_bg(proxied=True) 会给命令加 proxychains 前缀，每次取池里下一个出口。
#   全部默认关闭（未配置环境变量时零行为变化）。
# ═══════════════════════════════════════════════════════════════
# 每条命令之间的最小间隔 (秒)，0 = 不限速 (默认关闭以保持既有行为)
RATE_MIN_INTERVAL = float(os.getenv("ATTACK_RATE_MIN_INTERVAL", "0") or "0")
# 额外随机抖动上限 (秒)，在最小间隔之上再叠加 0~JITTER 的随机等待
RATE_JITTER       = float(os.getenv("ATTACK_RATE_JITTER", "0") or "0")
# 跨 solver 共享限速：在远端 Kali 上用 flock 协调所有 solver 的攻击命令 (需要 RATE_MIN_INTERVAL>0)
RATE_SHARED       = os.getenv("ATTACK_RATE_SHARED", "").strip().lower() in ("1", "true", "yes", "on")
# 远端 Kali 上共享节流状态文件 (所有 solver 的 MCP 都写它)
REMOTE_PACE_LOCK  = "/tmp/tch_attack_pace.lock"
REMOTE_PACE_AT    = "/tmp/tch_attack_pace.at"
# 代理出口池：逗号分隔，如 "socks5://127.0.0.1:1080,http://10.0.0.2:8080"
ATTACK_PROXY_POOL = [p.strip() for p in os.getenv("ATTACK_PROXY_POOL", "").split(",") if p.strip()]

# 封禁/拦截特征 (命中即在返回里提示)
_BAN_PATTERNS = re.compile(
    r"(403\s+forbidden|429\s+too\s+many|rate.?limit|blocked by|access denied|"
    r"cloudflare|captcha|verify you are human|请稍后再试|访问频繁|forbidden by administrative rules|"
    r"web application firewall|waf|banned|black.?list|不允许访问)",
    re.IGNORECASE,
)

# 限速状态 (本 MCP 进程内)
_rate_lock = asyncio.Lock()
_last_cmd_at = 0.0
# 连续超时/封禁计数，用于升级提示 (进程内)
_consecutive_block = 0
# 代理出口轮转游标
_proxy_cursor = 0


async def _rate_gate() -> None:
    """进程内限速闸门：保证本 MCP 进程相邻两条命令之间至少间隔 RATE_MIN_INTERVAL(+抖动)。
    注意：这只覆盖单个 MCP 进程；跨 solver 的共享节流由 _shared_pace_prefix() 在远端 Kali 上完成。"""
    if RATE_MIN_INTERVAL <= 0 and RATE_JITTER <= 0:
        return
    global _last_cmd_at
    async with _rate_lock:
        now = time.monotonic()
        wait = (RATE_MIN_INTERVAL - (now - _last_cmd_at))
        if RATE_JITTER > 0:
            wait += random.uniform(0, RATE_JITTER)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_cmd_at = time.monotonic()


def _shared_pace_prefix() -> str:
    """返回一段 shell 前缀，在远端 Kali 上用 flock 做「跨 solver」节流：
    读共享时间戳文件，若距上次攻击命令不足 RATE_MIN_INTERVAL(+抖动) 秒则 sleep 补足，然后写回。
    所有 solver 的 MCP 都 SSH 进同一台 Kali，因此这个文件锁能跨进程协调实际出口 QPS。
    仅在 RATE_SHARED 且 RATE_MIN_INTERVAL>0 时生效；否则返回空串（零行为变化）。
    依赖：flock (util-linux)、awk —— Kali 默认都有。"""
    if not (RATE_SHARED and RATE_MIN_INTERVAL > 0):
        return ""
    jitter_max = max(RATE_JITTER, 0)
    # flock 独占锁 → 读上次时间戳 → awk 算需要等待多久（含随机抖动）→ sleep → 写回 now。
    # 用子 shell + fd 200 持有锁，保证「读-等-写」原子，避免并发窗口。
    return (
        f"( flock -w 60 200 || true; "
        f"__now=$(date +%s.%N); "
        f"__last=$(cat {REMOTE_PACE_AT} 2>/dev/null || echo 0); "
        f"__w=$(awk -v n=\"$__now\" -v l=\"$__last\" -v m={RATE_MIN_INTERVAL} -v j={jitter_max} "
        f"'BEGIN{{srand(); d=m-(n-l); r=(j>0?rand()*j:0); t=d+r; if(t<0)t=0; if(t>120)t=120; printf \"%.3f\", t}}'); "
        f"if awk -v w=\"$__w\" 'BEGIN{{exit !(w>0)}}'; then sleep \"$__w\"; fi; "
        f"date +%s.%N > {REMOTE_PACE_AT}; "
        f") 200>{REMOTE_PACE_LOCK}; "
    )


def _next_proxy() -> str:
    """轮转取下一个出口代理；池为空返回空串。"""
    global _proxy_cursor
    if not ATTACK_PROXY_POOL:
        return ""
    proxy = ATTACK_PROXY_POOL[_proxy_cursor % len(ATTACK_PROXY_POOL)]
    _proxy_cursor += 1
    return proxy


def _detect_ban(text: str, timed_out: bool) -> str:
    """检查输出是否含封禁信号，返回要挂在结果前的横幅 (无则空串)。"""
    global _consecutive_block
    hit = bool(_BAN_PATTERNS.search(text or ""))
    if hit or timed_out:
        _consecutive_block += 1
    else:
        _consecutive_block = 0
    if not (hit or (timed_out and _consecutive_block >= 3)):
        return ""
    tips = [
        "[ANTI-BAN WARN] 检测到可能的封禁/限速信号"
        + ("（WAF/验证码/403/429）" if hit else "（连续超时，疑似源 IP 被封）")
        + f"，连续命中 {_consecutive_block} 次。",
        "建议：① 降速——设置更大的 ATTACK_RATE_MIN_INTERVAL / ATTACK_RATE_JITTER，或给扫描器加 --rate/--delay；",
        "     ② 换出口——配置 ATTACK_PROXY_POOL 后对支持代理的命令用 proxychains；",
        "     ③ 减小并发、缩小字典、改用被动侦察 (gau/waybackurls/被动指纹) 暂避主动流量。",
    ]
    if ATTACK_PROXY_POOL:
        tips.append(f"     当前代理池 {len(ATTACK_PROXY_POOL)} 个出口，下一个：{ATTACK_PROXY_POOL[_proxy_cursor % len(ATTACK_PROXY_POOL)]}")
    return "\n".join(tips) + "\n"

# ═══════════════════════════════════════════════════════════════
# FastMCP 服务器
# ═══════════════════════════════════════════════════════════════
mcp = FastMCP("ssh_pentest")

# ═══════════════════════════════════════════════════════════════
# SSH 连接管理 — 异步单例 + 自动重连 + 多主机支持
#
# 核心优势: asyncssh 单连接内部通过 SSH channel 多路复用,
# 一条 TCP 连接可同时跑 N 条命令, 不需要连接池!
# ═══════════════════════════════════════════════════════════════
_conns: dict[str, asyncssh.SSHClientConnection] = {}
_locks: dict[str, asyncio.Lock] = {}
_global_lock = asyncio.Lock()

# Cached session is dead — drop from pool and retry once (keep-alive MCP processes).
_RECONNECT_ERRORS = (
    asyncssh.DisconnectError,
    asyncssh.ChannelOpenError,
    asyncssh.ConnectionLost,
    BrokenPipeError,
    ConnectionError,
    OSError,
)


def _drop_conn(k: str) -> None:
    conn = _conns.pop(k, None)
    if conn is None:
        return
    try:
        conn.close()
    except Exception:
        pass


def _key(host: str, port: int, username: str) -> str:
    return f"{username}@{host}:{port}"


async def _get_lock(key: str) -> asyncio.Lock:
    """每个连接独立锁, 避免不同主机互相阻塞"""
    async with _global_lock:
        if key not in _locks:
            _locks[key] = asyncio.Lock()
        return _locks[key]


async def _connect(
    host: str = "", port: int = 0,
    username: str = "", password: str = "",
) -> asyncssh.SSHClientConnection:
    """获取或创建 SSH 连接 — 自动重连, 通道复用"""
    h  = host     or DEFAULT_SSH["host"]
    p  = port     or DEFAULT_SSH["port"]
    u  = username or DEFAULT_SSH["username"]
    pw = password or DEFAULT_SSH["password"]
    k  = _key(h, p, u)

    lock = await _get_lock(k)
    async with lock:
        conn = _conns.get(k)

        # 不做主动探活 — _run / SFTP 在 ChannelOpenError 等断线异常时 _drop_conn 后重试
        if conn is None:
            conn = await asyncio.wait_for(
                asyncssh.connect(
                    h, port=p, username=u, password=pw,
                    known_hosts=None,
                    keepalive_interval=KEEPALIVE,
                    connect_timeout=CONNECT_TIMEOUT,
                ),
                timeout=CONNECT_TIMEOUT + 5,
            )
            _conns[k] = conn

    return conn


async def _run_alias(alias: str, command: str, timeout: int = CMD_TIMEOUT, exec_command: Optional[str] = None) -> str:
    """通过本地 ssh 命令执行 — 支持 SSH config / ProxyCommand / cloudflared 隧道。
    exec_command: 实际发到远端执行的命令 (可能含限速前缀)；command 仅用于回显。"""
    to_exec = exec_command if exec_command is not None else command
    try:
        proc = await asyncio.create_subprocess_exec(
            "ssh", "-o", "StrictHostKeyChecking=no",
            "-o", f"ConnectTimeout={CONNECT_TIMEOUT}",
            alias, to_exec,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )
        except asyncio.TimeoutError:
            proc.kill()
            return _detect_ban("", timed_out=True) + f"[TIMEOUT] 命令超过 {timeout}s, 已中断"

        out = (stdout.decode("utf-8", errors="replace") or "")[:MAX_OUTPUT]
        err = (stderr.decode("utf-8", errors="replace") or "")[:MAX_OUTPUT // 2]

        text = f"[SSH {alias}] $ {command}\nExit: {proc.returncode}\n"
        if out:
            text += f"--- STDOUT ---\n{out}\n"
        if err:
            text += f"--- STDERR ---\n{err}\n"
        return _detect_ban(out + "\n" + err, timed_out=False) + text

    except Exception as e:
        return f"[ERROR] {type(e).__name__}: {e}"


async def _run(
    command: str, timeout: int = CMD_TIMEOUT,
    host: str = "", port: int = 0,
    username: str = "", password: str = "",
    paced: bool = False,
) -> str:
    """执行 SSH 命令 — 断线自动重连1次, 输出截断保护。
    paced=True 时（仅对真正打目标的攻击命令用）额外套上远端 flock 共享节流前缀，
    使多个 solver 的 MCP 进程对同一 Kali 出口协调 QPS；内部管道命令(poll/会话/传输)不 paced。"""
    # 进程内限速闸门 (low-and-slow)，仅在配置了间隔/抖动时生效
    await _rate_gate()

    # 跨 solver 共享节流：仅对攻击命令、且开启 RATE_SHARED 时，在远端加 flock 前缀
    exec_command = command
    if paced:
        prefix = _shared_pace_prefix()
        if prefix:
            exec_command = prefix + command

    # SSH 别名模式: 优先使用本地 ssh 命令
    alias = SSH_ALIAS
    if alias and not host and not port and not username and not password:
        return await _run_alias(alias, command, timeout, exec_command=exec_command)

    h = host     or DEFAULT_SSH["host"]
    p = port     or DEFAULT_SSH["port"]
    u = username or DEFAULT_SSH["username"]
    k = _key(h, p, u)

    for attempt in range(2):
        try:
            conn = await _connect(host, port, username, password)
            result = await asyncio.wait_for(
                conn.run(exec_command, check=False),
                timeout=timeout,
            )

            out = (result.stdout or "")[:MAX_OUTPUT]
            err = (result.stderr or "")[:MAX_OUTPUT // 2]

            text = f"[SSH {k}] $ {command}\nExit: {result.exit_status}\n"
            if out:
                text += f"--- STDOUT ---\n{out}\n"
            if err:
                text += f"--- STDERR ---\n{err}\n"
            return _detect_ban(out + "\n" + err, timed_out=False) + text

        except asyncio.TimeoutError:
            return _detect_ban("", timed_out=True) + f"[TIMEOUT] 命令超过 {timeout}s, 已中断"

        except _RECONNECT_ERRORS:
            _drop_conn(k)
            if attempt == 0:
                continue  # 自动重连一次
            return f"[SSH ERROR] 连接 {k} 失败, 请检查网络"

        except Exception as e:
            return f"[ERROR] {type(e).__name__}: {e}"

    return "[ERROR] 未知错误"


# ████████████████████████████████████████████████████████████████
#  MCP 工具 — 全部 async def, 永不阻塞 Windsurf 事件循环
# ████████████████████████████████████████████████████████████████

@mcp.tool()
async def ssh_execute(
    command: str,
    host: str = "",
    port: int = 0,
    username: str = "",
    password: str = "",
    timeout: int = 300,
) -> str:
    """在 Kali Linux 上执行任意命令。这是核心工具，可直接调用 Kali 上所有渗透测试工具。
    默认连接已配置的 Kali 服务器，也可指定其他主机。

    Kali 已安装的工具 (直接构造命令调用即可):

    [侦察/OSINT]
      subfinder -d target.com -silent          # 子域名枚举
      amass enum -passive -d target.com        # 深度子域名
      dig target.com ANY                       # DNS 查询
      whois target.com                         # WHOIS
      theHarvester -d target.com -b all        # OSINT 信息收集
      dnsrecon -d target.com                   # DNS 侦察

    [扫描/枚举]
      nmap -sV -T4 target                      # 端口+服务扫描
      nmap -sV --script vuln target            # 漏洞脚本扫描
      masscan target -p1-65535 --rate=5000     # 高速端口扫描
      whatweb -a 3 http://target               # 技术栈识别
      wafw00f http://target                    # WAF 检测
      testssl target.com                       # SSL/TLS 分析
      sslyze target.com                        # SSL 快速扫描

    [Web 扫描]
      nuclei -u http://target -silent          # 模板漏洞扫描
      nikto -h http://target                   # Web 服务器扫描
      wpscan --url http://target               # WordPress 扫描
      joomscan -u http://target                # Joomla 扫描
      cmseek -u http://target --batch          # CMS 检测

    [目录/API 发现]
      gobuster dir -u http://target -w /usr/share/wordlists/dirb/common.txt
      dirsearch -u http://target -e php,html
      feroxbuster -u http://target -w wordlist
      ffuf -u http://target/FUZZ -w wordlist   # 高速 Fuzz
      arjun -u http://target/api               # API 参数发现

    [URL/参数收集] (PATH=$PATH:~/go/bin)
      httpx -u target -td -sc -title -server   # HTTP 探测
      katana -u http://target -jc -silent      # JS 爬虫
      echo target.com | gau                    # 历史 URL
      echo target.com | waybackurls            # Wayback URL
      paramspider -d target.com                # 历史参数

    [漏洞利用]
      sqlmap -u 'http://target?id=1' --batch   # SQL 注入
      commix -u 'http://target?cmd=id' --batch # 命令注入
      xsstrike -u 'http://target?q=test'       # XSS 检测
      dalfox url 'http://target?q=test'        # XSS (Go 高速)
      crlfuzz -u 'http://target'               # CRLF 注入
      searchsploit apache 2.4                  # Exploit-DB 搜索
      msfconsole -q -x 'use ...; set ...; run' # Metasploit
      msfvenom -p payload LHOST=ip -f format   # Payload 生成

    [密码攻击]
      hydra -l user -P wordlist target ssh     # 在线爆破
      john hashfile --wordlist=wordlist        # 离线破解
      hashcat -m 0 hashfile wordlist           # GPU 破解

    [JWT/认证]
      python3 /opt/jwt_tool/jwt_tool.py 'token'     # JWT 解码
      python3 /opt/jwt_tool/jwt_tool.py 'token' -M pb  # JWT 漏洞扫描

    [流量/代理]
      curl -s -I http://target                 # HTTP 请求
      mitmdump -p 8888 -w /tmp/cap.flow        # 流量捕获

    [后渗透]
      crackmapexec smb target                  # 内网扫描
      enum4linux target                        # SMB/NetBIOS

    [通用字典路径]
      /usr/share/wordlists/rockyou.txt
      /usr/share/wordlists/dirb/common.txt
      /usr/share/seclists/Discovery/Web-Content/

    注意: Go 工具需要 export PATH=$PATH:~/go/bin

    Args:
        command: 要执行的 shell 命令
        host: SSH 主机地址
        port: SSH 端口
        username: SSH 用户名
        password: SSH 密码
        timeout: 命令超时时间(秒)，长时间任务请调大
    """
    # 一次性攻击命令：套跨 solver 共享节流 (paced)，避免并发 solver 出口 QPS 叠加。
    return await _run(command, timeout, host, port, username, password, paced=True)


def _proxy_to_proxychains_line(proxy: str) -> Optional[str]:
    """把 socks5://host:port / http://host:port 解析成 proxychains 的 '<proto> <host> <port>' 行。"""
    m = re.match(r"^\s*(socks5|socks4|http|https)://([^:/]+):(\d+)\s*$", proxy, re.IGNORECASE)
    if not m:
        return None
    proto = m.group(1).lower()
    if proto == "https":
        proto = "http"
    return f"{proto} {m.group(2)} {m.group(3)}"


def _wrap_with_proxychains(command: str, proxy: str) -> Optional[str]:
    """把命令包成「用临时 proxychains 配置经指定出口执行」的 shell 片段。
    返回 None 表示代理格式无法解析。proxychains4 缺失时片段自身会打印安装提示并 exit 127。"""
    line = _proxy_to_proxychains_line(proxy)
    if not line:
        return None
    conf_body = f"strict_chain\nquiet_mode\nproxy_dns\n[ProxyList]\n{line}\n"
    conf_b64 = base64.b64encode(conf_body.encode()).decode()
    return (
        f"if ! command -v proxychains4 >/dev/null 2>&1; then "
        f"echo '[ANTI-BAN] proxychains4 未安装，请先: apt-get install -y proxychains4'; exit 127; fi; "
        f"CONF=$(mktemp); echo {conf_b64} | base64 -d > \"$CONF\"; "
        f"proxychains4 -q -f \"$CONF\" bash -lc {_shellesc(command)}; RC=$?; rm -f \"$CONF\"; exit $RC"
    )


@mcp.tool()
async def ssh_execute_proxied(
    command: str,
    host: str = "",
    port: int = 0,
    username: str = "",
    password: str = "",
    timeout: int = 300,
) -> str:
    """与 ssh_execute 相同，但把命令通过 proxychains 走 ATTACK_PROXY_POOL 里的下一个出口代理执行——
    用于源 IP 被目标 WAF/防火墙封禁后轮换出口，或对高防目标做出口分散。

    前提：
      - 控制台已配置 ATTACK_PROXY_POOL（socks5://ip:port 或 http://ip:port，逗号分隔）。
      - 远程 Kali 已安装 proxychains4（未装时会提示，用 ssh_execute 装：apt-get install -y proxychains4）。
    行为：每次调用自动轮转到池里的下一个出口；未配置代理池时回退为普通 ssh_execute（并提示）。
    注意：并非所有工具都兼容 proxychains（原始套接字/ICMP 类如 masscan、nmap -sS 不走；用 nmap -sT 全连接扫描代替）。

    Args:
        command: 要执行的 shell 命令（不需自己加 proxychains 前缀）
        host/port/username/password: 可选 SSH 目标
        timeout: 命令超时时间(秒)
    """
    proxy = _next_proxy()
    if not proxy:
        return "[ANTI-BAN] 未配置 ATTACK_PROXY_POOL，无出口可轮换；已回退普通执行。\n" + await _run(
            command, timeout, host, port, username, password, paced=True
        )
    wrapped = _wrap_with_proxychains(command, proxy)
    if wrapped is None:
        return f"[ERROR] 代理格式无法解析: {proxy!r}，应为 socks5://ip:port 或 http://ip:port"
    header = f"[ANTI-BAN] 出口代理 → {proxy}\n"
    return header + await _run(wrapped, timeout, host, port, username, password, paced=True)


@mcp.tool()
async def anti_ban_status() -> str:
    """查看抗封禁/限速当前配置与状态：限速间隔、抖动、代理池、连续封禁计数。"""
    shared_state = "开 (跨 solver flock 协调)" if (RATE_SHARED and RATE_MIN_INTERVAL > 0) else (
        "配了 ATTACK_RATE_SHARED 但 RATE_MIN_INTERVAL=0，未生效" if RATE_SHARED else "关 (仅本进程限速)"
    )
    lines = [
        "抗封禁 / 限速状态:",
        f"  最小命令间隔 ATTACK_RATE_MIN_INTERVAL = {RATE_MIN_INTERVAL}s",
        f"  随机抖动上限 ATTACK_RATE_JITTER       = {RATE_JITTER}s",
        f"  跨 solver 共享节流 ATTACK_RATE_SHARED = {shared_state}",
        f"  代理出口池 ATTACK_PROXY_POOL          = {len(ATTACK_PROXY_POOL)} 个 " + (str(ATTACK_PROXY_POOL) if ATTACK_PROXY_POOL else "(未配置)"),
        f"  连续封禁/超时计数 consecutive_block   = {_consecutive_block}",
    ]
    if ATTACK_PROXY_POOL:
        lines.append(f"  下一个出口 = {ATTACK_PROXY_POOL[_proxy_cursor % len(ATTACK_PROXY_POOL)]}")
    if RATE_MIN_INTERVAL <= 0 and RATE_JITTER <= 0:
        lines.append("  提示: 当前未限速。打高防目标建议设 ATTACK_RATE_MIN_INTERVAL=2~5、ATTACK_RATE_JITTER=1~3 走 low-and-slow；")
        lines.append("        多个 solver 并发打同一目标时再加 ATTACK_RATE_SHARED=1，让出口 QPS 跨 solver 协调不叠加。")
    return "\n".join(lines)


@mcp.tool()
async def ssh_upload(
    local_path: str,
    remote_path: str,
    host: str = "",
    port: int = 0,
    username: str = "",
    password: str = "",
) -> str:
    """通过 SFTP 上传文件到远程服务器 (默认上传到 Kali)。

    Args:
        local_path: 本地文件路径 (Windows)
        remote_path: 远程目标路径
        host: SSH 主机地址
        port: SSH 端口
        username: SSH 用户名
        password: SSH 密码
    """
    alias = SSH_ALIAS
    if alias and not host and not port and not username and not password:
        try:
            proc = await asyncio.create_subprocess_exec(
                "scp", "-o", "StrictHostKeyChecking=no",
                local_path, f"{alias}:{remote_path}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=CMD_TIMEOUT)
            if proc.returncode == 0:
                return f"[OK] 已上传: {local_path} → {remote_path}"
            return f"[ERROR] 上传失败, exit: {proc.returncode}"
        except Exception as e:
            return f"[ERROR] 上传失败: {e}"

    h = host     or DEFAULT_SSH["host"]
    p = port     or DEFAULT_SSH["port"]
    u = username or DEFAULT_SSH["username"]
    k = _key(h, p, u)
    for attempt in range(2):
        try:
            conn = await _connect(host, port, username, password)
            async with conn.start_sftp_client() as sftp:
                await sftp.put(local_path, remote_path)
            return f"[OK] 已上传: {local_path} → {remote_path}"
        except _RECONNECT_ERRORS:
            _drop_conn(k)
            if attempt == 0:
                continue
            return f"[SSH ERROR] 连接 {k} 失败, 请检查网络"
        except Exception as e:
            return f"[ERROR] 上传失败: {e}"
    return "[ERROR] 上传失败: 未知错误"


@mcp.tool()
async def ssh_download(
    remote_path: str,
    local_path: str,
    host: str = "",
    port: int = 0,
    username: str = "",
    password: str = "",
) -> str:
    """通过 SFTP 从远程服务器下载文件到本地 (默认从 Kali 下载)。

    Args:
        remote_path: 远程文件路径
        local_path: 本地保存路径 (Windows)
        host: SSH 主机地址
        port: SSH 端口
        username: SSH 用户名
        password: SSH 密码
    """
    alias = SSH_ALIAS
    if alias and not host and not port and not username and not password:
        try:
            proc = await asyncio.create_subprocess_exec(
                "scp", "-o", "StrictHostKeyChecking=no",
                f"{alias}:{remote_path}", local_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=CMD_TIMEOUT)
            if proc.returncode == 0:
                return f"[OK] 已下载: {remote_path} → {local_path}"
            return f"[ERROR] 下载失败, exit: {proc.returncode}"
        except Exception as e:
            return f"[ERROR] 下载失败: {e}"

    h = host     or DEFAULT_SSH["host"]
    p = port     or DEFAULT_SSH["port"]
    u = username or DEFAULT_SSH["username"]
    k = _key(h, p, u)
    for attempt in range(2):
        try:
            conn = await _connect(host, port, username, password)
            async with conn.start_sftp_client() as sftp:
                await sftp.get(remote_path, local_path)
            return f"[OK] 已下载: {remote_path} → {local_path}"
        except _RECONNECT_ERRORS:
            _drop_conn(k)
            if attempt == 0:
                continue
            return f"[SSH ERROR] 连接 {k} 失败, 请检查网络"
        except Exception as e:
            return f"[ERROR] 下载失败: {e}"
    return "[ERROR] 下载失败: 未知错误"


@mcp.tool()
async def ssh_list_connections() -> str:
    """列出所有活跃的 SSH 连接"""
    if not _conns:
        return "无活跃 SSH 连接"
    lines = ["活跃 SSH 连接:"]
    for k, conn in _conns.items():
        try:
            peer = conn.get_extra_info("peername")
            lines.append(f"  {k} → {peer[0]}:{peer[1]}")
        except Exception:
            lines.append(f"  {k} → 状态未知")
    return "\n".join(lines)


@mcp.tool()
async def ssh_disconnect(
    host: str = "",
    port: int = 0,
    username: str = "",
) -> str:
    """断开指定的 SSH 连接。如果不指定参数则断开所有连接。

    Args:
        host: SSH 主机地址
        port: SSH 端口
        username: SSH 用户名
    """
    if host and port and username:
        k = _key(host, port, username)
        conn = _conns.pop(k, None)
        if conn:
            conn.close()
            return f"已断开 {k}"
        return f"{k} 不存在"

    count = len(_conns)
    for conn in _conns.values():
        conn.close()
    _conns.clear()
    return f"已断开全部 {count} 个连接"


# ═══════════════════════════════════════════════════════════════
# 后台任务系统 — 长任务 (>30s) 的设计
#
# 核心机制 (远端 Kali 侧):
#   每个 job 一个目录: $REMOTE_JOB_ROOT/<name>/
#     cmd          原始命令
#     pid          进程 PID
#     started_at   ISO 时间戳
#     stdout       实时输出
#     stderr       实时错误
#     exitcode     完成后写入 (存在 = 已完成)
#
# 启动方式: setsid nohup bash -c '...; echo $? > exitcode' < /dev/null > stdout 2> stderr &
#   setsid: 脱离 SSH controlling terminal, 防止断连导致 SIGHUP
#   nohup:  双保险
#   &:      后台
# ═══════════════════════════════════════════════════════════════

def _job_namespace() -> str:
    """
    后台 job 的命名空间隔离 —— 防止多个 solver 并发时 job 名在 Kali 全局目录里撞车。

    优先级：
      1) 显式 SSH_MCP_JOB_NS 环境变量（手动指定）。
      2) BreachWeave solver 进程会把 TCH_SOLVER_WORKSPACE（含唯一 solverId 路径段）
         和 TCH_CHALLENGE_ID 透传给本 MCP 子进程（MCP adapter 拷贝父进程 env）。
         取 workspace 末段 solverId（最细粒度，单 solver 唯一）；退而取 challengeId。
      3) 都没有 → 空命名空间（单 agent 场景，回退到原 /tmp/ssh_mcp_jobs）。
    """
    explicit = os.getenv("SSH_MCP_JOB_NS", "").strip()
    if explicit:
        ns = explicit
    else:
        # workspace 形如 {SOLVERS_DIR}/{solverId}/workspace —— 取 solverId（倒数第二段），
        # 末段是字面 "workspace" 没有区分度。退而取 challengeId。
        ws = os.getenv("TCH_SOLVER_WORKSPACE", "").strip().rstrip("/")
        segs = [s for s in ws.split("/") if s]
        solver_id = ""
        if len(segs) >= 2 and segs[-1] == "workspace":
            solver_id = segs[-2]
        elif segs:
            solver_id = segs[-1]
        ns = solver_id or os.getenv("TCH_CHALLENGE_ID", "").strip()
    # 只保留文件名安全字符，避免路径穿越/注入；纯点名（. / .. / …）一律丢弃。
    ns = "".join(c for c in ns if c.isalnum() or c in "_-.")
    if set(ns) <= {"."}:
        ns = ""
    return ns


_JOB_NS = _job_namespace()
REMOTE_JOB_ROOT = f"/tmp/ssh_mcp_jobs/{_JOB_NS}" if _JOB_NS else "/tmp/ssh_mcp_jobs"


def _shellesc(s: str) -> str:
    """单引号转义, 用于嵌套到 bash -c '...' 内"""
    return "'" + s.replace("'", "'\\''") + "'"


@mcp.tool()
async def ssh_exec_bg(
    cmd: str,
    name: str,
    host: str = "",
    port: int = 0,
    username: str = "",
    password: str = "",
    proxied: bool = False,
) -> str:
    """启动一个后台任务 — 适用于 nmap/gobuster/feroxbuster/afl/linpeas 等长时间命令。

    与 ssh_execute 区别:
      - ssh_execute: 同步, 必须等命令返回, 默认 30s 超时
      - ssh_exec_bg: 立即返回, 命令在 Kali 上以 setsid+nohup 后台跑, 不受 SSH 断连影响

    用法:
      ssh_exec_bg(cmd="nmap -A -p- target.com -oN /tmp/nmap.txt",
                  name="proj1__target.com__nmap-full")
      → 立即返回 job_id
      → 之后用 ssh_job_poll(name) 查进度
      → 完成后 ssh_job_poll 会显示 exitcode + stdout 路径

    name 命名规范 (skill 约定): <slug>__<asset>__<op>
      - slug: 项目代号
      - asset: 目标主机或域名
      - op: 操作类型 (如 nmap-syn, gobuster-vhost, fuzz-parser)
      session 启动时用 ssh_job_list | grep ^<slug>__ 拾取 orphan job

    抗封禁：
      - proxied=True 时，后台扫描本身经 ATTACK_PROXY_POOL 的下一个出口代理（proxychains）执行，
        源 IP 被封后仍可继续长扫描；未配代理池则回退直连并提示。
      - 后台扫描是「一条长命令」，用 --rate/--scan-delay/-rl 等工具自带节流参数控速最有效
        （详见 waf-evasion 技能）；ssh_job_poll 会对扫描输出做封禁检测并挂 [ANTI-BAN WARN]。

    Args:
        cmd: 要后台执行的 shell 命令
        name: 任务唯一标识, 用 a-zA-Z0-9_- 字符
        host/port/username/password: 可选 SSH 目标
        proxied: True = 后台扫描经出口代理执行 (需 ATTACK_PROXY_POOL + 远端 proxychains4)
    """
    if not name or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-." for c in name):
        return f"[ERROR] name 只能包含 a-z A-Z 0-9 _ - .,得到: {name!r}"

    proxy_header = ""
    run_cmd = cmd
    if proxied:
        proxy = _next_proxy()
        if not proxy:
            proxy_header = "[ANTI-BAN] 未配置 ATTACK_PROXY_POOL，无出口可轮换；后台任务直连执行。\n"
        else:
            wrapped = _wrap_with_proxychains(cmd, proxy)
            if wrapped is None:
                return f"[ERROR] 代理格式无法解析: {proxy!r}，应为 socks5://ip:port 或 http://ip:port"
            run_cmd = wrapped
            proxy_header = f"[ANTI-BAN] 后台任务出口代理 → {proxy}\n"

    job_dir = f"{REMOTE_JOB_ROOT}/{name}"
    cmd_esc = _shellesc(cmd)          # 元信息里存原始命令 (可读)
    run_esc = _shellesc(f"( {run_cmd} ) > stdout 2> stderr; echo $? > exitcode")

    # 一气呵成: 创建目录 → 写元信息 → setsid+nohup 后台跑 → 立刻返回 PID
    # 注意: cmd 文件用 printf '%s\n' 保证 trailing newline,
    # 否则 probe 时 cat cmd; echo __MARKER__ 会把 marker 吞进文件最后一行。
    # pid 和 exitcode 都用 echo (天然带 \n), 无需特殊处理。
    bootstrap = (
        f"mkdir -p {_shellesc(job_dir)} && "
        f"cd {_shellesc(job_dir)} && "
        f"printf '%s\\n' {cmd_esc} > cmd && "
        f"date -u +%Y-%m-%dT%H:%M:%SZ > started_at && "
        f"rm -f exitcode stdout stderr pid && "
        f"( setsid nohup bash -c {run_esc} "
        f"< /dev/null > /dev/null 2>&1 & echo $! > pid ) && "
        f"sleep 0.2 && cat pid"
    )

    result = await _run(bootstrap, timeout=20, host=host, port=port, username=username, password=password)
    pid = ""
    for line in result.splitlines():
        line = line.strip()
        if line.isdigit():
            pid = line
            break
    if not pid:
        return proxy_header + f"[ERROR] 启动失败:\n{result}"
    return (
        proxy_header
        + f"[OK] 后台任务已启动\n"
        f"  name: {name}\n"
        f"  pid:  {pid}\n"
        f"  dir:  {job_dir}\n"
        f"  cmd:  {cmd}\n"
        f"用 ssh_job_poll(name=\"{name}\") 查进度。"
    )


@mcp.tool()
async def ssh_job_poll(
    name: str,
    tail_lines: int = 30,
    host: str = "",
    port: int = 0,
    username: str = "",
    password: str = "",
) -> str:
    """轮询一个后台任务的状态 — 显示是否完成, exitcode, 以及 stdout/stderr 末尾若干行。

    返回包含:
      - status: RUNNING | DONE | NOT_FOUND
      - pid, started_at
      - exitcode (DONE 时)
      - stdout 末尾 tail_lines 行
      - stderr 末尾 tail_lines 行
      - 完整文件路径 (供需要时 ssh_download)

    注意: 输出已截断到 tail_lines 行,不要把整个 stdout 拉进 context。
          要看完整结果用 ssh_download 或 ssh_execute 读返回里给出的 job_dir 下的 stdout。

    Args:
        name: ssh_exec_bg 启动时给的 name
        tail_lines: stdout/stderr 各取末尾多少行 (默认 30)
    """
    if not name:
        return "[ERROR] 必须提供 name"

    job_dir = f"{REMOTE_JOB_ROOT}/{name}"
    n = max(1, min(tail_lines, 500))

    # 一次拉齐所有元信息
    probe = (
        f"if [ ! -d {_shellesc(job_dir)} ]; then echo MISSING_DIR_MARKER; exit 0; fi; "
        f"cd {_shellesc(job_dir)} && "
        f"echo __PID__; cat pid 2>/dev/null; "
        f"echo __STARTED__; cat started_at 2>/dev/null; "
        f"echo __CMD__; cat cmd 2>/dev/null; "
        f"echo __EXITCODE__; cat exitcode 2>/dev/null; "
        f"echo __ALIVE__; "
        f"PID=$(cat pid 2>/dev/null); "
        f"if [ -n \"$PID\" ] && kill -0 \"$PID\" 2>/dev/null; then echo yes; else echo no; fi; "
        f"echo __STDOUT_TAIL__; tail -n {n} stdout 2>/dev/null; "
        f"echo __STDERR_TAIL__; tail -n {n} stderr 2>/dev/null; "
        f"echo __SIZES__; "
        f"wc -c stdout stderr 2>/dev/null"
    )

    raw = await _run(probe, timeout=15, host=host, port=port, username=username, password=password)

    # 只检查 STDOUT 段, 避免命令回显误触发 (sentinel 只在 echo 输出里出现, 不在命令文本里)
    stdout_section = ""
    if "--- STDOUT ---" in raw:
        stdout_section = raw.split("--- STDOUT ---", 1)[1].split("--- STDERR ---", 1)[0]
    if "MISSING_DIR_MARKER" in stdout_section:
        return f"[NOT_FOUND] 任务 {name} 不存在 (job_dir 缺失)"

    # 简易解析 — 只解析 STDOUT 段, 不要把命令回显的 __PID__ 字面量当 section 头
    sections: dict[str, list[str]] = {}
    cur = None
    for line in stdout_section.splitlines():
        s = line.strip()
        if s.startswith("__") and s.endswith("__"):
            cur = s.strip("_")
            sections[cur] = []
        elif cur:
            sections[cur].append(line)

    def get(key: str) -> str:
        return "\n".join(sections.get(key, [])).strip()

    pid = get("PID")
    started = get("STARTED")
    cmd = get("CMD")
    exitcode = get("EXITCODE")
    alive = get("ALIVE")
    stdout_tail = get("STDOUT_TAIL")
    stderr_tail = get("STDERR_TAIL")
    sizes = get("SIZES")

    if exitcode:
        status = f"DONE (exit={exitcode})"
    elif alive == "yes":
        status = "RUNNING"
    else:
        status = "DEAD (no exitcode, process gone — possibly killed)"

    out = [
        f"[{status}] {name}",
        f"  pid:        {pid or '?'}",
        f"  started:    {started or '?'}",
        f"  cmd:        {cmd or '?'}",
        f"  job_dir:    {job_dir}",
        f"  sizes:      {sizes or '?'}",
    ]
    if stdout_tail:
        out.append(f"--- STDOUT (tail {n}) ---\n{stdout_tail}")
    if stderr_tail:
        out.append(f"--- STDERR (tail {n}) ---\n{stderr_tail}")
    out.append(f"完整 stdout: ssh_execute(\"cat {job_dir}/stdout\") 或 ssh_download(\"{job_dir}/stdout\", ...)")
    body = "\n".join(out)
    # 后台长扫描的封禁检测：无状态扫描 tail（poll 会被反复调用，不能污染进程内的 consecutive 计数）。
    # 命中即在最前面挂横幅，提醒模型这条扫描正在被目标拦截（此前后台任务完全没有封禁可见性）。
    if _BAN_PATTERNS.search((stdout_tail or "") + "\n" + (stderr_tail or "")):
        body = (
            "[ANTI-BAN WARN] 后台任务输出里出现疑似封禁/限速信号（WAF/验证码/403/429）——"
            "这条扫描可能正被目标拦截，结果多为无效响应。\n"
            "建议：给该工具加自带限速参数（nmap --scan-delay / ffuf -rate / nuclei -rl）后重跑，"
            "或改用 ssh_exec_bg(..., proxied=True) 走出口代理；必要时缩小字典/降并发。详见 waf-evasion 技能。\n"
            + body
        )
    return body


@mcp.tool()
async def ssh_job_list(
    prefix: str = "",
    host: str = "",
    port: int = 0,
    username: str = "",
    password: str = "",
) -> str:
    """列出所有后台任务 (可按 name 前缀过滤,如 slug 名)。

    输出每行: <STATUS> <name> exit=<code> pid=<pid> started=<ts>

    典型用法 (skill bootstrap 时):
      ssh_job_list(prefix="myproj__")
      → 看上次 session 留下哪些 orphan job 还在跑或刚跑完

    Args:
        prefix: 仅列出 name 以此开头的任务 (默认全部)
    """
    cmd = (
        f"mkdir -p {_shellesc(REMOTE_JOB_ROOT)}; "
        f"cd {_shellesc(REMOTE_JOB_ROOT)} || exit 0; "
        f"for d in */; do "
        f"  d=${{d%/}}; "
    )
    if prefix:
        # only entries matching prefix
        cmd += f"  case \"$d\" in {_shellesc(prefix)}*) ;; *) continue ;; esac; "
    cmd += (
        f"  PID=$(cat \"$d/pid\" 2>/dev/null); "
        f"  EX=$(cat \"$d/exitcode\" 2>/dev/null); "
        f"  ST=$(cat \"$d/started_at\" 2>/dev/null); "
        f"  if [ -n \"$EX\" ]; then S=DONE; "
        f"  elif [ -n \"$PID\" ] && kill -0 \"$PID\" 2>/dev/null; then S=RUNNING; "
        f"  else S=DEAD; fi; "
        f"  printf '%-8s %-50s exit=%-5s pid=%-7s started=%s\\n' \"$S\" \"$d\" \"${{EX:-?}}\" \"${{PID:-?}}\" \"${{ST:-?}}\"; "
        f"done"
    )

    result = await _run(cmd, timeout=20, host=host, port=port, username=username, password=password)
    # 抽取 STDOUT 段
    if "--- STDOUT ---" in result:
        result = result.split("--- STDOUT ---", 1)[1].split("--- STDERR ---", 1)[0].strip()
    if not result:
        return f"[空] 无后台任务{(' (prefix=' + prefix + ')') if prefix else ''}"
    return result


@mcp.tool()
async def ssh_job_clean(
    name: str = "",
    only_done: bool = True,
    host: str = "",
    port: int = 0,
    username: str = "",
    password: str = "",
) -> str:
    """清理后台任务目录。

    Args:
        name: 指定要清理的 name; 留空 = 清理所有
        only_done: True (默认) = 只清理已完成的; False = 强制清理 (RUNNING 也删, 谨慎)
    """
    if name:
        if any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-." for c in name):
            return f"[ERROR] name 不合法"
        target = f"{REMOTE_JOB_ROOT}/{name}"
        if only_done:
            cmd = (
                f"if [ -f {_shellesc(target)}/exitcode ]; then "
                f"  rm -rf {_shellesc(target)} && echo cleaned; "
                f"else echo refused-still-running; fi"
            )
        else:
            cmd = f"rm -rf {_shellesc(target)} && echo cleaned"
    else:
        if only_done:
            cmd = (
                f"cd {_shellesc(REMOTE_JOB_ROOT)} 2>/dev/null || exit 0; "
                f"for d in */; do d=${{d%/}}; "
                f"  if [ -f \"$d/exitcode\" ]; then rm -rf \"$d\" && echo cleaned $d; fi; "
                f"done"
            )
        else:
            cmd = f"rm -rf {_shellesc(REMOTE_JOB_ROOT)}/* && echo cleaned-all"

    return await _run(cmd, timeout=30, host=host, port=port, username=username, password=password)


# ████████████████████████████████████████████████████████████████
#  交互式会话 / 反弹 shell —— 基于远端 Kali 的 tmux
#
#  痛点：ssh_execute 是一次性无状态执行，握不住交互式会话——
#    - meterpreter / msfconsole 交互
#    - 接反弹 shell 后在里面连续敲命令
#    - 需要应答提示符 (sudo 密码、交互式安装、ftp/telnet 会话)
#    - nc/socat 监听回连
#  解决：用远端 tmux 建持久 detached 会话，send-keys 发命令，capture-pane 读回显。
#    会话在 SSH 断连后依然存活 (tmux server 独立于 SSH)，跨轮次持续。
# ████████████████████████████████████████████████████████████████

_TMUX = "tmux"  # 远端需装 tmux (Kali 默认有；缺失时工具会提示 apt-get install -y tmux)


def _valid_name(name: str) -> bool:
    return bool(name) and all(c in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-." for c in name)


def _tmux_session(name: str) -> str:
    """会话名加命名空间前缀，避免多 solver 撞车。"""
    ns = _JOB_NS
    return f"tch_{ns}_{name}" if ns else f"tch_{name}"


@mcp.tool()
async def ssh_session_new(
    name: str,
    init_cmd: str = "",
    host: str = "",
    port: int = 0,
    username: str = "",
    password: str = "",
) -> str:
    """在远端 Kali 上新建一个持久交互式会话 (tmux)，用于 meterpreter/交互式利用/接反弹 shell 等需要保持状态的场景。

    与 ssh_execute / ssh_exec_bg 的区别：
      - ssh_execute: 一次性命令，无状态。
      - ssh_exec_bg: 后台任务，只能看 stdout，不能交互输入。
      - ssh_session_new: 建一个持久 shell，之后可用 ssh_session_send 连续发命令、ssh_session_read 读回显——真正的交互。

    用法示例（接反弹 shell）:
      1. ssh_session_new(name="rev", init_cmd="nc -lvnp 4444")   # 起监听
      2. （在目标上触发回连到 Kali:4444）
      3. ssh_session_read(name="rev")                            # 看是否连上
      4. ssh_session_send(name="rev", keys="id; uname -a")       # 在反弹 shell 里执行
      5. ssh_session_read(name="rev")                            # 读结果

    用法示例（msfconsole）:
      ssh_session_new(name="msf", init_cmd="msfconsole -q")
      ssh_session_send(name="msf", keys="use exploit/...; set RHOSTS x.x.x.x; run")
      ssh_session_read(name="msf", wait=8)

    Args:
        name: 会话唯一标识 (a-zA-Z0-9_-.)
        init_cmd: 建会话后立即执行的命令 (可留空，之后用 send 发)
        host/port/username/password: 可选 SSH 目标
    """
    if not _valid_name(name):
        return f"[ERROR] name 只能含 a-z A-Z 0-9 _ - .，得到: {name!r}"
    sess = _tmux_session(name)
    parts = [
        f"if ! command -v {_TMUX} >/dev/null 2>&1; then echo '[ERROR] tmux 未安装，请先: apt-get install -y tmux'; exit 127; fi",
        f"{_TMUX} has-session -t {_shellesc(sess)} 2>/dev/null && {{ echo '[EXISTS] 会话已存在: {name}'; exit 0; }}",
        f"{_TMUX} new-session -d -s {_shellesc(sess)} -x 200 -y 50",
    ]
    cmd = "; ".join(parts)
    result = await _run(cmd, timeout=20, host=host, port=port, username=username, password=password)
    if "[ERROR]" in result and "tmux 未安装" in result:
        return result
    if init_cmd.strip():
        send = f"{_TMUX} send-keys -t {_shellesc(sess)} {_shellesc(init_cmd)} Enter"
        await _run(send, timeout=15, host=host, port=port, username=username, password=password)
    return (
        f"[OK] 交互式会话已建立: {name} (tmux: {sess})\n"
        + (f"  已发送初始命令: {init_cmd}\n" if init_cmd.strip() else "")
        + f"  用 ssh_session_send(name=\"{name}\", keys=\"...\") 发命令，ssh_session_read(name=\"{name}\") 读回显。"
    )


@mcp.tool()
async def ssh_session_send(
    name: str,
    keys: str,
    enter: bool = True,
    read_after: bool = True,
    wait: float = 2.0,
    host: str = "",
    port: int = 0,
    username: str = "",
    password: str = "",
) -> str:
    """向交互式会话发送按键/命令。默认自动回车并在 wait 秒后读回显。

    Args:
        name: ssh_session_new 建的会话名
        keys: 要发送的文本/命令 (如 "id"、"set RHOSTS 10.0.0.5")；也可发控制键，见 enter
        enter: True(默认)在末尾追加回车执行；False 只输入不回车 (用于填交互提示)
        read_after: True(默认)发送后自动读一次回显
        wait: 发送后等待多少秒再读 (给命令产出时间，交互式利用可调大)
        host/port/username/password: 可选 SSH 目标
    """
    if not _valid_name(name):
        return f"[ERROR] name 不合法: {name!r}"
    sess = _tmux_session(name)
    send = f"{_TMUX} send-keys -t {_shellesc(sess)} {_shellesc(keys)}" + (" Enter" if enter else "")
    check = f"{_TMUX} has-session -t {_shellesc(sess)} 2>/dev/null || {{ echo '[NOT_FOUND] 会话不存在: {name}'; exit 0; }}; "
    result = await _run(check + send, timeout=15, host=host, port=port, username=username, password=password)
    if "[NOT_FOUND]" in result:
        return f"[NOT_FOUND] 会话不存在: {name}（先 ssh_session_new）"
    if not read_after:
        return f"[OK] 已发送到 {name}: {keys}"
    if wait > 0:
        await asyncio.sleep(min(max(wait, 0), 60))
    return await ssh_session_read(name=name, host=host, port=port, username=username, password=password)


@mcp.tool()
async def ssh_session_read(
    name: str,
    lines: int = 60,
    host: str = "",
    port: int = 0,
    username: str = "",
    password: str = "",
) -> str:
    """读交互式会话当前屏幕内容 (tmux capture-pane 末尾 lines 行)。

    Args:
        name: 会话名
        lines: 读末尾多少行 (默认 60)
    """
    if not _valid_name(name):
        return f"[ERROR] name 不合法: {name!r}"
    sess = _tmux_session(name)
    n = max(1, min(lines, 500))
    cmd = (
        f"{_TMUX} has-session -t {_shellesc(sess)} 2>/dev/null || {{ echo '[NOT_FOUND]'; exit 0; }}; "
        f"{_TMUX} capture-pane -p -t {_shellesc(sess)} -S -{n}"
    )
    result = await _run(cmd, timeout=15, host=host, port=port, username=username, password=password)
    body = result
    if "--- STDOUT ---" in result:
        body = result.split("--- STDOUT ---", 1)[1].split("--- STDERR ---", 1)[0]
    if "[NOT_FOUND]" in body:
        return f"[NOT_FOUND] 会话不存在: {name}"
    return f"[{name}] 屏幕 (末尾 {n} 行):\n{body.rstrip()}"


@mcp.tool()
async def ssh_session_list(
    host: str = "",
    port: int = 0,
    username: str = "",
    password: str = "",
) -> str:
    """列出本命名空间下所有交互式会话。"""
    ns = _JOB_NS
    prefix = f"tch_{ns}_" if ns else "tch_"
    cmd = (
        f"command -v {_TMUX} >/dev/null 2>&1 || {{ echo '[none] tmux 未安装'; exit 0; }}; "
        f"{_TMUX} list-sessions 2>/dev/null | grep -E '^{prefix}' || echo '[none] 无活跃会话'"
    )
    result = await _run(cmd, timeout=15, host=host, port=port, username=username, password=password)
    if "--- STDOUT ---" in result:
        result = result.split("--- STDOUT ---", 1)[1].split("--- STDERR ---", 1)[0].strip()
    return result or "[none] 无活跃会话"


@mcp.tool()
async def ssh_session_kill(
    name: str,
    host: str = "",
    port: int = 0,
    username: str = "",
    password: str = "",
) -> str:
    """结束一个交互式会话 (kill tmux session)。"""
    if not _valid_name(name):
        return f"[ERROR] name 不合法: {name!r}"
    sess = _tmux_session(name)
    cmd = f"{_TMUX} kill-session -t {_shellesc(sess)} 2>/dev/null && echo killed || echo '[NOT_FOUND]'"
    result = await _run(cmd, timeout=15, host=host, port=port, username=username, password=password)
    return f"已结束会话 {name}" if "killed" in result else f"[NOT_FOUND] 会话不存在: {name}"


@mcp.tool()
async def ssh_listener_start(
    name: str,
    lport: int,
    tool: str = "nc",
    host: str = "",
    port: int = 0,
    username: str = "",
    password: str = "",
) -> str:
    """在远端 Kali 上起一个反弹 shell 监听器 (放进 tmux 会话，回连后可直接交互)。

    这是"接 shell"的便捷封装：等价于 ssh_session_new + 在里面跑监听。回连建立后，
    用 ssh_session_send(name, "id") 在反弹 shell 里执行，ssh_session_read(name) 读结果。

    Args:
        name: 会话名 (回连后用它交互)
        lport: 监听端口 (确保 Kali 该端口对目标可达 / 已放行)
        tool: 监听工具，"nc"(默认) | "ncat" | "socat" | "pwncat"
        host/port/username/password: 可选 SSH 目标
    """
    if not _valid_name(name):
        return f"[ERROR] name 不合法: {name!r}"
    if not (0 < lport < 65536):
        return f"[ERROR] lport 非法: {lport}"
    listeners = {
        "nc": f"nc -lvnp {lport}",
        "ncat": f"ncat -lvnp {lport}",
        "socat": f"socat -d -d TCP-LISTEN:{lport},reuseaddr,fork STDOUT",
        "pwncat": f"pwncat-cs -lp {lport}",
    }
    listen_cmd = listeners.get(tool)
    if not listen_cmd:
        return f"[ERROR] 不支持的 tool: {tool!r}，可选 {list(listeners)}"
    created = await ssh_session_new(name=name, init_cmd=listen_cmd, host=host, port=port, username=username, password=password)
    if "[ERROR]" in created:
        return created
    return (
        created
        + f"\n[LISTENER] {tool} 正在监听 0.0.0.0:{lport}。目标回连后："
        + f"\n  ssh_session_read(name=\"{name}\") 确认连接；ssh_session_send(name=\"{name}\", keys=\"id\") 交互。"
    )


# ═══════════════════════════════════════════════════════════════
# 启动
# ═══════════════════════════════════════════════════════════════
if __name__ == "__main__":
    mcp.run(transport="stdio")
