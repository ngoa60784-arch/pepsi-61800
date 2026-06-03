import type { ChallengeManager } from "./manager"
import { CHALLENGE_ENV_CHALLENGE_ID } from "./env"
import { loadEngagementScope } from "./engagement"
import { validateObjectiveEvidence } from "./finding-validation"
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
    // 存储/查询/广播一律用 challenge(target) id 作为 key —— solver 任务文案、seed board、
    // broadcastToChallengeSolvers 的 solver.challengeId 过滤都以它为准。scope.engagement 只是
    // 演练的人类可读名称，仅用于 challenge_get_state 的展示字段，绝不能当存储 key（否则写读 key 不一致，
    // findings 永远不回灌、降重广播失效）。
    const storeKey = getSolverEnvValue(CHALLENGE_ENV_CHALLENGE_ID) || scope?.engagement || "engagement"
    const engagementName = scope?.engagement ?? storeKey

    switch (action) {
        case "challenge_get_state": {
            // 带上目标记录与真实完成状态：observer review 用 challenge 字段填充上下文(标题/入口/状态)，
            // 用 is_completed 决定目标收尾后是否还需要继续 review。两者都要反映真实状态——
            // 之前硬编码 challenge 缺失 + is_completed=false，导致 observer 上下文全是占位符、
            // 且目标完成后仍会无意义地继续跑 review。真实完成判定与 challenge_is_completed 一致
            // （objective_achieved 经验证后为 true），最终收尾仍由操作员在范围外确认。
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
            // 实战没有 hint 裁判；明确告知，避免模型空等。
            return {
                handled: true,
                data: { code: storeKey, hint_content: null },
            }
        }
        case "challenge_submit_flag": {
            const proof = getRequiredString(data, "flag")
            const writeup = typeof data.writeup === "string" && data.writeup.trim() ? data.writeup.trim() : undefined
            const objectiveClaimed = data.objective_achieved === true
            // 断言式证据门禁(确定性首过)：solver 自报主目标达成会触发停整条战线，
            // 但模型有时无凭据"宣布胜利"。证据不足时降级为普通 finding（仍记录，不进验证流程），
            // 让其它 solver 继续推进，并回报让该 solver 补上具体产物。
            const evidence = objectiveClaimed ? validateObjectiveEvidence(proof, writeup) : { sufficient: false, reason: "" }
            // 过了证据门禁 → 进入"待复核"状态(pending)，由独立 verifier 主动复现确认后才收尾。
            const enterVerification = objectiveClaimed && evidence.sufficient
            const record = await challengeManager.recordEngagementObjective(storeKey, proof, {
                solverId,
                promptName: getSolverPromptName(getSolver?.()),
                modelName: getSolverModelName((await getSolverStartup?.()) ?? undefined),
                writeup,
                verificationStatus: enterVerification ? "pending" : undefined,
            })
            // 广播给同题其它 solver：已记录一个 finding，避免重复挖同一路线。
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
            // 双重验证:solver 自报达成 + 过证据门禁 → 起独立 verifier 复跑确认。
            // 只有 verifier 判 verified 才会 markEngagementComplete(在 verifyObjective 内部)；
            // rejected → steer 该 solver"复核未通过，继续推进";inconclusive → 交操作员复核，不收尾。
            // 异步触发，不阻塞本次工具返回(verifier 会起一个 LLM 会话复跑，耗时)。
            if (enterVerification) {
                void challengeManager
                    .verifyObjective({
                        challengeId: storeKey,
                        recordId: record.id,
                        proof,
                        writeup,
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
                        // verifier 启动/复跑失败不应静默：solver 仍在等收尾信号，操作员需要知道验证没跑成。
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
                    // 进入验证流程时尚未收尾(等 verifier);故 is_completed=false。
                    is_completed: false,
                    // 已进入独立复核流程,让 solver 知道"已自报达成、正在被复跑验证"。
                    under_verification: enterVerification,
                    // 证据被门禁降级时显式告知，让 solver 补证据后再报，而不是误以为已收尾。
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
            // 反映真实完成状态:objective_achieved 标记后为 true,让 solver 的续跑循环(ralph-loop)自行收手。
            const completed = await challengeManager.isChallengeCompleted(storeKey).catch(() => false)
            return { handled: true, data: { challenge_id: storeKey, is_completed: completed } }
        }
        case "state_upsert": {
            // 结构化作战资产写入共享状态库(跨 solver 复用)。引擎去重合并 + 广播 + 喂给 planner。
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
                },
            }
        }
        case "relation_upsert": {
            // 攻击图谱写边：source --relation--> target。底层 SQLite 按 (source,relation,target) 大小写无关去重，
            // 重复三元组直接复用既有记录(同 record_asset 的合并语义)。写后广播给同目标其它 solver。
            const relation = await challengeManager.appendRelation({
                challengeId: storeKey,
                source: getRequiredString(data, "source"),
                relation: getRequiredString(data, "relation"),
                target: getRequiredString(data, "target"),
                note: typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined,
                source_ref: typeof data.source_ref === "string" && data.source_ref.trim() ? data.source_ref.trim() : undefined,
            })
            return {
                handled: true,
                data: {
                    challenge_id: storeKey,
                    recorded: true,
                    relation_id: relation.id,
                    message: "attack-graph edge recorded to shared graph",
                },
            }
        }
        case "relation_query": {
            // 按 source/relation/target 子串过滤(大小写无关)查询攻击图谱边。空过滤 = 返回全图。
            const relations = await challengeManager.queryRelations(storeKey, {
                source: typeof data.source === "string" && data.source.trim() ? data.source.trim() : undefined,
                relation: typeof data.relation === "string" && data.relation.trim() ? data.relation.trim() : undefined,
                target: typeof data.target === "string" && data.target.trim() ? data.target.trim() : undefined,
            })
            return {
                handled: true,
                data: {
                    challenge_id: storeKey,
                    count: relations.length,
                    relations: relations.map((rel) => ({
                        id: rel.id,
                        source: rel.source,
                        relation: rel.relation,
                        target: rel.target,
                        note: rel.note,
                    })),
                },
            }
        }
        case "relation_path": {
            // 在攻击图谱里求 start→end 的最短路径(BFS, 有向边)。返回每一跳的 source/relation/target。
            const start = getRequiredString(data, "start")
            const end = getRequiredString(data, "end")
            const result = await challengeManager.findRelationShortestPath(storeKey, start, end)
            return {
                handled: true,
                data: {
                    challenge_id: storeKey,
                    found: result.found,
                    hops: result.path.length,
                    path: result.path,
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
            // CTF 远程评分链路已移除：所有 host-bridge 动作统一走实战(engagement)处理。
            return handleEngagementAction(challengeManager, context)
        },
    }
}
