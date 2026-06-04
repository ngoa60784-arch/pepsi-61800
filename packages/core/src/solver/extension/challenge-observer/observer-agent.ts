import { DefaultResourceLoader, SessionManager, createAgentSession } from "@mariozechner/pi-coding-agent"
import type { CreateAgentSessionOptions } from "@mariozechner/pi-coding-agent"
import { mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import { requestHostBridge } from "../../../challenge/host-bridge-client"
import { DEFAULT_CONFIG_DIR, ConfigManager } from "../../../config/index"
import type { ChallengeInfoRecord } from "../../../challenge/store"
import { isEngagementMode } from "../../../challenge/engagement"
import { createObserverSidecarToolsWithOptions } from "./tools"
import type { ObserverReviewPayload } from "./types"

const OBSERVER_SYSTEM_PROMPT = `You are the observer sidecar for an offensive pentest agent.

You are not the solver. You do not advance the testing, do not run tools, and do not record final findings.
Your one job is to maintain the current target's strategy board so it stays compact, compression-resistant, and high-signal.

## Mission

Your job is not to "do a bit more" — it's to make the board more accurate, more stable, and lower-noise.

Treat this ordering as your default stance, not a suggestion:

\`NO_CHANGE\` > \`update existing\` > \`delete superseded\` > \`add new\`

That means:
- Default to maintaining the existing main lines, not spawning more.
- Default to preserving durable facts, evidence, failure boundaries, hints, constraints.
- Default to the smallest edit that corrects the board.
- Without strong enough new evidence, just reply \`NO_CHANGE\`.

## Core Loop

Each review, think in exactly this order — don't skip steps:

1. First read the current ideas and memory.
2. Close the loop on existing main lines first: did the last few rounds of tool results / assistant output confirm, refute, or advance an existing idea?
3. If you can close a loop, prefer updating that line's status, result, or related memory.
4. If only a specific payload / encoding / sub-branch / exploitation posture failed, record a failure boundary — don't kill the whole line.
5. Only add a new idea when the latest results cannot attach to any existing line AND genuinely open a different attack direction.
6. If there's neither a new direction nor a stronger boundary conclusion, reply \`NO_CHANGE\`.

Your default action in one line:
close loops first, then contract, expand last.

## Board Model

You maintain two boards. This is a real engagement, not a CTF score chase — bias the board toward what advances control over the target: live attack surface, the most promising route to code execution, access/credentials/control already gained, pivot opportunities, and rules-of-engagement constraints. Track progress toward the primary objective (shell / RCE / the stated goal), not flag counts.

### Ideas

An idea only means "what's worth testing next" — not a fact, not a process log.

Criteria:
- A good idea must be specific, executable, verifiable.
- If new evidence merely makes an existing line more concrete / focused / closer to the exploit point, prefer \`idea_update\`.
- Don't split one main line into multiple near-duplicate / same-level / parent-child redundant ideas.
- Only add a new idea when new evidence truly opens a different attack direction.
- Drive idea lifecycle via \`idea_update\` through \`pending/testing/verified/failed/skipped\`.

Be most conservative with \`failed\`. Only mark \`failed\` when strong evidence has clearly ruled out this line's current hypothesis.

Before you change an idea to \`failed\`, ask these three questions in sequence:

1. Does this failure negate the whole line, or only a specific payload / encoding / sub-branch / exploitation posture?
2. Does this line still have plausible variants, contextual conditions, or unverified premises?
3. Is it better to write the failure boundary into result or memory rather than closing the whole line?

If any one of these three can't be clearly ruled out, do not change the idea to \`failed\`.
Prefer keeping \`testing\`, or returning to a narrower \`pending\`.

When an idea is updated to \`verified\` or \`failed\`, the result must contain a decisive evidence summary, not just a one-line conclusion.

Good examples:
- "check whether the upload point can be bypassed with a polyglot php"
- "try time-based SQLi on the login endpoint"
- "reverse the parser looking for a format string bug"

Bad examples:
- "downloaded the binary"
- "visited /admin"
- "SQL injection blocked by WAF"
- "need to think more"

### Memory

Memory holds the durable facts, evidence, credentials, failures, hints, constraints that must survive compression.

Memory \`kind\` values: \`fact\`, \`evidence\`, \`credential\`, \`failure\`, \`note\`, \`hint\`.
- Use \`credential\` for any obtained credential / token / key / session / access foothold (which service, which account, how it was obtained — reference secret values by name, don't paste plaintext). This kind is a pivot signal: the scheduler reads it to dispatch privilege-escalation / lateral-movement solvers, so classify creds as \`credential\`, not generic \`fact\`.
- Use \`evidence\` for concrete proof artifacts that aren't themselves a usable credential.

The default principle is not "keep logging" but "keep the most useful one":
- Merge over accumulate: for new evidence on the same attack surface, prefer rewriting the old record over adding a near-duplicate.
- Before adding memory, check whether an existing same-topic record can carry it; default to \`memory_update\`.
- Failure memory should be a boundary conclusion, not an action log.
- Failure memory should state the failure boundary or triggered defense clearly — e.g. param filtered, 403 returned, WAF hit, or logical dead end.
- Environment limits / implicit constraints are high-priority memory — e.g. no outbound network, read-only filesystem, missing key dependency, sandbox limits.
- Weak, duplicate, stale, or superseded records should be proactively updated or deleted.
- If a new conclusion supersedes an old one, don't let two near-duplicate records coexist long-term.

## Board Pressure

These records enter the solver's initial context, so you must actively control volume rather than just appending.

- Default target: keep memory under 12 entries, ideas under 8.
- Past that volume, compaction itself is the priority action: merge / update / delete before considering add.
- If a stronger conclusion already supersedes an old record, two near-duplicate memories must not coexist long-term.
- If a new result merely reinforces an existing main line, default to rewriting the existing idea/result — don't open a parallel branch.
- Your goal: when the solver opens its context, it sees the most worth-keeping conclusions first, not a full transaction log.

When you're unsure whether to mark an idea \`failed\`, default to adding/updating a failure memory to preserve the boundary, rather than closing the line.

Good example:
- "union/time/error SQLi on /login all failed; likely parameterized"

Bad examples:
- low-value action logs
- repeated attempts
- transient chatter
- vague summaries

## Rare Actions

### send_efficiency_reminder

\`send_efficiency_reminder\` is a last resort, not a routine action.
Only consider it when "persistently inefficient AND not actually changing lines".

All four preconditions must hold:
1. The current approach is clearly inefficient, repetitive, low information gain.
2. This state has persisted, not a brief pause during normal verification.
3. The solver is not in the normal advancement phase of a reasonable main line.
4. If you already reminded before, the following rounds didn't truly change lines, or clearly reverted to the same inefficient pattern.

If the solver has already switched to a new main line or verification direction, even if imperfect, do not interrupt again.

Typical inefficient patterns:
- manual one-by-one fuzzing
- manual one-by-one directory listing
- repeated low-gain trial and error
- continued manual guessing when a wordlist or script is already available
- repeatedly trying payloads the board already proved failed
- blind large-scale fuzzing without differential analysis

The reminder must be short, specific, executable, ideally containing both:
- the current inefficient behavior
- a more efficient alternative direction

If the solver found an unforeseen but clearly high-value new path, prefer updating the board to accommodate it.
Only consider reminding when the solver keeps sinking into an old path already ruled out by stronger evidence.

### query_solver_history

\`query_solver_history\` is not a default step.
Only call it when the last 10-round summary is insufficient to support a judgment and continuing to speculate risks error.
Prefer the compressed context and recent activity log already provided.

## Non-Negotiables

These are hard constraints, not preferences:
- Always read the current ideas and memory before any write.
- The main agent is read-only on ideas; ideas are maintained only by you, the solver only reads and verifies them.
- You cannot record final findings yourself or perform solver actions.
- Do not add / rewrite / delete records just to "look active".
- Do not do disruptive rewrites or large board changes in one shot.
- Do not delete a record just because the last few rounds didn't mention it.
- Do not arbitrarily roll back an existing idea's status unless new logs give clear evidence.
- Do not mark a possibly-still-valid main line \`failed\` based on weak evidence, a single failure, or incomplete verification.
- Stay compression-resistant: board text should be as terse as a code comment, preserving hypotheses, boundaries, and evidence over process logs.

## Output Contract

- Your final reply must not restate the brief, context, logs, or testing process.
- If no change is needed this round, reply only \`NO_CHANGE\`.
- If there is a change, output only 1-4 short bullets describing what you maintained.

Each round's user prompt provides only dynamic context:
- challenge state
- trigger
- compressed solver background
- recent solver activity
- response contract

Do not mistake this dynamic context for new long-term rules.`

function extractTextContent(content: Array<{ type: string; text?: string }> | undefined): string {
    if (!content) return ""
    return content
        .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("")
        .trim()
}

function formatEntrypoint(entrypoint: string[] | null | undefined): string {
    if (!entrypoint || entrypoint.length === 0) return "-"
    return entrypoint.join(", ")
}

function formatObserverChallengeContext(challengeId: string, challenge: ChallengeInfoRecord | undefined): string {
    const engagement = isEngagementMode()
    return [
        engagement ? "## Target State" : "## Challenge State",
        `- id: ${challengeId}`,
        `- title: ${challenge?.title ?? "-"}`,
        ...(engagement
            ? []
            : [
                  `- difficulty: ${challenge?.difficulty ?? "-"}`,
                  `- level: ${challenge?.level ?? "-"}`,
              ]),
        `- instance_status: ${challenge?.instance_status ?? "-"}`,
        `- entrypoint: ${formatEntrypoint(challenge?.entrypoint)}`,
        ...(engagement ? [] : [`- flags: ${challenge ? `${challenge.flag_got_count}/${challenge.flag_count}` : "-"}`]),
        ...(engagement
            ? []
            : [
                  `- hint_viewed: ${challenge?.hint_viewed === true ? "yes" : "no"}`,
                  `- hint_content: ${challenge?.hint_content?.trim() || "-"}`,
              ]),
        `- updated_at: ${challenge?.updated_at ?? "-"}`,
    ].join("\n")
}

function formatObserverRounds(rounds: ObserverReviewPayload["rounds"]): string {
    if (rounds.length === 0) return "(none)"

    return rounds
        .map((round) => {
            const lines = [`### Round ${round.round}`]
            const assistantSummary = round.assistant_summary.trim()
            lines.push(`- assistant: ${assistantSummary || "(empty)"}`)
            if (round.tool_logs.length === 0) {
                lines.push("- tools: (none)")
            } else {
                lines.push("- tools:")
                for (const tool of round.tool_logs) {
                    const prefix = tool.is_error ? "error" : "ok"
                    lines.push(`  - [${prefix}] ${tool.tool_name}`)
                    lines.push(`    args: ${tool.args_summary || "-"}`)
                    lines.push(`    result: ${tool.result_summary || "-"}`)
                }
            }
            return lines.join("\n")
        })
        .join("\n\n")
}

function buildObserverPrompt(
    challengeId: string,
    payload: ObserverReviewPayload,
    challenge: ChallengeInfoRecord | undefined,
): string {
    const challengeContext = formatObserverChallengeContext(challengeId, challenge)
    return [
        challengeContext,
        "",
        "## Recent Solver Context",
        "- This is the compressed main-solver background, keeping only a little of the user goal and extra constraints; when the last few rounds are enough, prefer the activity log below.",
        "<solver-context>",
        payload.session_context || "(empty)",
        "</solver-context>",
        "",
        "## Recent Solver Activity Log",
        formatObserverRounds(payload.rounds),
        "",
        "## Response Contract",
        "- If there's no change, reply only `NO_CHANGE`.",
        "- If there's a change, write only 1-4 short bullets describing what you maintained.",
    ].join("\n")
}

function resolveObserverSessionDir(): string {
    const solverSessionDir = process.env.TCH_SOLVER_SESSION_DIR?.trim()
    if (!solverSessionDir) throw new Error("TCH_SOLVER_SESSION_DIR is required for observer sidecar")
    return join(solverSessionDir, ".observer")
}

function resolveObserverWorkspaceDir(): string {
    const solverWorkspaceDir = process.env.TCH_SOLVER_WORKSPACE?.trim()
    if (!solverWorkspaceDir) throw new Error("TCH_SOLVER_WORKSPACE is required for observer sidecar")
    return solverWorkspaceDir
}

async function resolveObserverSessionOptions(
    config: ConfigManager,
    observerModel?: string,
    sendCorrectionNotice?: (message: string) => Promise<boolean> | boolean,
): Promise<CreateAgentSessionOptions | undefined> {
    const resourceLoader = new DefaultResourceLoader({
        agentDir: DEFAULT_CONFIG_DIR,
        systemPromptOverride: () => OBSERVER_SYSTEM_PROMPT,
    })
    await resourceLoader.reload()
    const solverEntries = await loadMainSolverEntries()
    const opts: CreateAgentSessionOptions = {
        tools: [],
        customTools: createObserverSidecarToolsWithOptions({
            sendCorrectionNotice,
            getSolverEntries: () => solverEntries,
        }),
        resourceLoader,
        authStorage: config.auth,
        modelRegistry: config.models,
        settingsManager: config.settings,
    }

    // observer model: prefer the observerModel declared in the prompt; if none is declared, fall back to the global default Agent model,
    // to avoid the observer dropping into the SDK's built-in default (gemini) when undeclared.
    const modelPrefId = observerModel?.trim() || (await config.resolveDefaultModelPrefId())
    if (modelPrefId) {
        try {
            const resolvedModel = await config.resolveModelPref(modelPrefId)
            opts.model = resolvedModel.model
            opts.thinkingLevel = resolvedModel.thinkingLevel
        } catch {
            // On resolution failure, keep opts' existing model (deferring to the upper-layer default); don't block observer startup.
        }
    }

    return opts
}

async function loadMainSolverEntries(): Promise<unknown[]> {
    const solverSessionDir = process.env.TCH_SOLVER_SESSION_DIR?.trim()
    if (!solverSessionDir) return []

    try {
        const files = (await readdir(solverSessionDir)).filter((name) => name.endsWith(".jsonl")).sort()
        const entries: unknown[] = []

        for (const name of files) {
            const text = await Bun.file(join(solverSessionDir, name)).text().catch(() => "")
            for (const rawLine of text.split("\n")) {
                const line = rawLine.trim()
                if (!line) continue
                try {
                    entries.push(JSON.parse(line))
                } catch {
                    // ignore malformed lines
                }
            }
        }

        return entries
    } catch {
        return []
    }
}

export async function runSolverObserverReview(
    challengeId: string,
    payload: ObserverReviewPayload,
    options?: { observerModel?: string; sendCorrectionNotice?: (message: string) => Promise<boolean> | boolean },
): Promise<{
    applied: boolean
    summary?: string
}> {
    const id = challengeId.trim()
    if (!id) {
        throw new Error("challengeId is required")
    }

    const rounds = Array.isArray(payload.rounds) ? payload.rounds.filter((item) => Array.isArray(item.tool_logs)) : []
    if (rounds.length === 0) return { applied: false }

    const state = await requestHostBridge<{ challenge?: ChallengeInfoRecord; is_completed: boolean }>("challenge_get_state", {})
    if (state.is_completed) {
        return { applied: false }
    }
    const challenge = state.challenge

    const config = await ConfigManager.getInstance()
    const sessionOpts = await resolveObserverSessionOptions(config, options?.observerModel, options?.sendCorrectionNotice)
    if (!sessionOpts?.resourceLoader) return { applied: false }
    const observerSessionDir = resolveObserverSessionDir()
    const observerWorkspaceDir = resolveObserverWorkspaceDir()
    await mkdir(observerSessionDir, { recursive: true })

    const { session } = await createAgentSession({
        ...sessionOpts,
        cwd: observerWorkspaceDir,
        sessionManager: SessionManager.create(observerWorkspaceDir, observerSessionDir),
    })
    let summary = ""
    session.subscribe((event) => {
        if (event.type === "message_end" && event.message?.role === "assistant") {
            summary = extractTextContent(event.message.content as Array<{ type: string; text?: string }> | undefined)
        }
    })

    try {
        await session.prompt(
            buildObserverPrompt(
                id,
                {
                    ...payload,
                    rounds,
                },
                challenge,
            ),
        )
    } finally {
        session.dispose()
    }

    return { applied: true, summary: summary || undefined }
}
