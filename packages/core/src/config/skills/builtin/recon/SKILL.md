---
name: recon
description: Fast reconnaissance - discover assets, entry points, attack surface, and hypotheses
tags: [pentest, recon, discovery]
---

# Reconnaissance (Recon)

## Workflow
1. Read this engagement's targets (allowed_targets) and rules of engagement from the task context, and treat them as the inventory of recon subjects.
2. Establish a baseline for every reachable exposed surface: HTTP response headers, framework clues, visible flows, role model, and state transitions.
3. Map attacker-controllable inputs: forms, JSON fields, query parameters, headers, upload points, WebSocket messages, postMessage channels, GraphQL operations, and AI prompts or file inputs.
4. Map hidden surfaces: JS routes, legacy API versions, sibling endpoints, alternate methods, debug behaviors, internal identifiers, feature flags, and so on.
5. Contrast trust boundaries: differences between client-side and server-side checks, role transitions, workflow skips, object ownership, cache layers, redirects, and third-party integrations.
6. Turn observations into testable hypotheses. Each hypothesis must target one entry point, one likely vulnerability class, and one follow-up test.
7. Report coverage gaps and the reasons certain surfaces could not be observed.

## First-round modeling questions
- What is the true boundary: pure browser-side, pure backend, a hybrid app, or an auth flow?
- Where are sensitive results more likely to land: the browser, API responses, local files, database records, or internal services?
- Does the app trust user input in templates, redirects, file paths, headers, serialized objects, or background jobs?
- Are there divergences across multiple parsers or execution layers: proxy vs. app, URL parser vs. fetcher, filter vs. browser, serializer vs. validator?

## High-value surface checks
- Before guessing at APIs, read the HTML, inline scripts, and bundled JS first.
- Compare the fields the frontend submits against the fields the backend actually accepts; optional JSON fields, hidden parameters, and alternate content types often open hidden paths.
- Check obvious metadata or auxiliary paths early: `/robots.txt`, `/sitemap.xml`, `/.well-known/`, `/admin`, `/debug`, `/.git/`, `/.env`.
- Do discovery-level variant observation on valuable routes: swap the HTTP method, content type, and encoding, but stop short of exploitation validation.

## Entry classification
- During recon, try to first bucket a feature into one primary category: injection, authn/authz, parser differential, upload/parsing, proxy/boundary trust, state machine, or client-side execution.
- If a feature triggers multiple categories at once, still prefer writing it as a single entry, single primary hypothesis, and leave the remaining directions as a `coverage_gap` or follow-up candidate.

## Recon mindset
- Think from the angle of attack scenarios, but stop at the discovery phase.
- Focus on anomalies rather than volume: things like naming drift, error differentials, version differentials, missing siblings, unexpected parameters, and state contradictions.
- Treat every feature as a set of objects, roles, transitions, and side effects.
- Use failed test results to refine the model rather than repeating the same angle.
- Scope comes from the authorized target scope in the task context.

## Vulnerability coverage
When mapping a feature or when a surface hints at a vulnerability class, consult `references/vuln-class-matrix.md`.

Use it to answer three questions:
1. What signal should recon collect here?
2. What evidence should you save now?
3. How should the `next_test` for `targeted-pentest` be worded?

The matrix is discovery-oriented. Do not copy exploitation payloads, privilege-escalation chains, or report wording into the recon output.

## Hypothesis Discipline
- Make sure the `statement` is specific and falsifiable.
- Keep the `entry_point` fine-grained: a single path, route, mutation, file handler, or workflow step.
- Use a likely vulnerability class for `kind`, not a full exploit chain.
- Put mechanism details into `why_plausible`.
- Put the minimal confirmation action into `next_test`.
- If evidence is insufficient, lower the `confidence` rather than broadening the hypothesis scope.
- Keep `candidate_findings` as observations only; their status must remain `candidate`.

## Evidence Discipline
- Save reproducible requests, responses, screenshots, route maps, and code snippets under the `evidence/` directory.
- Record the role, account state, and preconditions used when observing each behavior.
- Distinguish confirmed assets from third-party observations.
- Note what was not observed: missing role comparisons, untested alternate methods, restricted states, or unavailable accounts.

## Recon Output Discipline
At the end of the recon phase, distill the following into the ideas / memory board (using the idea_add / memory tools) for reuse during later validation:
- **assets**: confirmed hosts, paths, endpoints, parameters, roles, or workflow nodes.
- **hypotheses**: write each as a concrete idea — including the entry point (`entry_point`), likely vulnerability class (`kind`), a falsifiable statement, a plausibility rationale, a minimal `next_test`, priority, and confidence.
- **candidate observations**: only evidence-backed observations, flagged as pending-validation candidates, not treated as confirmed findings.
- **evidence**: reference only traceable files or captured artifacts (under `evidence/`); avoid dumping plaintext into shared state.
- **coverage gaps**: specific unobserved surfaces or comparisons that drive the next round of recon.
