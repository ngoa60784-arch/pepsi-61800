import type { Subprocess } from "bun"
import { DEFAULT_CONFIG_DIR } from "../config/index"
import { resolveBuiltinSkillsDir, TCH_BUILTIN_SKILLS_ENV } from "../config/skills/index"
import { resolveMcpDir, SOLVER_MCP_MOUNT, TCH_MCP_DIR_ENV } from "../config/mcp/paths"
import type { ContainerConfig } from "./types"

/** Execution backend: local `tch-agent solver rpc` child with JSONL over stdin/stdout. */
export interface SolverLaunchSpec {
    solverId: string
    containerName: string
    /** Env vars injected into solver (paths excluded; backend sets paths per its view) */
    solverEnv: Record<string, string>
    /** Solver binary launch argv (e.g. ["/usr/bin/tch-agent","solver","rpc"]) */
    injectionCmd: string[]
    /** Host scope file path (optional) */
    hostScopePath?: string
    /** Host solver dir parent (startup/session/workspace) */
    hostBaseDir: string
    hostSessionDir: string
    hostWorkspaceDir: string
}

export type ExecutionBackendKind = "local"

export interface ExecutionBackend {
    readonly kind: ExecutionBackendKind
    /** Build and spawn solver child (stdin/stdout/stderr piped) */
    spawn(spec: SolverLaunchSpec): Subprocess<"pipe", "pipe", "pipe">
    /** Stop a solver */
    stop(spec: { solverId: string; containerName: string }): Promise<void>
}

function buildLocalSolverEnv(spec: SolverLaunchSpec): Record<string, string> {
    const baseEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === "string") baseEnv[key] = value
    }
    const env: Record<string, string> = {
        ...baseEnv,
        ...spec.solverEnv,
        TCH_SOLVER_BASE_DIR: spec.hostBaseDir,
        TCH_SOLVER_SESSION_DIR: spec.hostSessionDir,
        TCH_SOLVER_WORKSPACE: spec.hostWorkspaceDir,
        [TCH_BUILTIN_SKILLS_ENV]: resolveBuiltinSkillsDir(DEFAULT_CONFIG_DIR),
    }
    if (spec.hostScopePath) {
        env.TCH_ENGAGEMENT_SCOPE = spec.hostScopePath
    }
    env[TCH_MCP_DIR_ENV] = resolveMcpDir(DEFAULT_CONFIG_DIR)
    env.TCH_SOLVER_MCP_MOUNT = SOLVER_MCP_MOUNT
    return env
}

export class LocalProcessBackend implements ExecutionBackend {
    readonly kind = "local" as const
    private readonly procs = new Map<string, Subprocess<"pipe", "pipe", "pipe">>()

    constructor(private readonly _config: ContainerConfig) {}

    /** Build spawn argv + env (public for tests). */
    buildLaunchOptions(spec: SolverLaunchSpec): { cmd: string[]; cwd: string; env: Record<string, string> } {
        return {
            cmd: [...spec.injectionCmd],
            cwd: spec.hostWorkspaceDir,
            env: buildLocalSolverEnv(spec),
        }
    }

    spawn(spec: SolverLaunchSpec): Subprocess<"pipe", "pipe", "pipe"> {
        const { cmd, cwd, env } = this.buildLaunchOptions(spec)
        const proc = Bun.spawn(cmd, {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            cwd,
            env,
        })
        this.procs.set(spec.containerName, proc)
        return proc
    }

    async stop(spec: { containerName: string }): Promise<void> {
        const proc = this.procs.get(spec.containerName)
        if (!proc) return
        try {
            proc.kill()
            await proc.exited
        } catch {
            // already exited
        } finally {
            this.procs.delete(spec.containerName)
        }
    }
}

export function createExecutionBackend(config: ContainerConfig): ExecutionBackend {
    return new LocalProcessBackend(config)
}
