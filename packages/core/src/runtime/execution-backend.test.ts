import { test, expect } from "bun:test"
import { createExecutionBackend, SshBackend, DockerBackend } from "./execution-backend"
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

test("createExecutionBackend selects ssh when configured", () => {
    const b = createExecutionBackend({ image: "x", backend: "ssh", ssh: { host: "10.0.0.9" } })
    expect(b.kind).toBe("ssh")
    expect(b instanceof SshBackend).toBe(true)
})

test("createExecutionBackend throws when ssh backend has no ssh config", () => {
    expect(() => createExecutionBackend({ image: "x", backend: "ssh" })).toThrow(/requires runtime.ssh/)
})

test("SshBackend requires host or alias", () => {
    expect(() => new SshBackend({})).toThrow(/alias.*host|host.*alias/)
})

test("SshBackend (alias) builds ssh argv with key-based alias, no password", () => {
    const b = new SshBackend({ alias: "solver-host", remoteBinary: "/opt/tch/bin" })
    const argv = b.buildLaunchArgv(SPEC)
    expect(argv[0]).toBe("ssh")
    expect(argv).toContain("solver-host")
    // 最后一个参数是远端命令
    const remote = argv[argv.length - 1]
    expect(remote).toContain("/opt/tch/bin")
    expect(remote).toContain("solver rpc")
    // 路径用 host 路径（sshfs 同视图）
    expect(remote).toContain("TCH_SOLVER_WORKSPACE=/srv/solvers/abc123/workspace")
    expect(remote).toContain("TCH_ENGAGEMENT_SCOPE=/home/kai/.tch-agent/scope.json")
    // 不含密码
    expect(argv).not.toContain("sshpass")
})

test("SshBackend (host+password) uses sshpass and port", () => {
    const b = new SshBackend({ host: "10.0.0.50", port: 22, username: "root", password: "secret" })
    const argv = b.buildLaunchArgv(SPEC)
    expect(argv[0]).toBe("sshpass")
    expect(argv).toContain("secret")
    expect(argv).toContain("-p")
    expect(argv).toContain("22")
    expect(argv).toContain("root@10.0.0.50")
})

test("SshBackend defaults remote binary path", () => {
    const b = new SshBackend({ host: "h" })
    const remote = b.buildLaunchArgv(SPEC).at(-1)!
    expect(remote).toContain("/opt/tch-agent/tch-agent")
})
