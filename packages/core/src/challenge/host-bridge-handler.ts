import type { ChallengeManager } from "./manager"
import { recordSolverSteerFocus } from "../solver/board-store"
import { solverSessionDir } from "../runtime/types"
import { CHALLENGE_ENV_CHALLENGE_ID } from "./env"
import { loadEngagementScope } from "./engagement"
import { buildPromoteIdeaInput, buildPromoteMemoryInput } from "./board-promotion"
import { validateObjectiveEvidence } from "./finding-validation"
import type { IdeaStatus, MemoryKind } from "./memory"
import type { HostBridgeHandleContext, HostBridgeHandleResult, HostBridgeHandler, SolverInstance } from "../runtime/types"

function getObjectValue(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return value as Record<string, unknown>
}

function getRequiredString(data: Record<string, unknown>, key: string): string {
    const value = data[key]
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${key} is required`)
    }
    return value.trim()
}

function getSolverPromptName(solver?: SolverInstance): string | undefined {
    return solver?.promptName?.trim() || undefined
}

function getSolverModelName(startup: unknown): string | undefined {
    if (!startup || typeof startup !== "object" || !("sessionOptions" in startup)) return
    const sessionOptions = (startup as { sessionOptions?: unknown }).sessionOptions
    if (!sessionOptions || typeof sessionOptions !== "object" || !("model" in sessionOptions)) return
    const model = (sessionOptions as { model?: unknown }).model
    if (!model || typeof model !== "object") return
    const provider = (model as { provider?: unknown }).provider
    const id = (model as { id?: unknown }).id
    const providerText = typeof provider === "string" ? provider.trim() : ""
    const idText = typeof id === "string" ? id.trim() : ""
    const text = [providerText, idText].filter(Boolean).join("/")
    return text || undefined
}

function clipText(value: string, maxChars: number): string {
    const text = value.trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}...`
}

function sendFollowUpToSolver(context: HostBridgeHandleContext, solverId: string, message: string): void {
    const text = message.trim()
    if (!text) return
    context.sendCommand?.(solverId, {
        type: "follow_up",
        message: text,
    })
}

function sendSteerToSolver(context: HostBridgeHandleContext, solverId: string, message: string): void {
    const text = message.trim()
    if (!text) return
    void recordSolverSteerFocus({ message: text, source: "host-bridge:steer" }, solverSessionDir(solverId)).catch(() => {})
    context.sendCommand?.(solverId, {
        type: "steer",
        message: text,
    })
}

function broadcastToChallengeSolvers(
    context: HostBridgeHandleContext,
    challengeId: string,
    message: string,
    options?: { excludeSolverId?: string; delivery?: "follow_up" | "steer" },
): void {
    const targetChallengeId = challengeId.trim()
    const text = message.trim()
    if (!targetChallengeId || !text) return
    for (const solver of context.listSolvers?.() ?? []) {
        if (solver.challengeId !== targetChallengeId) continue
        if (solver.status !== "running") continue
        if (options?.excludeSolverId && solver.id === options.excludeSolverId) continue
        try {
            if (options?.delivery === "steer") {
                sendSteerToSolver(context, solver.id, text)
            } else {
                sendFollowUpToSolver(context, solver.id, text)
            }
        } catch {
            // ignore inactive solver pipes
        }
    }
}

function pickIdeaSummary(items: Array<{ id: string; status: string; content: string; result: string }>): string[] {
    const weighted = [...items].sort((left, right) => {
        const score = (status: string) => {
            switch (status) {
                case "verified":
                    return 4
                case "testing":
                    return 3
                case "failed":
                    return 2
                case "pending":
                    return 1
                case "skipped":
                    return 0
                default:
                    return -1
            }
        }
        return score(right.status) - score(left.status)
    })
    return weighted.slice(0, 6).map((item) => `- [${item.status}] ${clipText(item.content, 120)}${item.result.trim() ? ` -> ${clipText(item.result, 140)}` : ""}`)
}

function pickMemorySummary(items: Array<{ kind: string; content: string }>): string[] {
    return items.slice(-6).map((item) => `- [${item.kind}] ${clipText(item.content, 140)}`)
}

