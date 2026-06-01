import { defineTool } from "@mariozechner/pi-coding-agent"
import type { Static } from "@sinclair/typebox"
import { Type } from "@sinclair/typebox"
import { requestHostBridge } from "../../challenge/host-bridge-client"

const EmptyParams = Type.Object({})
const ReportFindingParams = Type.Object({
    proof: Type.String({
        description: "Proof of a verified finding: e.g. a captured credential, shell/RCE evidence reference, or other concrete validation artifact",
    }),
    writeup: Type.Optional(Type.String({ description: "Concise route summary of how this finding was obtained and validated" })),
    objective_achieved: Type.Optional(
        Type.Boolean({
            description:
                "Set true ONLY when this finding fully achieves the engagement's primary objective (e.g. confirmed RCE / interactive shell / the specific goal in your task). This does NOT immediately stop the target: it submits your finding to an independent verifier that RE-RUNS your proof against the live target. The target is only wound down if verification passes. So you MUST include concrete, freshly-reproducible proof in `proof`/`writeup` (raw command output like `uid=0(root)`, a shell prompt, file contents such as /etc/passwd, a captured credential/hash/token, or an HTTP/DB response). A bare claim with no artifact is rejected outright; a claim the verifier cannot reproduce is rejected and you'll be told to keep working. Do NOT set true for partial progress, recon, or unverified leads.",
        }),
    ),
})

type ReportFindingInput = Static<typeof ReportFindingParams>

/**
 * report_finding — 记录一个已验证的发现（实战/演练模式）。
 *
 * 不外联任何远程评分服务；发现写入本地 findings/提交日志。
 * objective_achieved=true 时表示主目标已达成 → 引擎据此停掉该目标所有 solver、planner 不再补派。
 *
 * 注意：内部 host-bridge action 仍沿用 "challenge_submit_flag" 这个稳定的 wire 字符串，
 * 避免改动 RPC 契约与历史日志匹配；模型只看到 report_finding 这个工具名。
 */
export const reportFindingTool = defineTool({
    name: "report_finding",
    label: "Report Finding",
    description:
        "Record a verified penetration finding (credential, shell/RCE proof, sensitive data access) into the local findings log. Include a concise writeup so other solvers avoid repeating the route. Set objective_achieved=true ONLY when this finding fully achieves the primary engagement objective — that stops this target's solvers and halts the planner for it.",
    promptSnippet: "report_finding: record one verified finding (proof + writeup); set objective_achieved=true only when the primary goal is fully met",
    parameters: ReportFindingParams,
    async execute(_toolCallId, params: ReportFindingInput) {
        const details = await requestHostBridge<{
            recorded?: boolean
            record_id?: string
            is_completed: boolean
            under_verification?: boolean
            objective_downgraded?: boolean
            message?: string
        }>("challenge_submit_flag", {
            flag: params.proof,
            ...(params.writeup?.trim() ? { writeup: params.writeup.trim() } : {}),
            ...(params.objective_achieved === true ? { objective_achieved: true } : {}),
        })
        const recordRef = details.record_id ? ` (id: ${details.record_id})` : ""
        const note = details.message?.trim() || "finding recorded to local findings; pending operator confirmation"
        return {
            content: [{ type: "text", text: `${note}${recordRef}` }],
            details,
        }
    },
})

/**
 * get_target_intel — 读取当前目标的本地缓存情报。
 *
 * 实战模式没有 hint 裁判：通常返回空，提示模型依赖主动侦察。
 */
export const getTargetIntelTool = defineTool({
    name: "get_target_intel",
    label: "Get Target Intel",
    description: "Fetch any locally cached intelligence for the current target. In engagement mode there is no hint oracle; rely on active recon.",
    promptSnippet: "get_target_intel: retrieve cached intel for the current target",
    parameters: EmptyParams,
    async execute() {
        const details = await requestHostBridge<{
            code: string
            hint_content: string | null
        }>("challenge_get_hint", {})
        const intel = details.hint_content?.trim()
        return {
            content: [{ type: "text", text: intel ? `target intel:\n${intel}` : "no cached intel for this target; rely on active recon" }],
            details,
        }
    },
})

