import type { Subprocess } from "bun"
import type { ContainerConfig } from "./types"

/**
 * Execution backend abstraction: decouples where solver processes start from RuntimeManager JSONL-over-stdio bridge.
 *
 * Default: DockerBackend (`docker run` + JSONL RPC on stdin/stdout).
 * P5-A: LocalProcessBackend (`Bun.spawn` local `tch-agent solver rpc`) — stub until FP-06 lands.
 */
export interface SolverLaunchSpec {
    solverId: string
    containerName: string
    /** Env vars injected into solver (paths excluded; backend sets paths per its view) */
    solverEnv: Record<string, string>
    /** Solver binary launch argv (e.g. ["/opt/tch-agent/tch-agent","solver","rpc"]) */
    injectionCmd: string[]
    /** Extra read-only binds (docker host:container) */
    extraBinds: string[]
    /** Host scope file path (optional) */
    hostScopePath?: string
    /** Host solver dir parent (startup/session/workspace) */
    hostBaseDir: string
    hostSessionDir: string
    hostWorkspaceDir: string
}

export type ExecutionBackendKind = "docker" | "local"

export interface ExecutionBackend {
    readonly kind: ExecutionBackendKind
    /** Build and spawn solver child (stdin/stdout/stderr piped) */
    spawn(spec: SolverLaunchSpec): Subprocess<"pipe", "pipe", "pipe">
    /** Stop a solver */
    stop(spec: { solverId: string; containerName: string }): Promise<void>
}

// ──────────────────────────────────────────────────────────────
// Docker backend: same behavior as original inline RuntimeManager logic
// ──────────────────────────────────────────────────────────────

const CONTAINER_RUNTIME_DIR = "/runtime"
const CONTAINER_SESSION_DIR = `${CONTAINER_RUNTIME_DIR}/session`
const CONTAINER_WORKSPACE_DIR = "/root/workspace"
const CONTAINER_SCOPE_PATH = `${CONTAINER_RUNTIME_DIR}/engagement-scope.json`

function buildSolverRpcCommand(baseCmd: string[], solverEnv: Record<string, string>): string[] {
    const args = [...baseCmd]
    for (const [key, value] of Object.entries(solverEnv)) {
        if (!key.trim()) continue
        if (typeof value !== "string" || !value.trim()) continue
        args.push("--env", `${key}=${value}`)
    }
    return args
}

export class DockerBackend implements ExecutionBackend {
    readonly kind = "docker" as const

    constructor(private readonly config: ContainerConfig) {}

    spawn(spec: SolverLaunchSpec): Subprocess<"pipe", "pipe", "pipe"> {
        const args = this.buildLaunchArgv(spec)
        return Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    }

    /** Build full `docker run ...` argv (public for tests). */
    buildLaunchArgv(spec: SolverLaunchSpec): string[] {
        const binds = [
            ...(this.config.binds ?? []),
            `${spec.hostBaseDir}:${CONTAINER_RUNTIME_DIR}`,
            `${spec.hostWorkspaceDir}:${CONTAINER_WORKSPACE_DIR}`,
            ...spec.extraBinds,
        ]

        // Scope file: host path invisible in container; ro-mount to fixed path and rewrite env.
        const containerSolverEnv: Record<string, string> = {
            ...spec.solverEnv,
            TCH_SOLVER_BASE_DIR: CONTAINER_RUNTIME_DIR,
            TCH_SOLVER_SESSION_DIR: CONTAINER_SESSION_DIR,
            TCH_SOLVER_WORKSPACE: CONTAINER_WORKSPACE_DIR,
        }
        if (spec.hostScopePath) {
            binds.push(`${spec.hostScopePath}:${CONTAINER_SCOPE_PATH}:ro`)
            containerSolverEnv.TCH_ENGAGEMENT_SCOPE = CONTAINER_SCOPE_PATH
        }

        const command = buildSolverRpcCommand(spec.injectionCmd, containerSolverEnv)
        return this.buildDockerArgs(spec.containerName, binds, command, CONTAINER_WORKSPACE_DIR)
    }

    async stop(spec: { containerName: string }): Promise<void> {
        try {
            const stop = Bun.spawn(["docker", "stop", spec.containerName], { stdout: "ignore", stderr: "ignore" })
            await stop.exited
        } catch {
            // container may already be stopped
        }
    }

    private buildDockerArgs(name: string, binds: string[], cmd: string[], workdir: string): string[] {
        const args: string[] = [
            "docker",
            "run",
            "-i",
            "--platform",
            "linux/amd64",
            "--network",
            this.config.networkMode ?? "host",
            "--name",
            name,
            "-w",
            workdir,
            "--rm",
        ]
        // Resource caps: prevent one runaway solver (brute/mass scan) from starving host. Omit = unlimited.
        const memory = this.config.memory?.trim()
        if (memory) args.push("--memory", memory)
        if (typeof this.config.cpus === "number" && this.config.cpus > 0) args.push("--cpus", String(this.config.cpus))
        for (const bind of binds) args.push("-v", bind)
        for (const [k, v] of Object.entries(this.config.env ?? {})) args.push("-e", `${k}=${v}`)
        args.push(this.config.image, ...cmd)
        return args
    }
}

/** P5-A placeholder — throws until LocalProcessBackend is implemented. */
export class LocalProcessBackend implements ExecutionBackend {
    readonly kind = "local" as const

    constructor(private readonly _config: ContainerConfig) {}

    spawn(_spec: SolverLaunchSpec): Subprocess<"pipe", "pipe", "pipe"> {
        throw new Error("LocalProcessBackend is not implemented yet (P5-A / FP-06). Set runtime.solverHost=docker for now.")
    }

    async stop(): Promise<void> {
        // no-op stub
    }
}

export function createExecutionBackend(config: ContainerConfig): ExecutionBackend {
    if (config.solverHost === "local") {
        return new LocalProcessBackend(config)
    }
    return new DockerBackend(config)
}
