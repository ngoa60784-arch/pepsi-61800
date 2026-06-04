import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import type { ConfigManager } from "../config/index"
import { CHALLENGE_ENV_DIR, ENGAGEMENT_ENV_MODE } from "./env"
import { ChallengeManager } from "./manager"
import {
    buildCommanderSessionPrompt,
    CommanderManager,
    displayCommanderUserMessage,
    OPERATOR_UPLOAD_BLOCK_BEGIN,
    resolveCommanderSessionPath,
} from "./commander"

type LooseTool = { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }

let challengeDir: string
let manager: ChallengeManager
let commander: CommanderManager

beforeEach(async () => {
    challengeDir = await mkdtemp(resolve(tmpdir(), "tch-commander-test-"))
    process.env[CHALLENGE_ENV_DIR] = challengeDir
    process.env[ENGAGEMENT_ENV_MODE] = "1"
    const config = {
        getHostSettings: async () => ({ runtime: {}, challenge: {}, planner: {} }),
        listModelPrefs: async () => [],
    } as unknown as ConfigManager
    manager = new ChallengeManager(config)
    commander = new CommanderManager(config, manager)
})

afterEach(async () => {
    delete process.env[CHALLENGE_ENV_DIR]
    delete process.env[ENGAGEMENT_ENV_MODE]
    await rm(challengeDir, { recursive: true, force: true })
})

function getTool(name: string): LooseTool {
    const tools = (commander as unknown as { createCommanderTools: () => LooseTool[] }).createCommanderTools()
    const tool = tools.find((item) => item.name === name)
    if (!tool) throw new Error(`tool ${name} not found`)
    return tool
}

describe("commander import_findings", () => {
    test("imports a half-done pentest doc into shared state (assets/facts/deadends/ideas)", async () => {
        const importFindings = getTool("import_findings")
        const result = (await importFindings.execute("call-1", {
            targetId: "acme",
            assets: [
                { kind: "credential", label: "admin@acme", host: "10.0.0.5", account: "admin", privilege: "admin", secret_ref: "doc:cred-1" },
                { kind: "session", label: "web shell on web01", host: "10.0.0.5", session_type: "reverse-shell", privilege: "www-data" },
            ],
            facts: ["app is Laravel 9 behind cloudflare WAF", "config disclosure leaked Redis creds"],
            deadends: ["WAF blocks all system()-style command injection", "login SQLi parameterized, dead"],
            ideas: ["try SSTI in blade template name param", "use leaked Redis creds for SSRF->RCE"],
        } as never)) as { details: { assets: number; facts: number; deadends: number; ideas: number } }

        expect(result.details).toEqual({ assets: 2, facts: 2, deadends: 2, ideas: 2 })

        // Assets land in the structured state store, reusable across solvers.
        const assets = await manager.listStateAssets("acme")
        expect(assets).toHaveLength(2)
        expect(assets.some((a) => a.kind === "credential" && a.account === "admin" && a.secretRef === "doc:cred-1")).toBe(true)
        expect(assets.some((a) => a.kind === "session" && a.sessionType === "reverse-shell")).toBe(true)

        // Facts go into memory(fact), dead-ends go into memory(failure).
        const memory = await manager.listMemory("acme")
        expect(memory.filter((m) => m.kind === "fact")).toHaveLength(2)
        expect(memory.filter((m) => m.kind === "failure")).toHaveLength(2)
        expect(memory.some((m) => m.kind === "failure" && m.content.includes("WAF blocks"))).toBe(true)
        expect(memory.every((m) => m.source === "operator-import")).toBe(true)

        // Hypotheses to test go into ideas(pending).
        const ideas = await manager.listIdeas("acme")
        expect(ideas).toHaveLength(2)
        expect(ideas.every((i) => i.status === "pending")).toBe(true)
        expect(ideas.some((i) => i.content.includes("SSTI"))).toBe(true)
    })

    test("partial import: only ideas, others omitted", async () => {
        const importFindings = getTool("import_findings")
        const result = (await importFindings.execute("call-2", {
            targetId: "beta",
            ideas: ["enumerate /api/v2 endpoints"],
        } as never)) as { details: { assets: number; facts: number; deadends: number; ideas: number } }
        expect(result.details).toEqual({ assets: 0, facts: 0, deadends: 0, ideas: 1 })
        expect(await manager.listStateAssets("beta")).toHaveLength(0)
        expect(await manager.listIdeas("beta")).toHaveLength(1)
    })

    test("blank entries are skipped", async () => {
        const importFindings = getTool("import_findings")
        const result = (await importFindings.execute("call-3", {
            targetId: "gamma",
            facts: ["  ", "real fact"],
            assets: [{ kind: "host", label: "  " }],
        } as never)) as { details: { assets: number; facts: number } }
        expect(result.details.facts).toBe(1)
        expect(result.details.assets).toBe(0)
    })
})

