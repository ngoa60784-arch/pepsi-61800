# Engagement Mode

Runtime mode for **authorized** penetration testing and red-team exercises (e.g. HVV, red-team assessments, live-range drills). Target sourcing, scope constraints, finding records, and completion determination are handled locally — **no remote scoring or flag platform required**.

> Engagement mode is the **only runtime**: `isEngagementMode()` defaults to true. The `challenge` subsystem (target orchestration / memory / ideas / findings / solver scheduling) is the shared operational foundation. Remote CTF scoring APIs and `mock-` target filters were removed.

## Core Principles

| Dimension | Behavior |
| --- | --- |
| Target source | Operator creates targets in the UI, or Commander `create_target`; `entrypoint` holds the authorized target entry |
| Scope constraints | JSON whitelist at `TCH_ENGAGEMENT_SCOPE` injected into solver context (**currently soft constraints**, see below) |
| Finding records | Solver calls `report_finding` → writes to local findings / submission logs, optionally with proof, writeup, evidence refs |
| Completion | **External operator confirmation** or Verifier re-verification; the engine does not auto-declare "mission complete" from model self-report alone |
| Intel queries | `get_target_intel` does not fetch remote hints in engagement mode; returns only local context already available |

## Enabling

Engagement mode is on by default — **no extra switch required**. Prepare the scope file before deployment:

```bash
export TCH_ENGAGEMENT_SCOPE=/absolute/path/engagement-scope.json
# Optional: TCH_ENGAGEMENT_MODE=0  legacy escape hatch for unit tests only (not used in production)
```

If `TCH_ENGAGEMENT_SCOPE` is unset, the file is missing, or `allowed_targets` is empty, **authorized scope cannot be injected into solver context**. Host-bridge record actions still attach to the target id, but the model sees no explicit boundaries — effectively "running without scope", **strongly discouraged**.

## Scope File Format

See [engagement-scope.example.json](engagement-scope.example.json).

| Field | Required | Description |
| --- | --- | --- |
| `engagement` | Yes | Exercise name for reporting / audit identification |
| `allowed_targets` | Yes (non-empty) | Authorization whitelist: IP / domain / CIDR / URL prefix |
| `out_of_scope` | No | Exclusions; takes precedence over the whitelist |
| `no_scan` | No | If true, disables active scan commands such as nmap / ffuf; default false |
| `forbidden_commands` | No | Additional forbidden command tokens, layered on the default set |
| `rules_of_engagement` | No | Free-text constraints (no DoS, business hours only, etc.) |

## Behavioral Constraints

- **Scope constraints (currently soft)**: Scope is injected into the main solver and subagent task context as mandatory behavioral instructions. **No automatic enforcement layer yet**: bash / MCP will not block out-of-scope targets or forbidden commands. Boundaries rely on model discipline + operator review; unified authorization enforcement is planned.
- **Finding records**: `report_finding` passes an evidence gate then writes to local submissions; `correct` does not mean remote judge approval — it marks "pending operator confirmation"; other running solvers on the same target receive steer broadcasts to reduce duplicate work.
- **Completion via human + Verifier**: `objective_achieved=true` can trigger Verifier re-verification inside the container; only `verified` calls `finishChallenge` and stops the solver. Operators can also manually mark complete or revoke completion in the UI.

## Notes

- Scope files contain real target information — **do not commit them to the repository**; the example is a template only.
- Credential evidence should be referenced via `evidence_refs`; avoid plaintext in shared state.

## Operator Workflow

1. Write a scope file (see template), set `TCH_ENGAGEMENT_SCOPE`, start `bun run web` (for public deployment set `TCH_AUTH_TOKEN`, see [deployment.md](deployment.md)).
2. On the UI **Targets** page create a target (`POST /api/challenges`): use a business id for `id` (no `mock-` prefix required), set `entrypoint` to the authorized entry URL / host:port.
3. Start a Solver (`POST /api/challenges/:id/solvers`, specify promptName such as `kimi-security`). Scope is injected as a soft constraint in the task text; monitor for boundary violations during execution.
4. When the Solver validates a vulnerability or gains control, call `report_finding` to record the finding (local findings, no external linkage).
5. Review submissions / attack flow / Runtime details in the UI; after out-of-scope review, decide to wrap up, continue, or move to the next target.
6. Optional: issue commands conversationally via **Commander**, import historical findings, or rely on the **Planner** auto-tick to allocate solvers.

## Related APIs (Local REST)

In engagement mode use the Web UI or local REST — **not** external competition platform APIs:

| Purpose | Method / Path |
| --- | --- |
| List / create targets | `GET` / `POST` `/api/challenges` |
| Target details, memory, ideas | `GET` `/api/challenges/:id` and sub-resources |
| Start / stop solver | `POST` `/api/challenges/:id/solvers`; Runtime API to stop instances |
| Attack timeline | `GET` `/api/challenges/:id/attack-timeline` (SSE stream) |
| Manual complete / revoke complete | `POST` `/api/challenges/:id/complete`, `revoke-complete` |

Full routes are in [ARCHITECTURE.md](../ARCHITECTURE.md) §10.
