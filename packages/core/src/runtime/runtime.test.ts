import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import { getAgentEndError, hashDockerfileContent, RuntimeManager } from "./runtime"
import { CHALLENGE_ENV_CHALLENGE_ID } from "../challenge/env"
import { ChallengeManager } from "../challenge/manager"
import { createChallengeHostBridgeHandler } from "../challenge/host-bridge-handler"
import type { ConfigManager } from "../config/index"
import { solverDir } from "./types"

const tempDirs: string[] = []

afterEach(async () => {
    delete process.env.TCH_CHALLENGE_DIR
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop()
        if (!dir) continue
        await rm(dir, { recursive: true, force: true })
    }
})

async function createRuntimeManager(): Promise<{ runtime: RuntimeManager; challengeManager: ChallengeManager }> {
    const challengeDir = await mkdtemp(resolve(tmpdir(), "tch-runtime-challenge-"))
    tempDirs.push(challengeDir)
    process.env.TCH_CHALLENGE_DIR = challengeDir
    const config = {
        getHostSettings: async () => ({ runtime: {}, challenge: {}, planner: {} }),
    } as unknown as ConfigManager
    const challengeManager = new ChallengeManager(config)
    const runtime = new RuntimeManager(config, [createChallengeHostBridgeHandler(challengeManager)])
    return { runtime, challengeManager }
}

describe("getAgentEndError", () => {
    test("returns assistant error from agent_end", () => {
        const event = {
            type: "agent_end",
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "hello" }],
                    timestamp: 1,
                },
                {
                    role: "assistant",
                    content: [],
                    stopReason: "error",
                    errorMessage: "402 Insufficient Balance",
                    timestamp: 2,
                },
            ],
        } as unknown as AgentSessionEvent

        expect(getAgentEndError(event)).toBe("402 Insufficient Balance")
    })

    test("ignores successful agent_end", () => {
        const event = {
            type: "agent_end",
            messages: [
                {
                    role: "assistant",
                    content: [{ type: "text", text: "done" }],
                    stopReason: "end_turn",
                    timestamp: 1,
                },
            ],
        } as unknown as AgentSessionEvent

        expect(getAgentEndError(event)).toBeUndefined()
    })
})

describe("hashDockerfileContent", () => {
    test("returns stable hash for identical content", () => {
        const content = "FROM kali\nRUN echo test\n"

        expect(hashDockerfileContent(content)).toBe(hashDockerfileContent(content))
    })

    test("returns different hashes for different content", () => {
        expect(hashDockerfileContent("FROM kali\n")).not.toBe(hashDockerfileContent("FROM kali\nRUN echo test\n"))
    })
})

