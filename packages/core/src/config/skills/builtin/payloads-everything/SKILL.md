---
name: payloads-all-the-things
description: Browse the bundled PayloadsAllTheThings corpus for CTF and web security payloads, bypasses, fuzz strings, exploit ideas, and methodology notes. Use when Agent needs to locate payloads by vulnerability category during CTFs, pentests, or challenge solving, then drill into the relevant README.md and markdown files under references/ instead of loading the whole corpus at once.
---

# PayloadsAllTheThings Local Navigator

Treat `references/` as a local read-only payload knowledge base.

Work in this order — don't load the entire corpus at once:

1. Scan top-level directories and narrow by vulnerability type.
2. In the target directory, read `README.md` first — it usually summarizes payloads, techniques, bypasses, tools, and lab setup for that category.
3. Then open specific `*.md`, `Intruder/`, `Images/`, `Configuration*`, `CVE*`, or other subdirectories.
4. Use `rg -n` only within the current category to search keywords — avoid repo-wide scans.
5. When citing payloads or techniques, include the source path for follow-up.

Preferred commands:

```bash
find references -maxdepth 1 -mindepth 1 -type d -exec basename {} \; | sort
sed -n '1,200p' 'references/SQL Injection/README.md'
find 'references/SQL Injection' -maxdepth 1 \( -type f -o -type d \) | sort
rg -n 'union|time based|auth bypass' 'references/SQL Injection'
sed -n '1,200p' 'references/Server Side Request Forgery/README.md'
rg -n 'gopher|metadata|redirect|localhost' 'references/Server Side Request Forgery'
find 'references/Upload Insecure Files' -maxdepth 1 \( -type f -o -type d \) | sort
```

Navigation constraints:

- Read `README.md` before deciding whether to open a child file.
- Directory names are the primary index — don't skip discovery and blind-search the whole tree.
- If the vuln type is unclear, start with `references/Methodology and Resources`.
- When several categories are close, read the two nearest `README.md` files and compare before going deep.

Top-level categories:

```text
API Key Leaks
Account Takeover
Brute Force Rate Limit
Business Logic Errors
CORS Misconfiguration
CRLF Injection
CSS Injection
CSV Injection
CVE Exploits
Clickjacking
Client Side Path Traversal
Command Injection
Cross-Site Request Forgery
DNS Rebinding
DOM Clobbering
Denial of Service
Dependency Confusion
Directory Traversal
Encoding Transformations
External Variable Modification
File Inclusion
Google Web Toolkit
GraphQL Injection
HTTP Parameter Pollution
Headless Browser
Hidden Parameters
Insecure Deserialization
Insecure Direct Object References
Insecure Management Interface
Insecure Randomness
Insecure Source Code Management
JSON Web Token
Java RMI
LDAP Injection
LaTeX Injection
Mass Assignment
Methodology and Resources
NoSQL Injection
OAuth Misconfiguration
ORM Leak
Open Redirect
Prompt Injection
Prototype Pollution
Race Condition
Regular Expression
Request Smuggling
Reverse Proxy Misconfigurations
SAML Injection
SQL Injection
Server Side Include Injection
Server Side Request Forgery
Server Side Template Injection
Tabnabbing
Type Juggling
Upload Insecure Files
Virtual Hosts
Web Cache Deception
Web Sockets
XPATH Injection
XS-Leak
XSLT Injection
XSS Injection
XXE Injection
Zip Slip
```