const RecordAssetParams = Type.Object({
    kind: Type.Union([Type.Literal("host"), Type.Literal("service"), Type.Literal("credential"), Type.Literal("session")], {
        description: "host = a discovered machine; service = a service/port on a host; credential = an obtained account/token/key; session = a live access channel (shell/ssh/cookie)",
    }),
    label: Type.String({ description: "Short human-readable label, e.g. '10.0.0.5', 'http://10.0.0.5:8080', 'admin@webapp', 'reverse shell on web01'" }),
    host: Type.Optional(Type.String({ description: "ip/hostname this asset lives on" })),
    port: Type.Optional(Type.Integer({ description: "port number (for service)" })),
    service: Type.Optional(Type.String({ description: "service/product/version, e.g. 'nginx 1.25', 'OpenSSH 9.2'" })),
    account: Type.Optional(Type.String({ description: "username/role (for credential/session). Do NOT put the plaintext secret here." })),
    privilege: Type.Optional(Type.String({ description: "privilege level, e.g. 'user', 'root', 'admin', 'www-data'" })),
    secret_ref: Type.Optional(Type.String({ description: "reference name pointing to where the secret value is stored (evidence ref) — NOT the plaintext secret" })),
    session_type: Type.Optional(Type.String({ description: "for session: 'ssh' | 'reverse-shell' | 'web-cookie' | ..." })),
    note: Type.Optional(Type.String({ description: "how it was obtained / caveats for reuse" })),
    source_refs: Type.Optional(Type.Array(Type.String(), { description: "ids of the finding/idea/memory this asset came from" })),
})

type RecordAssetInput = Static<typeof RecordAssetParams>

/**
 * record_asset — 把一个结构化作战资产写入跨 solver 共享状态库。
 *
 * 与 report_finding 区别:finding 是"已验证的发现/战果"(进验证流程);asset 是"可被其它 solver
 * 直接复用的结构化资产"(主机/服务/凭据/会话)。目的是让团队不重复发现、凭据高效复用。
 * 引擎会去重合并、广播给同目标其它 solver、并喂给调度层 planner。
 */
export const recordAssetTool = defineTool({
    name: "record_asset",
    label: "Record Battlefield Asset",
    description:
        "Record a structured, reusable battlefield asset (host / service / credential / session) into the shared cross-solver state store. Use this whenever you obtain something other solvers should REUSE rather than re-discover — especially credentials and live access. Reference secret values by name (secret_ref), never paste plaintext. The engine de-dupes, broadcasts to teammates, and feeds it to the scheduler.",
    promptSnippet: "record_asset: register a reusable host/service/credential/session in shared state so teammates don't re-discover it",
    parameters: RecordAssetParams,
    async execute(_toolCallId, params: RecordAssetInput) {
        const details = await requestHostBridge<{ asset_id?: string; created?: boolean; message?: string }>("state_upsert", {
            kind: params.kind,
            label: params.label,
            ...(params.host?.trim() ? { host: params.host.trim() } : {}),
            ...(typeof params.port === "number" ? { port: params.port } : {}),
            ...(params.service?.trim() ? { service: params.service.trim() } : {}),
            ...(params.account?.trim() ? { account: params.account.trim() } : {}),
            ...(params.privilege?.trim() ? { privilege: params.privilege.trim() } : {}),
            ...(params.secret_ref?.trim() ? { secret_ref: params.secret_ref.trim() } : {}),
            ...(params.session_type?.trim() ? { session_type: params.session_type.trim() } : {}),
            ...(params.note?.trim() ? { note: params.note.trim() } : {}),
            ...(params.source_refs && params.source_refs.length > 0 ? { source_refs: params.source_refs } : {}),
        })
        const ref = details.asset_id ? ` (id: ${details.asset_id})` : ""
        const note = details.message?.trim() || (details.created ? "asset recorded to shared state" : "asset merged into shared state")
        return { content: [{ type: "text", text: `${note}${ref}` }], details }
    },
})

export const engagementTools = [getTargetIntelTool, reportFindingTool, recordAssetTool]

export const engagementToolNames = new Set(engagementTools.map((tool) => tool.name))
