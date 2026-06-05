import { TCH_AGENT_HOME_DIR } from "../config/index"
import { resolve } from "path"
import type { Message } from "@mariozechner/pi-ai"
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import type { HostBridgeRequestEvent } from "../challenge/host-bridge-types"
import type { RpcCommand } from "../solver/rpc/rpc-types"

export const SOLVERS_DIR = resolve(TCH_AGENT_HOME_DIR, "solvers")
export const ARCHIVE_SOLVERS_DIR = resolve(TCH_AGENT_HOME_DIR, "archive_solvers")

export interface ContainerConfig {
    /** Docker image to use */
    image: string
    /** P5-A — `local` uses Bun.spawn rpc; `docker` (default) uses docker run. */
    solverHost?: "local" | "docker"
    /** P5-B — injected as TCH_EXEC_SURFACE on solver launch. */
    execSurface?: "remote-vps" | "local-host"
    /** Extra environment variables */
    env?: Record<string, string>
    /** Extra volume binds (host:container format) */
    binds?: string[]
    /** Docker network mode */
    networkMode?: "bridge" | "host"
    /** Per-solver container memory cap (docker `--memory`, e.g. "2g"); omit = unlimited */
    memory?: string
    /** Per-solver container CPU cap (docker `--cpus`, e.g. 1.5); omit = unlimited */
    cpus?: number
}

export interface SolverInstance {
    /** Unique solver ID */
    id: string
    /** Docker container ID */
    containerId: string
    /** Container name */
    name: string
    /** Prompt name used to create this solver */
    promptName: string
    /** Model name or id resolved for this solver */
    modelName?: string
    /** Initial task prompt given to the solver */
    task: string
    /** Bound challenge id when launched in challenge mode */
    challengeId?: string
    /** Current status */
    status: "starting" | "running" | "stopping" | "stopped" | "error"
    /** Creation timestamp */
    createdAt: number
    /** Error message if status is "error" */
    error?: string
}

export interface RuntimeMessageThread {
    id: string
    solverId: string
    kind: "main" | "subagent" | "observer"
    label: string
    parentToolCallId?: string
    promptName?: string
    task?: string
    sessionId?: string
    createdAt?: number
    messages: Message[]
}

export interface RuntimeSolverDetails {
    solver: SolverInstance
    threads: RuntimeMessageThread[]
    startup?: unknown
}

export type SolverEventHandler = (solverId: string, event: AgentSessionEvent) => void

export interface HostBridgeHandleContext {
    solverId: string
    action: HostBridgeRequestEvent["action"]
    params: unknown
    getSolverEnvValue: (key: string) => string | undefined
    getSolver?: () => SolverInstance | undefined
    getSolverStartup?: () => Promise<unknown | undefined>
    listSolvers?: () => SolverInstance[]
    sendCommand?: (solverId: string, command: RpcCommand) => void
}

export interface HostBridgeHandleResult {
    handled: boolean
    data?: unknown
}

export interface HostBridgeHandler {
    handle(context: HostBridgeHandleContext): Promise<HostBridgeHandleResult>
}

export function solverDir(solverId: string) {
    return resolve(SOLVERS_DIR, solverId)
}

export function solverSessionDir(solverId: string) {
    return resolve(SOLVERS_DIR, solverId, "session")
}

export function solverWorkspaceDir(solverId: string) {
    return resolve(SOLVERS_DIR, solverId, "workspace")
}

export function solverStartupPath(solverId: string) {
    return resolve(SOLVERS_DIR, solverId, "startup.json")
}
