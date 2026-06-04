import { requestHostBridge } from "./host-bridge-client"
import { CHALLENGE_ENV_CHALLENGE_ID } from "./env"
import type { IdeaStatus, MemoryKind } from "./memory"

export interface PromoteMemoryBridgeResult {
    promoted: boolean
    duplicate: boolean
    entry_id?: string
}

export interface PromoteIdeaBridgeResult {
    promoted: boolean
    duplicate: boolean
    idea_id?: string
}

function getChallengeIdFromEnv(): string | undefined {
    const id = process.env[CHALLENGE_ENV_CHALLENGE_ID]?.trim()
    return id || undefined
}

/** Best-effort promotion from solver/observer process via host bridge (no-op when not in challenge mode). */
export async function promoteMemoryToChallengeViaBridge(input: {
    kind: MemoryKind
    content: string
    refs?: string[]
    source?: string
}): Promise<PromoteMemoryBridgeResult> {
    const challengeId = getChallengeIdFromEnv()
    if (!challengeId) return { promoted: false, duplicate: false }
    try {
        return await requestHostBridge<PromoteMemoryBridgeResult>("challenge_promote_memory", {
            kind: input.kind,
            content: input.content,
            refs: input.refs ?? [],
            source: input.source?.trim() || "observer",
        })
    } catch {
        return { promoted: false, duplicate: false }
    }
}

export async function promoteIdeaToChallengeViaBridge(input: {
    content: string
    status: IdeaStatus
    result?: string
    source?: string
}): Promise<PromoteIdeaBridgeResult> {
    const challengeId = getChallengeIdFromEnv()
    if (!challengeId) return { promoted: false, duplicate: false }
    try {
        return await requestHostBridge<PromoteIdeaBridgeResult>("challenge_promote_idea", {
            content: input.content,
            status: input.status,
            result: input.result ?? "",
            source: input.source?.trim() || "observer",
        })
    } catch {
        return { promoted: false, duplicate: false }
    }
}