describe("commander get_solver_trace", () => {
    function attachMockRuntimeWithThread(messages: unknown[]) {
        const runtime = {
            getDetails: async (solverId: string) => ({
                solver: { id: solverId, challengeId: "tgt-1", status: "running" as const, promptName: "kimi-security", task: "", containerId: "c", name: "n", createdAt: 0 },
                threads: [{ id: `${solverId}:main`, solverId, kind: "main" as const, label: "Main", messages }],
                startup: undefined,
            }),
        }
        manager.attachRuntime(runtime as never)
    }

    test("pairs assistant tool calls with their tool results into a readable trace (commands + output)", async () => {
        // Main-thread messages: the assistant fires a bash call → toolResult returns output, then fires a record_relation.
        attachMockRuntimeWithThread([
            {
                role: "assistant",
                content: [
                    { type: "text", text: "Let me port-scan the target." },
                    { type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "nmap -sV 10.0.0.5" } },
                ],
            },
            {
                role: "toolResult",
                toolCallId: "tc-1",
                toolName: "bash",
                content: [{ type: "text", text: "PORT   STATE SERVICE\n22/tcp open  ssh\n80/tcp open  http" }],
                isError: false,
            },
            {
                role: "assistant",
                content: [{ type: "toolCall", id: "tc-2", name: "record_relation", arguments: { source: "Host:10.0.0.5", relation: "exposes", target: "Service:ssh" } }],
            },
        ])

        const trace = getTool("get_solver_trace")
        const result = (await trace.execute("call-trace-1", { solverId: "solver-x" })) as { content: Array<{ text: string }>; details: { found: boolean } }
        const text = result.content[0].text

        expect(result.details.found).toBe(true)
        // The command itself (not the JSON args) is extracted.
        expect(text).toContain("nmap -sV 10.0.0.5")
        // The tool output is surfaced.
        expect(text).toContain("22/tcp open  ssh")
        // record_relation's args are collapsed into source--relation-->target.
        expect(text).toContain("Host:10.0.0.5 --exposes--> Service:ssh")
        // The latest reasoning is appended at the end.
        expect(text).toContain("Let me port-scan the target.")
        // Both tool calls are counted.
        expect(text).toContain("2 of 2 tool actions")
    })

    test("returns found:false for an unknown solver id", async () => {
        attachMockRuntimeWithThread([])
        const runtime = { getDetails: async () => undefined }
        manager.attachRuntime(runtime as never)
        const trace = getTool("get_solver_trace")
        const result = (await trace.execute("call-trace-2", { solverId: "nope" })) as { content: Array<{ text: string }>; details: { found: boolean } }
        expect(result.details.found).toBe(false)
        expect(result.content[0].text).toContain("no solver found")
    })

    test("limit caps the number of returned steps", async () => {
        const messages = Array.from({ length: 5 }, (_, i) => ({
            role: "assistant",
            content: [{ type: "toolCall", id: `tc-${i}`, name: "bash", arguments: { command: `echo step-${i}` } }],
        }))
        attachMockRuntimeWithThread(messages)
        const trace = getTool("get_solver_trace")
        const result = (await trace.execute("call-trace-3", { solverId: "solver-y", limit: 2 })) as { content: Array<{ text: string }> }
        const text = result.content[0].text
        // Only the last 2 steps are kept (step-3 / step-4); the earliest are trimmed.
        expect(text).toContain("last 2 of 5 tool actions")
        expect(text).toContain("echo step-4")
        expect(text).toContain("echo step-3")
        expect(text).not.toContain("echo step-0")
    })
})

