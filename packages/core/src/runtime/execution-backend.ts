import type { Subprocess } from "bun"
import type { ContainerConfig, SshBackendConfig } from "./types"

/**
 * 执行后端抽象：把"在哪起 solver 进程"与 RuntimeManager 的协议桥接（JSONL over stdio）解耦。
 *
 * 关键不变量：无论 docker 还是 ssh，solver 都是一个 `Bun.spawn` 出来的子进程，
 * stdin/stdout 上跑同一套 JSONL RPC 协议。所以 readStream/sendCommand 完全复用，
 * 后端只负责"构造启动哪个子进程"和"如何停止"。
 */
export interface SolverLaunchSpec {
    solverId: string
    containerName: string
    /** 注入到 solver 进程的环境变量（不含路径，路径由后端按自身视图决定） */
    solverEnv: Record<string, string>
    /** solver 二进制启动命令（如 ["/opt/tch-agent/tch-agent","solver","rpc"]） */
    injectionCmd: string[]
    /** 额外只读绑定（仅 docker 用：host:container；ssh 后端忽略或经 sshfs 处理） */
    extraBinds: string[]
    /** 宿主机上的 scope 文件路径（可选） */
    hostScopePath?: string
    /** 主机侧 solver 目录（startup/session/workspace 的父目录） */
    hostBaseDir: string
    hostSessionDir: string
    hostWorkspaceDir: string
}

export interface ExecutionBackend {
    readonly kind: "docker" | "ssh"
    /** 构造并启动 solver 子进程（stdin/stdout/stderr 均为 pipe） */
    spawn(spec: SolverLaunchSpec): Subprocess<"pipe", "pipe", "pipe">
    /** 停止一个 solver */
    stop(spec: { solverId: string; containerName: string }): Promise<void>
}

// ──────────────────────────────────────────────────────────────
// Docker 后端：行为与原 RuntimeManager 内联逻辑完全一致
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
        const binds = [
            ...(this.config.binds ?? []),
            `${spec.hostBaseDir}:${CONTAINER_RUNTIME_DIR}`,
            `${spec.hostWorkspaceDir}:${CONTAINER_WORKSPACE_DIR}`,
            ...spec.extraBinds,
        ]

        // scope 文件：宿主机路径容器内不可见，只读挂载到容器固定路径并改写 env。
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
        const args = this.buildDockerArgs(spec.containerName, binds, command, CONTAINER_WORKSPACE_DIR)
        return Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
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
        for (const bind of binds) args.push("-v", bind)
        for (const [k, v] of Object.entries(this.config.env ?? {})) args.push("-e", `${k}=${v}`)
        args.push(this.config.image, ...cmd)
        return args
    }
}

// ──────────────────────────────────────────────────────────────
// SSH 后端：solver 直接在远程主机（云 kali）上跑，无 docker
// ──────────────────────────────────────────────────────────────

const DEFAULT_REMOTE_BINARY = "/opt/tch-agent/tch-agent"

/**
 * SSH 后端：在远程主机上以 `setsid <binary> solver rpc --env ...` 起 solver 进程，
 * JSONL 协议经 ssh 的 stdin/stdout 透传（与 docker 的 pipe 等价）。
 *
 * 路径模型：solver 在远程把 startup/session/workspace 写到 remoteSolversDir/<id>/...，
 * 该目录需与本机 SOLVERS_DIR 经 sshfs 挂载为同一视图，host 侧 48 处读状态代码即可不改。
 * 因此这里直接复用 host 路径（spec.hostBaseDir 等）作为远程路径——两者必须指向同一物理目录。
 */
export class SshBackend implements ExecutionBackend {
    readonly kind = "ssh" as const

    constructor(private readonly ssh: SshBackendConfig) {
        if (!ssh.alias && !ssh.host) {
            throw new Error("ssh backend requires either `alias` or `host`")
        }
    }

    spawn(spec: SolverLaunchSpec): Subprocess<"pipe", "pipe", "pipe"> {
        const sshArgs = this.buildLaunchArgv(spec)
        return Bun.spawn(sshArgs, { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    }

    /** 构造完整 ssh argv（纯函数，便于测试）。 */
    buildLaunchArgv(spec: SolverLaunchSpec): string[] {
        const binary = this.ssh.remoteBinary?.trim() || DEFAULT_REMOTE_BINARY

        // 远程路径 == host 路径（经 sshfs 同视图）。scope 文件同理，直接用宿主机路径。
        const solverEnv: Record<string, string> = {
            ...spec.solverEnv,
            TCH_SOLVER_BASE_DIR: spec.hostBaseDir,
            TCH_SOLVER_SESSION_DIR: spec.hostSessionDir,
            TCH_SOLVER_WORKSPACE: spec.hostWorkspaceDir,
        }
        if (spec.hostScopePath) {
            solverEnv.TCH_ENGAGEMENT_SCOPE = spec.hostScopePath
        }

        // 远端命令：cd workspace && exec binary solver rpc --env K=V ...
        const remoteParts = ["cd", shq(spec.hostWorkspaceDir), "&&", "exec", shq(binary), "solver", "rpc"]
        for (const [k, v] of Object.entries(solverEnv)) {
            if (!k.trim() || typeof v !== "string" || !v.trim()) continue
            remoteParts.push("--env", shq(`${k}=${v}`))
        }
        return this.buildSshArgv(remoteParts.join(" "))
    }

    async stop(spec: { solverId: string }): Promise<void> {
        // 远端精确杀该 solver 的进程。旧写法 `solver rpc.*${solverId}` 有两个问题：
        // solverId 未做正则转义；`.*` 贪婪。这里改成匹配 cmdline 里该 solver 独有的路径段
        // `/<solverId>/`（TCH_SOLVER_BASE_DIR/SESSION_DIR/WORKSPACE 都含它），并转义正则元字符。
        const marker = `/${reEscape(spec.solverId)}/`
        const remoteKill = `pkill -f ${shq(marker)} 2>/dev/null || true`
        try {
            const proc = Bun.spawn(this.buildSshArgv(remoteKill), { stdout: "ignore", stderr: "ignore" })
            await proc.exited
        } catch {
            // best effort
        }
    }

    /** 构造 ssh argv：优先别名（密钥/隧道），否则 host + 可选 sshpass 密码。 */
    private buildSshArgv(remoteCommand: string): string[] {
        const common = ["-o", "StrictHostKeyChecking=no", "-o", "ServerAliveInterval=15"]
        if (this.ssh.alias?.trim()) {
            return ["ssh", ...common, this.ssh.alias.trim(), remoteCommand]
        }
        const port = String(this.ssh.port ?? 22)
        const target = `${this.ssh.username?.trim() || "root"}@${this.ssh.host}`
        const base = ["ssh", ...common, "-p", port, target, remoteCommand]
        if (this.ssh.password?.trim()) {
            // 用 sshpass 走明文密码（需远程主机已装 sshpass 于本机）。推荐改用 alias+密钥。
            return ["sshpass", "-p", this.ssh.password, ...base]
        }
        return base
    }
}

/** 单引号 shell 转义 */
function shq(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`
}

/** 转义正则元字符（用于 pkill -f 的模式，避免 solverId/路径里的特殊字符被当作正则）。 */
function reEscape(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function createExecutionBackend(config: ContainerConfig): ExecutionBackend {
    if (config.backend === "ssh") {
        if (!config.ssh) throw new Error('runtime.backend="ssh" requires runtime.ssh config')
        return new SshBackend(config.ssh)
    }
    return new DockerBackend(config)
}