function formatEngagementObjectiveBroadcastMessage(input: {
    writeup?: string
    ideas: Array<{ id: string; status: string; content: string; result: string }>
    memory: Array<{ kind: string; content: string }>
}): string {
    const ideaLines = pickIdeaSummary(input.ideas)
    const memoryLines = pickMemorySummary(input.memory)
    return [
        "Collaboration sync: another solver in the same scope has recorded a verified objective/finding.",
        "- This only means that route produced a result; it does NOT mean the whole engagement is complete (the operator confirms completion).",
        "- Don't re-dig the same route — pivot to other in-scope targets or attack surface.",
        input.writeup?.trim() ? "- Finding route summary:" : undefined,
        input.writeup?.trim() ? `- ${clipText(input.writeup, 300)}` : undefined,
        ideaLines.length > 0 ? "- Current idea board summary:" : undefined,
        ...(ideaLines.length > 0 ? ideaLines : []),
        memoryLines.length > 0 ? "- Current memory summary:" : undefined,
        ...(memoryLines.length > 0 ? memoryLines : []),
    ]
        .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
        .join("\n")
}

async function handleEngagementAction(
    challengeManager: ChallengeManager,
    context: HostBridgeHandleContext,
): Promise<HostBridgeHandleResult> {
    const { solverId, action, params, getSolverEnvValue, getSolver, getSolverStartup } = context
    const data = getObjectValue(params)
    const scope = await loadEngagementScope(getSolverEnvValue)
        .then((loaded) => loaded.scope)
        .catch(() => undefined)
    // Storage/query/broadcast always use challenge (target) id as key — solver task, seed board,
    // broadcastToChallengeSolvers filters on solver.challengeId. scope.engagement is only
    // human-readable engagement name for challenge_get_state display, never the storage key (write/read mismatch,
    // findings never replay, dedupe broadcast breaks).
    const storeKey = getSolverEnvValue(CHALLENGE_ENV_CHALLENGE_ID) || scope?.engagement || "engagement"
    const engagementName = scope?.engagement ?? storeKey

    switch (action) {
        case "challenge_get_state": {
            // Include target record and real completion: observer review fills context from challenge (title/entry/status),
            // is_completed decides whether review continues after wind-down. Both must reflect reality —
            // previously hardcoded missing challenge + is_completed=false filled observer with placeholders,
            // and review kept running after completion. Matches challenge_is_completed
            // (objective_achieved true after verification); final sign-off remains with operator.
            const [challenge, completed] = await Promise.all([
                challengeManager.getChallenge(storeKey).catch(() => undefined),
                challengeManager.isChallengeCompleted(storeKey).catch(() => false),
            ])
            return {
                handled: true,
                data: {
                    challenge_id: storeKey,
                    challenge: challenge ?? null,
                    engagement: engagementName,
                    allowed_targets: scope?.allowed_targets ?? [],
                    out_of_scope: scope?.out_of_scope ?? [],
                    rules_of_engagement: scope?.rules_of_engagement ?? null,
                    is_completed: completed,
                },
            }
        }
        case "challenge_get_hint": {
            const challenge =
                typeof challengeManager.getChallenge === "function"
                    ? await challengeManager.getChallenge(storeKey).catch(() => undefined)
                    : undefined
            const intel = challenge?.intel_notes?.trim() || null
            return {
                handled: true,
                data: { code: storeKey, hint_content: intel },
            }
        }
        case "challenge_submit_flag": {
            const proof = getRequiredString(data, "flag")
            const writeup = typeof data.writeup === "string" && data.writeup.trim() ? data.writeup.trim() : undefined
            const objectiveClaimed = data.objective_achieved === true
            // Assertive evidence gate (deterministic first pass): solver reporting primary objective can stop the line,
            // but models sometimes claim victory without proof. Insufficient evidence downgrades to plain finding (still logged, no verification),
            // other solvers continue; tell this solver to supply concrete proof.
            const challenge =
                typeof challengeManager.getChallenge === "function"
                    ? await challengeManager.getChallenge(storeKey).catch(() => undefined)
                    : undefined
            const objectiveText = challenge ? `${challenge.title}\n${challenge.description}` : ""
            const evidence = objectiveClaimed
                ? validateObjectiveEvidence(proof, writeup, { objectiveText })
                : { sufficient: false, reason: "" }
            // Passed gate → pending verification; independent verifier reproduces before wind-down.
            const enterVerification = objectiveClaimed && evidence.sufficient
            const record = await challengeManager.recordEngagementObjective(storeKey, proof, {
                solverId,
                promptName: getSolverPromptName(getSolver?.()),
                modelName: getSolverModelName((await getSolverStartup?.()) ?? undefined),
                writeup,
                verificationStatus: enterVerification ? "pending" : undefined,
            })
            await challengeManager
                .promoteFindingFactsToChallenge(storeKey, proof, writeup, `finding:${record.id}`)
                .catch(() => {})
            // Broadcast to other solvers on same target: finding recorded, avoid duplicate routes.
            const [memory, ideas] = await Promise.all([
                challengeManager.listMemory(storeKey).catch(() => []),
                challengeManager.listIdeas(storeKey).catch(() => []),
            ])
            broadcastToChallengeSolvers(
                context,
                storeKey,
                formatEngagementObjectiveBroadcastMessage({ writeup, ideas, memory }),
                { excludeSolverId: solverId, delivery: "steer" },
            )
            // Dual verification: self-report + evidence gate → start independent verifier re-run.
            // Only verifier verified triggers markEngagementComplete (inside verifyObjective);
            // rejected → steer "verification failed, continue"; inconclusive → operator review, no wind-down.
            // Async; does not block tool return (verifier starts LLM session re-run).
            if (enterVerification) {
                void challengeManager
                    .verifyObjective({
                        challengeId: storeKey,
                        recordId: record.id,
                        proof,
                        writeup,
                        entrypoint: challenge?.entrypoint ?? null,
                        onResolved: (verdict, note) => {
                            if (verdict === "rejected") {
                                sendSteerToSolver(
                                    context,
                                    solverId,
                                    `Your reported primary objective FAILED independent verification (a verifier re-ran your proof and could not reproduce it): ${note}. The target is NOT being wound down. Keep working — get concrete, freshly-reproducible proof before reporting objective_achieved again.`,
                                )
                            } else if (verdict === "inconclusive") {
                                sendSteerToSolver(
                                    context,
                                    solverId,
                                    `Your reported objective could not be auto-verified (${note}); it's left for operator review and the target is NOT wound down yet. Keep consolidating proof.`,
                                )
                            }
                        },
                    })
                    .catch((error) => {
                        // Verifier start/re-run failure must not be silent: solver awaits wind-down; operator must know.
                        console.error(
                            `[engagement] verifyObjective failed for ${storeKey}/${record.id}: ${error instanceof Error ? error.message : String(error)}`,
                        )
                    })
            }
            const downgraded = objectiveClaimed && !evidence.sufficient
            return {
                handled: true,
                data: {
                    challenge_id: storeKey,
                    recorded: true,
                    record_id: record.id,
                    // In verification, not wound down yet (awaiting verifier); is_completed=false.
                    is_completed: false,
                    // Under independent review; solver knows self-report is being re-verified.
                    under_verification: enterVerification,
                    // When downgraded by gate, tell solver to add evidence before re-reporting.
                    objective_downgraded: downgraded,
                    message: enterVerification
                        ? "objective recorded and submitted to an independent verifier for re-run confirmation; the target will only be wound down if verification passes. Keep your session alive."
                        : downgraded
                          ? `finding recorded, but the objective_achieved signal was NOT accepted: ${evidence.reason}. Keep working and re-report with concrete proof to wind down the target.`
                          : "objective recorded to local findings; pending operator confirmation",
                },
            }
        }
        case "challenge_is_completed": {
            // Reflect real completion: true after objective_achieved so solver ralph-loop can stop.
            const completed = await challengeManager.isChallengeCompleted(storeKey).catch(() => false)
            return { handled: true, data: { challenge_id: storeKey, is_completed: completed } }
        }
        case "challenge_promote_memory": {
            const kindRaw = typeof data.kind === "string" ? data.kind.trim() : ""
            const validKinds = new Set(["fact", "evidence", "credential", "failure", "note", "hint"])
            if (!validKinds.has(kindRaw)) {
                return {
                    handled: true,
                    data: { challenge_id: storeKey, promoted: false, duplicate: false, message: `invalid memory kind: ${kindRaw || "(empty)"}` },
                }
            }
            const result = await challengeManager.tryPromoteMemoryToChallenge(
                buildPromoteMemoryInput(
                    storeKey,
                    kindRaw as MemoryKind,
                    getRequiredString(data, "content"),
                    typeof data.source === "string" && data.source.trim() ? data.source.trim() : `solver:${solverId}`,
                    Array.isArray(data.refs) ? data.refs.filter((item): item is string => typeof item === "string") : [],
                ),
            )
            return {
                handled: true,
                data: {
                    challenge_id: storeKey,
                    promoted: result.promoted,
                    duplicate: result.duplicate,
                    entry_id: result.entry?.id,
                },
            }
        }
        case "challenge_promote_idea": {
            const statusRaw = typeof data.status === "string" ? data.status.trim() : ""
            const validStatuses = new Set(["verified", "failed"])
            if (!validStatuses.has(statusRaw)) {
                return {
                    handled: true,
                    data: {
                        challenge_id: storeKey,
                        promoted: false,
                        duplicate: false,
                        message: "only verified or failed ideas are promoted to the target board",
                    },
                }
            }
            const result = await challengeManager.tryPromoteIdeaToChallenge(
                storeKey,
                buildPromoteIdeaInput(
                    getRequiredString(data, "content"),
                    statusRaw as IdeaStatus,
                    typeof data.result === "string" ? data.result : undefined,
                ),
                typeof data.source === "string" && data.source.trim() ? data.source.trim() : `solver:${solverId}`,
            )
            return {
                handled: true,
                data: {
                    challenge_id: storeKey,
                    promoted: result.promoted,
                    duplicate: result.duplicate,
                    idea_id: result.item?.id,
                },
            }
        }
        case "state_upsert": {
            // Structured asset to shared state (cross-solver). Engine dedupes, broadcasts, feeds planner.
            const kindRaw = typeof data.kind === "string" ? data.kind.trim() : ""
            const validKinds = new Set(["host", "service", "credential", "session"])
            if (!validKinds.has(kindRaw)) {
                return { handled: true, data: { challenge_id: storeKey, recorded: false, message: `invalid asset kind: ${kindRaw || "(empty)"}` } }
            }
            const result = await challengeManager.upsertStateAsset(storeKey, {
                kind: kindRaw as "host" | "service" | "credential" | "session",
                label: getRequiredString(data, "label"),
                host: typeof data.host === "string" && data.host.trim() ? data.host.trim() : undefined,
                port: typeof data.port === "number" && Number.isFinite(data.port) ? data.port : undefined,
                service: typeof data.service === "string" && data.service.trim() ? data.service.trim() : undefined,
                account: typeof data.account === "string" && data.account.trim() ? data.account.trim() : undefined,
                privilege: typeof data.privilege === "string" && data.privilege.trim() ? data.privilege.trim() : undefined,
                secretRef: typeof data.secret_ref === "string" && data.secret_ref.trim() ? data.secret_ref.trim() : undefined,
                sessionType: typeof data.session_type === "string" && data.session_type.trim() ? data.session_type.trim() : undefined,
                note: typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined,
                sourceRefs: Array.isArray(data.source_refs) ? data.source_refs.filter((item): item is string => typeof item === "string") : undefined,
            })
            return {
                handled: true,
                data: {
                    challenge_id: storeKey,
                    recorded: true,
                    asset_id: result.asset.id,
                    created: result.created,
                    message: result.created ? "asset recorded to shared state" : "asset merged into existing shared-state entry",
                    ...(result.vulnLookup ? { vuln_lookup: result.vulnLookup } : {}),
                },
            }
        }
        default:
            return { handled: false }
    }
}

export function createChallengeHostBridgeHandler(challengeManager: ChallengeManager): HostBridgeHandler {
    return {
        async handle(context) {
            // Remote CTF scoring removed: all host-bridge actions use engagement handling.
            return handleEngagementAction(challengeManager, context)
        },
    }
}