describe("commander get_target_overview", () => {
    test("returns derived phase + assets + relations + findings for a target", async () => {
        // Create the target + seed various kinds of shared state.
        await manager.createChallenge({
            id: "ov-target",
            title: "ov-target",
            difficulty: "-",
            description: "",
            level: 0,
            total_score: 0,
            total_got_score: 0,
            flag_count: 0,
            flag_got_count: 0,
            hint_viewed: false,
            hint_content: null,
            instance_status: "running",
            entrypoint: ["http://t"],
            flags: [],
        })
        await manager.appendMemory({ challengeId: "ov-target", kind: "credential", content: "admin:Pass123 on web01", source: "test" })
        await manager.upsertStateAsset("ov-target", { kind: "credential", label: "admin@web01", account: "admin", secretRef: "finding:x" })
        await manager.appendRelation({ challengeId: "ov-target", source: "Host:web01", relation: "exploitable_via", target: "Vuln:CVE-1" })
        // Note: no attempt logs. A credential foothold should make phase=foothold (rather than being overridden by untouched) —
        // this is exactly what fix #4 addresses: substantive progress takes priority over the attempt-count-based untouched verdict.
        // Should also work with no runtime (activeSolvers empty).
        manager.attachRuntime({ list: () => [] } as never)

        const ov = getTool("get_target_overview")
        const result = (await ov.execute("call-ov-1", { targetId: "ov-target" })) as {
            content: Array<{ text: string }>
            details: { progressPhase: string; stateAssets: string[]; relations: string[] }
        }
        const text = result.content[0].text
        // Credential signal present → foothold phase.
        expect(result.details.progressPhase).toBe("foothold")
        expect(text).toContain("foothold")
        // Assets / graph / credential facts all made it into the overview.
        expect(text).toContain("admin@web01")
        expect(text).toContain("Host:web01 --exploitable_via--> Vuln:CVE-1")
        expect(result.details.stateAssets.length).toBeGreaterThan(0)
        expect(result.details.relations.length).toBeGreaterThan(0)
    })
})

describe("commander document upload prompt", () => {
    test("session prompt includes full upload body for the agent", () => {
        const prompt = buildCommanderSessionPrompt("重点看 SSRF", { name: "notes.md", content: "10.0.0.1 got shell" })
        expect(prompt).toContain("重点看 SSRF")
        expect(prompt).toContain(OPERATOR_UPLOAD_BLOCK_BEGIN)
        expect(prompt).toContain("10.0.0.1 got shell")
        expect(prompt).toContain("notes.md")
    })

    test("display strips upload block for UI and rollback", () => {
        const prompt = buildCommanderSessionPrompt("", { name: "log.txt", content: "secret payload" })
        expect(displayCommanderUserMessage(prompt)).toBe("请处理我上传的渗透记录文档。")
        expect(displayCommanderUserMessage("hello only")).toBe("hello only")
    })
})

describe("commander sessions", () => {
    test("resolveCommanderSessionPath rejects paths outside commander-session", () => {
        expect(() => resolveCommanderSessionPath("/etc/passwd")).toThrow("invalid commander session path")
        expect(() => resolveCommanderSessionPath("../../../etc/passwd.jsonl")).toThrow("invalid commander session path")
    })

    test("deleteSession rejects invalid path without touching files", async () => {
        await expect(commander.deleteSession("/etc/passwd")).rejects.toThrow("invalid commander session path")
    })
})
