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
import logging
import os
import sys
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


async def _run_alias(alias: str, command: str, timeout: int = CMD_TIMEOUT) -> str:
    """通过本地 ssh 命令执行 — 支持 SSH config / ProxyCommand / cloudflared 隧道"""
    try:
        proc = await asyncio.create_subprocess_exec(
            "ssh", "-o", "StrictHostKeyChecking=no",
            "-o", f"ConnectTimeout={CONNECT_TIMEOUT}",
            alias, command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )
        except asyncio.TimeoutError:
            proc.kill()
            return f"[TIMEOUT] 命令超过 {timeout}s, 已中断"

        out = (stdout.decode("utf-8", errors="replace") or "")[:MAX_OUTPUT]
        err = (stderr.decode("utf-8", errors="replace") or "")[:MAX_OUTPUT // 2]

        text = f"[SSH {alias}] $ {command}\nExit: {proc.returncode}\n"
        if out:
            text += f"--- STDOUT ---\n{out}\n"
        if err:
            text += f"--- STDERR ---\n{err}\n"
        return text

    except Exception as e:
        return f"[ERROR] {type(e).__name__}: {e}"


async def _run(
    command: str, timeout: int = CMD_TIMEOUT,
    host: str = "", port: int = 0,
    username: str = "", password: str = "",
) -> str:
    """执行 SSH 命令 — 断线自动重连1次, 输出截断保护"""
    # SSH 别名模式: 优先使用本地 ssh 命令
    alias = SSH_ALIAS
    if alias and not host and not port and not username and not password:
        return await _run_alias(alias, command, timeout)

    h = host     or DEFAULT_SSH["host"]
    p = port     or DEFAULT_SSH["port"]
    u = username or DEFAULT_SSH["username"]
    k = _key(h, p, u)

    for attempt in range(2):
        try:
            conn = await _connect(host, port, username, password)
            result = await asyncio.wait_for(
                conn.run(command, check=False),
                timeout=timeout,
            )

            out = (result.stdout or "")[:MAX_OUTPUT]
            err = (result.stderr or "")[:MAX_OUTPUT // 2]

            text = f"[SSH {k}] $ {command}\nExit: {result.exit_status}\n"
            if out:
                text += f"--- STDOUT ---\n{out}\n"
            if err:
                text += f"--- STDERR ---\n{err}\n"
            return text

        except asyncio.TimeoutError:
            return f"[TIMEOUT] 命令超过 {timeout}s, 已中断"

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
    return await _run(command, timeout, host, port, username, password)


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

    Args:
        cmd: 要后台执行的 shell 命令
        name: 任务唯一标识, 用 a-zA-Z0-9_- 字符
        host/port/username/password: 可选 SSH 目标
    """
    if not name or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-." for c in name):
        return f"[ERROR] name 只能包含 a-z A-Z 0-9 _ - .,得到: {name!r}"

    job_dir = f"{REMOTE_JOB_ROOT}/{name}"
    cmd_esc = _shellesc(cmd)

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
        f"( setsid nohup bash -c {_shellesc(f'( {cmd} ) > stdout 2> stderr; echo $? > exitcode')} "
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
        return f"[ERROR] 启动失败:\n{result}"
    return (
        f"[OK] 后台任务已启动\n"
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
    return "\n".join(out)


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


# ═══════════════════════════════════════════════════════════════
# 启动
# ═══════════════════════════════════════════════════════════════
if __name__ == "__main__":
    mcp.run(transport="stdio")
