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
 * report_finding — record a verified finding (engagement / exercise mode).
 *
 * Does not call out to any remote scoring service; findings are written to the local findings/submission log.
 * objective_achieved=true means the primary objective has been met → the engine stops all solvers for that target and the planner stops dispatching more.
 *
 * Note: the internal host-bridge action still uses the stable wire string "challenge_submit_flag",
 * to avoid changing the RPC contract and breaking historical log matching; the model only sees the report_finding tool name.
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
 * get_target_intel — read the locally cached intel for the current target.
 *
 * Engagement mode has no hint oracle: usually returns empty, prompting the model to rely on active recon.
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
 * record_asset — write a structured battlefield asset into the cross-solver shared state store.
 *
 * Difference from report_finding: a finding is a "verified discovery/result" (enters the verification flow); an asset is a "structured
 * asset other solvers can reuse directly" (host/service/credential/session). The goal is to keep the team from re-discovering and to reuse credentials efficiently.
 * The engine de-dupes and merges, broadcasts to other solvers on the same target, and feeds it to the scheduling-layer planner.
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

const RecordRelationParams = Type.Object({
    source: Type.String({
        description: "The entity the edge starts FROM. Use a typed label like 'Host:10.0.0.5', 'Subnet:10.0.0.0/24', 'Cred:admin@web01', 'Service:http://10.0.0.5:8080'.",
    }),
    relation: Type.String({
        description: "How source connects to target, e.g. 'routes_to', 'contains', 'exploitable_via', 'owns_credential', 'pivots_to', 'authenticates_to', 'grants_access_to'.",
    }),
    target: Type.String({
        description: "The entity the edge points TO. Same typed-label convention as source, e.g. 'Subnet:10.0.0.0/24', 'Vuln:CVE-2023-1234', 'Shell:root@web01'.",
    }),
    note: Type.Optional(Type.String({ description: "How this edge was established / evidence / caveats." })),
    source_ref: Type.Optional(Type.String({ description: "Optional id of the finding/memory/asset this edge was derived from." })),
})

type RecordRelationInput = Static<typeof RecordRelationParams>

/**
 * record_relation — write an edge into the cross-solver shared attack graph.
 *
 * Complements record_asset: an asset is "the entity itself" (host/service/credential/session); a relation is "how entities connect"
 * (Host routes_to Subnet, Cred owns Host, Host exploitable_via Vuln). Connecting these edges lets you use
 * find_attack_path to compute a viable route from foothold to target, without re-deriving it every time. Internally it de-dupes by triple and broadcasts to teammates after writing.
 */
export const recordRelationTool = defineTool({
    name: "record_relation",
    label: "Record Attack-Graph Edge",
    description:
        "Record a directed edge in the shared cross-solver attack graph: source --relation--> target (e.g. 'Host:10.0.0.5' --exploitable_via--> 'Vuln:CVE-2023-1234', or 'Cred:admin@web01' --grants_access_to--> 'Host:10.0.0.9'). Use typed labels (Host:/Subnet:/Cred:/Service:/Vuln:/Shell:). Map edges as you discover them so the team can chain them into an attack path with find_attack_path instead of re-deriving the route. The engine de-dupes identical triples and broadcasts new edges to teammates.",
    promptSnippet: "record_relation: add a source--relation-->target edge to the shared attack graph so routes can be chained with find_attack_path",
    parameters: RecordRelationParams,
    async execute(_toolCallId, params: RecordRelationInput) {
        const details = await requestHostBridge<{ relation_id?: string; message?: string }>("relation_upsert", {
            source: params.source,
            relation: params.relation,
            target: params.target,
            ...(params.note?.trim() ? { note: params.note.trim() } : {}),
            ...(params.source_ref?.trim() ? { source_ref: params.source_ref.trim() } : {}),
        })
        const ref = details.relation_id ? ` (id: ${details.relation_id})` : ""
        const note = details.message?.trim() || "attack-graph edge recorded"
        return { content: [{ type: "text", text: `${note}${ref}` }], details }
    },
})

