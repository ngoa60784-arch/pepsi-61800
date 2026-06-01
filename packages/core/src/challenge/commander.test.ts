import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import type { ConfigManager } from "../config/index"
import { CHALLENGE_ENV_DIR, ENGAGEMENT_ENV_MODE } from "./env"
import { ChallengeManager } from "./manager"
import { CommanderManager } from "./commander"

type LooseTool = { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }

let challengeDir: string
let manager: ChallengeManager
let commander: CommanderManager

beforeEach(async () => {
    challengeDir = await mkdtemp(resolve(tmpdir(), "tch-commander-test-"))
    process.env[CHALLENGE_ENV_DIR] = challengeDir
    process.env[ENGAGEMENT_ENV_MODE] = "1"
    const config = {
        getHostSettings: async () => ({ runtime: {}, challenge: { mockEnabled: true }, planner: {} }),
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

        // 资产进了结构化状态库,跨 solver 可复用。
        const assets = await manager.listStateAssets("acme")
        expect(assets).toHaveLength(2)
        expect(assets.some((a) => a.kind === "credential" && a.account === "admin" && a.secretRef === "doc:cred-1")).toBe(true)
        expect(assets.some((a) => a.kind === "session" && a.sessionType === "reverse-shell")).toBe(true)

        // 事实进 memory(fact),死路线进 memory(failure)。
        const memory = await manager.listMemory("acme")
        expect(memory.filter((m) => m.kind === "fact")).toHaveLength(2)
        expect(memory.filter((m) => m.kind === "failure")).toHaveLength(2)
        expect(memory.some((m) => m.kind === "failure" && m.content.includes("WAF blocks"))).toBe(true)
        expect(memory.every((m) => m.source === "operator-import")).toBe(true)

        // 待测假设进 ideas(pending)。
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
