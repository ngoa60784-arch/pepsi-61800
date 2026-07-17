import { createAgentSession, defineTool, SessionManager } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { ConfigManager } from "../config/index"
import { CHALLENGE_PLANNER_PROMPT_NAME, OBJECTIVE_VERIFIER_PROMPT_NAME } from "../config/prompts/index"

interface QualificationResult {
    role: "planner" | "solver" | "verifier"
    prompt: string
    model: string
    observerModel?: string
    configured: boolean
    live?: { passed: boolean; latencyMs: number; note: string }
}

const args = process.argv.slice(2)
const live = args.includes("--live")
const promptArg = args.find((arg) => arg.startsWith("--prompt="))?.slice("--prompt=".length)
const config = await ConfigManager.getInstance()
const visiblePrompts = await config.listPrompts()
const hiddenRolePrompts = await Promise.all([
    config.getPrompt(CHALLENGE_PLANNER_PROMPT_NAME),
    config.getPrompt(OBJECTIVE_VERIFIER_PROMPT_NAME),
])
const prompts = [...new Map([...visiblePrompts, ...hiddenRolePrompts.filter((prompt) => prompt !== undefined)].map((prompt) => [prompt.name, prompt])).values()]
    .filter((prompt) => prompt.meta.disabled !== true && (!promptArg || prompt.name === promptArg))
const results: QualificationResult[] = []

for (const prompt of prompts) {
    const result: QualificationResult = {
        role: prompt.name === CHALLENGE_PLANNER_PROMPT_NAME ? "planner" : prompt.name === OBJECTIVE_VERIFIER_PROMPT_NAME ? "verifier" : "solver",
        prompt: prompt.name,
        model: typeof prompt.meta.model === "string" && prompt.meta.model.trim() ? prompt.meta.model.trim() : "<global-default>",
        observerModel: prompt.meta.observerEnabled === true
            ? typeof prompt.meta.observerModel === "string" && prompt.meta.observerModel.trim()
                ? prompt.meta.observerModel.trim()
                : typeof prompt.meta.model === "string" && prompt.meta.model.trim()
                  ? prompt.meta.model.trim()
                  : "<global-default>"
            : undefined,
        configured: true,
    }
    if (live) {
        let submitted: { verdict: string; rationale: string } | undefined
        const probe = defineTool({
            name: "qualification_probe",
            label: "Submit Qualification Probe",
            description: "Submit the required role-qualification verdict.",
            parameters: Type.Object({ verdict: Type.Literal("pass"), rationale: Type.String({ minLength: 1 }) }),
            execute: async (_toolCallId, params) => {
                submitted = params
                return { content: [{ type: "text", text: "qualification recorded" }], details: params }
            },
        })
        const startedAt = Date.now()
        let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined
        try {
            const options = await config.resolvePromptSession(prompt.name)
            if (!options) throw new Error("prompt could not be resolved")
            session = (await createAgentSession({ ...options, tools: [], customTools: [probe], sessionManager: SessionManager.inMemory() })).session
            await session.prompt("Role qualification only. Explain your assigned role, identify one action you must not take outside that role, then call qualification_probe exactly once. Do not perform operational work.")
            result.live = { passed: submitted?.verdict === "pass", latencyMs: Date.now() - startedAt, note: submitted?.rationale ?? "probe tool was not called" }
        } catch (error) {
            result.live = { passed: false, latencyMs: Date.now() - startedAt, note: error instanceof Error ? error.message : String(error) }
        } finally {
            session?.dispose()
        }
    }
    results.push(result)
}

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), mode: live ? "live" : "configuration", results }, null, 2))
if (live && results.some((result) => result.live?.passed !== true)) process.exitCode = 1
