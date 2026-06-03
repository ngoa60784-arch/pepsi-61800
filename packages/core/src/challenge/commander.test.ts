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
        // 主线程消息：助手发起 bash 调用 → toolResult 回输出，再发起一次 record_relation。
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
        // 命令本身（不是 JSON 参数）被提取出来。
        expect(text).toContain("nmap -sV 10.0.0.5")
        // 工具输出被带出来。
        expect(text).toContain("22/tcp open  ssh")
        // record_relation 的参数被压成 source--relation-->target。
        expect(text).toContain("Host:10.0.0.5 --exposes--> Service:ssh")
        // 最新推理被附在末尾。
        expect(text).toContain("Let me port-scan the target.")
        // 两次工具调用都计入。
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
        // 只保留最近 2 步（step-3 / step-4），最早的被裁掉。
        expect(text).toContain("last 2 of 5 tool actions")
        expect(text).toContain("echo step-4")
        expect(text).toContain("echo step-3")
        expect(text).not.toContain("echo step-0")
    })
})

describe("commander get_target_overview", () => {
    test("returns derived phase + assets + relations + findings for a target", async () => {
        // 建目标 + 灌入各类共享态。
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
        // 一条 attempt 记录：phase 的 untouched 判定基于 attempts.length===0，有动作才会进入 recon/foothold。
        await manager.appendAttemptLog({ challengeId: "ov-target", solverId: "s1", promptName: "kimi-security", task: "t" })
        // 无 runtime 也应工作（activeSolvers 为空）。
        manager.attachRuntime({ list: () => [] } as never)

        const ov = getTool("get_target_overview")
        const result = (await ov.execute("call-ov-1", { targetId: "ov-target" })) as {
            content: Array<{ text: string }>
            details: { progressPhase: string; stateAssets: string[]; relations: string[] }
        }
        const text = result.content[0].text
        // 有凭据信号 → foothold 阶段。
        expect(result.details.progressPhase).toBe("foothold")
        expect(text).toContain("foothold")
        // 资产 / 图谱 / 凭据事实都进了概览。
        expect(text).toContain("admin@web01")
        expect(text).toContain("Host:web01 --exploitable_via--> Vuln:CVE-1")
        expect(result.details.stateAssets.length).toBeGreaterThan(0)
        expect(result.details.relations.length).toBeGreaterThan(0)
    })
})
