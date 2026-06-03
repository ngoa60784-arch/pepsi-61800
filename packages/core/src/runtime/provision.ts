import type { Subprocess } from "bun"
// 预装脚本：用 type:"file" 拿到（打包后内联的）路径，再 Bun.file().text() 读内容。
// 不用 type:"text" 直接拿字符串——实测在多测试文件并发加载时它会不稳，偶尔返回路径而非内容
// （PROVISION_SCRIPT.length=77 即路径长度），会把路径当脚本推到 VPS。type:"file" 是本仓库可靠模式。
import PROVISION_SCRIPT_ASSET from "./assets/provision-pentest-vps.sh" with { type: "file" }

let scriptCache: Promise<string> | undefined
/** 读取预装脚本内容（缓存，跨平台经打包后的资产路径读）。 */
export function getProvisionScript(): Promise<string> {
    if (!scriptCache) scriptCache = Bun.file(PROVISION_SCRIPT_ASSET).text()
    return scriptCache
}

export interface ProvisionSshTarget {
    host?: string
    port?: number
    username?: string
    password?: string
    /** 本地 ~/.ssh/config 别名（优先于 host/password，走密钥/隧道）。 */
    alias?: string
}

export interface ProvisionResult {
    exitCode: number
}

/**
 * 构造把脚本喂给远端 `bash -s` 的 ssh argv。脚本经 stdin 传入，无需 scp。
 * 远端以 `bash -s` 读取标准输入执行；脚本自身会校验 root。
 */
export function buildProvisionArgv(target: ProvisionSshTarget): string[] {
    const common = ["-o", "StrictHostKeyChecking=no", "-o", "ServerAliveInterval=15"]
    const remote = "bash -s"
    if (target.alias?.trim()) {
        return ["ssh", ...common, target.alias.trim(), remote]
    }
    if (!target.host?.trim()) {
        throw new Error("provision requires either ssh alias or host")
    }
    const port = String(target.port ?? 22)
    const dest = `${target.username?.trim() || "root"}@${target.host.trim()}`
    const base = ["ssh", ...common, "-p", port, dest, remote]
    if (target.password?.trim()) {
        // sshpass 走明文密码（本机需装 sshpass）。推荐改用 alias+密钥。
        return ["sshpass", "-p", target.password, ...base]
    }
    return base
}

/**
 * 把预装脚本推到远端 VPS 执行，逐行回调 stdout/stderr（供 SSE 流式回显）。
 * 解析为退出码；非 0 也 resolve（由调用方据 exitCode 判定），spawn 本身失败才 reject。
 */
export async function provisionKaliVps(
    target: ProvisionSshTarget,
    onLine: (line: string, stream: "stdout" | "stderr") => void,
    signal?: AbortSignal,
): Promise<ProvisionResult> {
    const argv = buildProvisionArgv(target)
    const proc: Subprocess<"pipe", "pipe", "pipe"> = Bun.spawn(argv, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    })

    if (signal) {
        if (signal.aborted) proc.kill()
        else signal.addEventListener("abort", () => proc.kill(), { once: true })
    }

    // 把脚本写进远端 bash 的 stdin，然后关闭，触发执行。
    proc.stdin.write(await getProvisionScript())
    await proc.stdin.end()

    const pump = async (readable: ReadableStream<Uint8Array>, which: "stdout" | "stderr") => {
        const reader = readable.getReader()
        const decoder = new TextDecoder()
        let buf = ""
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            let nl: number
            while ((nl = buf.indexOf("\n")) >= 0) {
                onLine(buf.slice(0, nl), which)
                buf = buf.slice(nl + 1)
            }
        }
        if (buf.trim()) onLine(buf, which)
    }

    await Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")])
    const exitCode = await proc.exited
    return { exitCode }
}