const QueryRelationsParams = Type.Object({
    source: Type.Optional(Type.String({ description: "Case-insensitive substring filter on the edge source. Omit to match any." })),
    relation: Type.Optional(Type.String({ description: "Case-insensitive substring filter on the relation type. Omit to match any." })),
    target: Type.Optional(Type.String({ description: "Case-insensitive substring filter on the edge target. Omit to match any." })),
})

type QueryRelationsInput = Static<typeof QueryRelationsParams>

interface RelationEdge {
    id: string
    source: string
    relation: string
    target: string
    note: string
}

/**
 * query_relations — query the attack graph filtered by source/relation/target substrings. All empty = return the whole graph.
 */
export const queryRelationsTool = defineTool({
    name: "query_relations",
    label: "Query Attack Graph",
    description:
        "List edges in the shared attack graph, optionally filtered by case-insensitive substring on source / relation / target. Call with no filters to dump the whole graph. Use this to see what the team already mapped (e.g. all edges touching a host, or all 'owns_credential' edges) before re-enumerating.",
    promptSnippet: "query_relations: list/filter the shared attack-graph edges to see what's already mapped",
    parameters: QueryRelationsParams,
    async execute(_toolCallId, params: QueryRelationsInput) {
        const details = await requestHostBridge<{ count?: number; relations?: RelationEdge[] }>("relation_query", {
            ...(params.source?.trim() ? { source: params.source.trim() } : {}),
            ...(params.relation?.trim() ? { relation: params.relation.trim() } : {}),
            ...(params.target?.trim() ? { target: params.target.trim() } : {}),
        })
        const relations = details.relations ?? []
        const body = relations.length > 0 ? relations.map((rel) => `- ${rel.source} --${rel.relation}--> ${rel.target}${rel.note ? `  (${rel.note})` : ""}`).join("\n") : "no matching edges in the attack graph"
        return { content: [{ type: "text", text: `attack-graph edges (${relations.length}):\n${body}` }], details }
    },
})

const FindAttackPathParams = Type.Object({
    start: Type.String({ description: "Start node label, e.g. your current foothold 'Host:10.0.0.5' or 'Cred:admin@web01'." }),
    end: Type.String({ description: "Goal node label, e.g. 'Shell:root@dc01' or 'Host:10.0.0.99'." }),
})

type FindAttackPathInput = Static<typeof FindAttackPathParams>

interface PathStep {
    source: string
    relation: string
    target: string
    note: string
}

/**
 * find_attack_path — compute the shortest viable path from start→end in the shared attack graph (BFS, directed).
 *
 * This is the core value of the graph: connecting scattered edges into a concrete "foothold to target" route, so each solver doesn't have to re-derive it.
 */
export const findAttackPathTool = defineTool({
    name: "find_attack_path",
    label: "Find Attack Path",
    description:
        "Compute the shortest directed path between two nodes in the shared attack graph (e.g. from your current foothold 'Host:10.0.0.5' to goal 'Shell:root@dc01'). Returns the chain of edges to traverse, or none if the mapped graph has no route yet. Use this to turn scattered edges other solvers recorded into a concrete plan before brute-forcing a fresh route.",
    promptSnippet: "find_attack_path: compute the shortest chain of edges from a start node to a goal node in the shared attack graph",
    parameters: FindAttackPathParams,
    async execute(_toolCallId, params: FindAttackPathInput) {
        const details = await requestHostBridge<{ found?: boolean; hops?: number; path?: PathStep[] }>("relation_path", {
            start: params.start,
            end: params.end,
        })
        if (!details.found) {
            return {
                content: [{ type: "text", text: `no mapped path from ${params.start} to ${params.end} in the shared attack graph; map more edges with record_relation or find a route by hand` }],
                details,
            }
        }
        const steps = details.path ?? []
        const body = steps.map((step, index) => `${index + 1}. ${step.source} --${step.relation}--> ${step.target}${step.note ? `  (${step.note})` : ""}`).join("\n")
        return { content: [{ type: "text", text: `attack path (${steps.length} hop${steps.length === 1 ? "" : "s"}):\n${body}` }], details }
    },
})

export const relationTools = [recordRelationTool, queryRelationsTool, findAttackPathTool]

export const allEngagementTools = [...engagementTools, ...relationTools]

export const engagementToolNames = new Set(allEngagementTools.map((tool) => tool.name))
