import { test, expect } from "bun:test"
import { createExecutionBackend, LocalProcessBackend } from "./execution-backend"
import type { SolverLaunchSpec } from "./execution-backend"

const SPEC: SolverLaunchSpec = {
    solverId: "abc123",
    containerName: "tch-solver-abc123",
    solverEnv: { TCH_ENGAGEMENT_MODE: "1", TCH_CHALLENGE_ID: "t1" },
    injectionCmd: ["/opt/tch-agent/tch-agent", "solver", "rpc"],
    hostScopePath: "/home/kai/.tch-agent/scope.json",
    hostBaseDir: "/srv/solvers/abc123",
    hostSessionDir: "/srv/solvers/abc123/session",
    hostWorkspaceDir: "/srv/solvers/abc123/workspace",
}

test("createExecutionBackend always uses local backend", () => {
    const b = createExecutionBackend({})
    expect(b.kind).toBe("local")
    expect(b instanceof LocalProcessBackend).toBe(true)
})

test("LocalProcessBackend sets host paths and exec surface env", () => {
    const backend = new LocalProcessBackend({})
    const { cmd, cwd, env } = backend.buildLaunchOptions({
        ...SPEC,
        injectionCmd: ["bun", "/tmp/cli.ts", "solver", "rpc"],
        solverEnv: { TCH_EXEC_SURFACE: "local-host", TCH_CHALLENGE_ID: "t1" },
    })
    expect(cmd).toEqual(["bun", "/tmp/cli.ts", "solver", "rpc"])
    expect(cwd).toBe(SPEC.hostWorkspaceDir)
    expect(env.TCH_SOLVER_BASE_DIR).toBe(SPEC.hostBaseDir)
    expect(env.TCH_SOLVER_SESSION_DIR).toBe(SPEC.hostSessionDir)
    expect(env.TCH_SOLVER_WORKSPACE).toBe(SPEC.hostWorkspaceDir)
    expect(env.TCH_ENGAGEMENT_SCOPE).toBe(SPEC.hostScopePath ?? "")
    expect(env.TCH_EXEC_SURFACE).toBe("local-host")
    expect(env.TCH_MCP_DIR).toBeTruthy()
    expect(env.TCH_SOLVER_MCP_MOUNT).toBe("/opt/tch-mcp")
})
