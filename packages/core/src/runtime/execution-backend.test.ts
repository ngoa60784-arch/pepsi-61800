import { test, expect } from "bun:test"
import { createExecutionBackend, DockerBackend } from "./execution-backend"
import type { SolverLaunchSpec } from "./execution-backend"

const SPEC: SolverLaunchSpec = {
    solverId: "abc123",
    containerName: "tch-solver-abc123",
    solverEnv: { TCH_ENGAGEMENT_MODE: "1", TCH_CHALLENGE_ID: "t1" },
    injectionCmd: ["/opt/tch-agent/tch-agent", "solver", "rpc"],
    extraBinds: [],
    hostScopePath: "/home/kai/.tch-agent/scope.json",
    hostBaseDir: "/srv/solvers/abc123",
    hostSessionDir: "/srv/solvers/abc123/session",
    hostWorkspaceDir: "/srv/solvers/abc123/workspace",
}

test("createExecutionBackend defaults to docker", () => {
    const b = createExecutionBackend({ image: "tch-agent:latest" })
    expect(b.kind).toBe("docker")
    expect(b instanceof DockerBackend).toBe(true)
})

test("DockerBackend omits --memory/--cpus when not configured (no limit)", () => {
    const argv = new DockerBackend({ image: "tch-agent:latest" }).buildLaunchArgv(SPEC)
    expect(argv).not.toContain("--memory")
    expect(argv).not.toContain("--cpus")
})

test("DockerBackend applies --memory and --cpus when configured", () => {
    const argv = new DockerBackend({ image: "tch-agent:latest", memory: "2g", cpus: 1.5 }).buildLaunchArgv(SPEC)
    expect(argv).toContain("--memory")
    expect(argv[argv.indexOf("--memory") + 1]).toBe("2g")
    expect(argv).toContain("--cpus")
    expect(argv[argv.indexOf("--cpus") + 1]).toBe("1.5")
})

test("DockerBackend ignores non-positive cpus and blank memory", () => {
    const argv = new DockerBackend({ image: "x", memory: "  ", cpus: 0 }).buildLaunchArgv(SPEC)
    expect(argv).not.toContain("--memory")
    expect(argv).not.toContain("--cpus")
})