describe("RuntimeManager host bridge", () => {
    test("getDetails restores subagent parent tool call id from startup snapshot", async () => {
        const { runtime } = await createRuntimeManager()
        const solverId = `solver-${Date.now()}`
        const baseDir = solverDir(solverId)
        tempDirs.push(baseDir)
        await rm(baseDir, { recursive: true, force: true })
        await mkdir(resolve(baseDir, "session"), { recursive: true })
        await Bun.write(
            resolve(baseDir, "startup.json"),
            JSON.stringify({
                createdAt: 1,
                init: { promptName: "pentest-orchestrator", task: "solve" },
                prompt: { name: "pentest-orchestrator", meta: {}, content: "main" },
                paths: { solverDir: baseDir, sessionDir: resolve(baseDir, "session"), workspaceDir: resolve(baseDir, "workspace") },
                sessionOptions: {},
            }),
        )
        await Bun.write(resolve(baseDir, "session", "0001.jsonl"), "")
        const subagentDir = resolve(baseDir, "workspace", ".subagents", "recon-subagent:1")
        await mkdir(resolve(subagentDir, "session"), { recursive: true })
        await Bun.write(
            resolve(subagentDir, "startup.json"),
            JSON.stringify({
                createdAt: 2,
                init: { promptName: "recon", task: "scan", parentToolCallId: "subagent:1", step: 1 },
                prompt: { name: "recon", meta: {}, content: "sub" },
                paths: { subagentDir, sessionDir: resolve(subagentDir, "session"), workspaceDir: resolve(baseDir, "workspace") },
                sessionOptions: {},
            }),
        )
        await Bun.write(resolve(subagentDir, "session", "0001.jsonl"), "")

        const details = await runtime.getDetails(solverId)
        const subagentThread = details?.threads.find((thread) => thread.kind === "subagent")

        expect(subagentThread?.parentToolCallId).toBe("subagent:1")
        expect(subagentThread?.promptName).toBe("recon")
        expect(subagentThread?.task).toBe("scan")
    })

    test("challenge_get_hint returns empty intel in engagement mode (no remote fetch, no broadcast)", async () => {
        const { runtime, challengeManager } = await createRuntimeManager()
        const getHint = mock(async () => {
            throw new Error("should not fetch remote hint")
        })
        const sendCommand = mock(() => {})

        ;(challengeManager as unknown as { getHint: typeof getHint }).getHint = getHint
        ;(runtime as unknown as { sendCommand: typeof sendCommand }).sendCommand = sendCommand
        ;(runtime as unknown as { solverEnvs: Map<string, Record<string, string>> }).solverEnvs.set("solver-a", {
            [CHALLENGE_ENV_CHALLENGE_ID]: "web-001",
        })

        const data = await (
            runtime as unknown as {
                executeHostBridgeAction: (solverId: string, action: string, params: unknown) => Promise<Record<string, unknown>>
            }
        ).executeHostBridgeAction("solver-a", "challenge_get_hint", {})

        expect(getHint).not.toHaveBeenCalled()
        expect(sendCommand).not.toHaveBeenCalled()
        expect(data).toEqual({ code: "web-001", hint_content: null })
    })

    test("report_finding records objective and broadcasts to same-target solvers", async () => {
        const { runtime, challengeManager } = await createRuntimeManager()
        const recordEngagementObjective = mock(async () => ({ id: "submission-1" }))
        const listMemory = mock(async () => [])
        const listIdeas = mock(async () => [])
        const sendCommand = mock(() => {})

        ;(challengeManager as unknown as { recordEngagementObjective: typeof recordEngagementObjective }).recordEngagementObjective =
            recordEngagementObjective
        ;(challengeManager as unknown as { listMemory: typeof listMemory }).listMemory = listMemory
        ;(challengeManager as unknown as { listIdeas: typeof listIdeas }).listIdeas = listIdeas
        ;(runtime as unknown as { sendCommand: typeof sendCommand }).sendCommand = sendCommand
        ;(runtime as unknown as { solvers: Map<string, unknown> }).solvers.set("solver-a", {
            id: "solver-a",
            containerId: "solver-a",
            name: "solver-a",
            promptName: "prompt-a",
            task: "test",
            challengeId: "web-001",
            status: "running",
            createdAt: Date.now(),
        })
        ;(runtime as unknown as { solvers: Map<string, unknown> }).solvers.set("solver-b", {
            id: "solver-b",
            containerId: "solver-b",
            name: "solver-b",
            promptName: "prompt-b",
            task: "test",
            challengeId: "web-001",
            status: "running",
            createdAt: Date.now(),
        })
        ;(runtime as unknown as { solverEnvs: Map<string, Record<string, string>> }).solverEnvs.set("solver-a", {
            [CHALLENGE_ENV_CHALLENGE_ID]: "web-001",
        })

        const data = await (
            runtime as unknown as {
                executeHostBridgeAction: (solverId: string, action: string, params: unknown) => Promise<Record<string, unknown>>
            }
        ).executeHostBridgeAction("solver-a", "challenge_submit_flag", {
            flag: "creds: admin:hunter2",
            writeup: "upload polyglot bypass -> webshell -> dump creds",
        })

        expect(recordEngagementObjective).toHaveBeenCalledTimes(1)
        // 广播给同范围的另一个运行中 solver（solver-b），不含自己。
        expect(sendCommand).toHaveBeenCalledTimes(1)
        expect((sendCommand.mock.calls[0] as unknown[])[0]).toBe("solver-b")
        expect(data.recorded).toBe(true)
        expect(data.is_completed).toBe(false)
    })

    test("challenge_is_completed always returns false in engagement mode", async () => {
        const { runtime } = await createRuntimeManager()
        ;(runtime as unknown as { solverEnvs: Map<string, Record<string, string>> }).solverEnvs.set("solver-a", {
            [CHALLENGE_ENV_CHALLENGE_ID]: "web-001",
        })

        const data = await (
            runtime as unknown as {
                executeHostBridgeAction: (solverId: string, action: string, params: unknown) => Promise<Record<string, unknown>>
            }
        ).executeHostBridgeAction("solver-a", "challenge_is_completed", {})

        expect(data.challenge_id).toBe("web-001")
        expect(data.is_completed).toBe(false)
    })
})
