import type { AgentMessage } from "@mariozechner/pi-agent-core"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { CHALLENGE_ENV_CHALLENGE_ID } from "../../../challenge/env"
import { requestHostBridge } from "../../../challenge/host-bridge-client"

const MAX_CHALLENGE_RETRY_ATTEMPTS = 10
const CHALLENGE_CONTINUATION_MESSAGE =
    "Continue the current engagement. Don't repeat steps you've already completed; build on existing context and keep pressing. The objective isn't done until you've achieved control of the target (shell / RCE / the stated goal) and recorded it — if there are further in-scope assets or escalation paths, keep going."
const CHALLENGE_CUSTOM_MESSAGE_TYPE = "challenge-continuation"
const BASE_CHALLENGE_DELAY_MS = 1000
const MAX_CHALLENGE_DELAY_MS = 10000

export function isChallengeMode(): boolean {
    const challengeId = process.env[CHALLENGE_ENV_CHALLENGE_ID]?.trim()
    return Boolean(challengeId)
}

export function buildChallengeExtensionAppendPrompt(): string {
    return [
        "## Engagement Coordination Contract",
        "- You will keep receiving system-sync or collaboration-sync messages. They are coordination signals injected by the engagement extension / host bridge — not noise.",
        "- These syncs may come from: updated target intel, another solver having verified a finding, or the continuation mechanism.",
        "- When a new sync arrives, if it affects your attack route, rules out a conclusion, or changes division of work, refresh `memory_list` / `idea_list` first, then decide your next step.",
        "- Collaboration syncs and observer suggestions are high-value references, not absolute truth; don't abandon a live tested lead just because someone else asserted something.",
        "- If a sync, the engagement background injected at task start, and your own tested results conflict, re-verify the key point of disagreement rather than blindly obeying either side.",
        "- An `idea` is an unverified attack hypothesis, not a fact. The observer sidecar maintains your idea board; you read, verify, and advance it.",
        "- `memory` holds durable facts, evidence, failure boundaries, intel, constraints. Use `memory_list` to see it at runtime.",
        "- When switching routes, repeating an attack vector, or after a new collaboration sync, check `idea_list` / `idea_search` first; if you suspect you forgot a prior conclusion, check `memory_list`.",
        "- If your current push already aligns with a `testing` / `verified` main line, don't mechanically switch just to respond to a sync — keep advancing the effective line.",
        "- If another solver already broke a given route, don't repeat it — pivot to remaining attack surface or escalation.",
    ].join("\n")
}

function getAgentEndError(messages: AgentMessage[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]
        if (message.role !== "assistant") continue
        if (message.stopReason !== "error") return
        return message.errorMessage ?? "Agent ended with an unknown error"
    }

    return
}

function getChallengeDelayMs(attempt: number): number {
    return Math.min(BASE_CHALLENGE_DELAY_MS * 2 ** Math.max(attempt - 1, 0), MAX_CHALLENGE_DELAY_MS)
}

async function isChallengeCompletedByHostBridge(): Promise<boolean> {
    try {
        const result = await requestHostBridge<{ is_completed: boolean }>("challenge_is_completed", {})
        return result.is_completed === true
    } catch {
        return false
    }
}

export function attachChallengeContinuation(pi: ExtensionAPI): void {
    let consecutiveErrors = 0

    pi.on("agent_end", async (event) => {
        if (await isChallengeCompletedByHostBridge()) {
            return
        }

        const errorMessage = getAgentEndError(event.messages)
        if (errorMessage) {
            consecutiveErrors += 1
            if (consecutiveErrors > MAX_CHALLENGE_RETRY_ATTEMPTS) return
            await Bun.sleep(getChallengeDelayMs(consecutiveErrors))
        } else {
            consecutiveErrors = 0
        }

        setImmediate(() => {
            pi.sendMessage(
                {
                    customType: CHALLENGE_CUSTOM_MESSAGE_TYPE,
                    content: [{ type: "text", text: CHALLENGE_CONTINUATION_MESSAGE }],
                    display: false,
                    details: undefined,
                },
                { triggerTurn: true },
            )
        })
    })
}
