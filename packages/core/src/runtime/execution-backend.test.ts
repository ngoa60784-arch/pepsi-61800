import { test, expect } from "bun:test"
import { createExecutionBackend, SshBackend, DockerBackend, LocalBackend } from "./execution-backend"
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

test("createExecutionBackend selects local when configured", () => {
    const b = createExecutionBackend({ image: "x", backend: "local" })
    expect(b.kind).toBe("local")
    expect(b instanceof LocalBackend).toBe(true)
})

test("LocalBackend builds a local solver-rpc argv ending in 'solver rpc' with env flags", () => {
    const b = new LocalBackend()
    const argv = b.buildLaunchArgv(SPEC)
    // argv 以当前进程 execPath 开头，含 solver rpc 子命令
    const joined = argv.join(" ")
    expect(joined).toContain("solver rpc")
    // env 以 --env K=V 附带（兜底；主注入走 Bun.spawn 的 env）
    expect(joined).toContain("--env TCH_ENGAGEMENT_MODE=1")
    expect(joined).toContain("--env TCH_CHALLENGE_ID=t1")
    // 不做容器/远程路径转换，也不出现 docker/ssh 关键字
    expect(argv).not.toContain("docker")
    expect(argv).not.toContain("ssh")
})

test("LocalBackend.stop is a no-op (RuntimeManager kills the local proc)", async () => {
    const b = new LocalBackend()
    await expect(b.stop({ solverId: "abc123", containerName: "tch-solver-abc123" })).resolves.toBeUndefined()
})
