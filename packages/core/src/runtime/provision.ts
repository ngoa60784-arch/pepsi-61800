import type { Subprocess } from "bun"
// Provisioning script: obtained via type:"file" (the bundled, inlined path), then read with Bun.file().text().
// Don't use type:"text" to grab the string directly — in practice it's unstable when multiple test files load
// concurrently, occasionally returning the path instead of the content
// (PROVISION_SCRIPT.length=77, i.e. the path length), which would push the path to the VPS as the script.
// type:"file" is the reliable pattern in this repo.
import PROVISION_SCRIPT_ASSET from "./assets/provision-pentest-vps.sh" with { type: "file" }

let scriptCache: Promise<string> | undefined
/** Read the provisioning script content (cached, read cross-platform via the bundled asset path). */
export function getProvisionScript(): Promise<string> {
    if (!scriptCache) scriptCache = Bun.file(PROVISION_SCRIPT_ASSET).text()
    return scriptCache
}

export interface ProvisionSshTarget {
    host?: string
    port?: number
    username?: string
    password?: string
    /** Local ~/.ssh/config alias (takes priority over host/password, uses key/tunnel). */
    alias?: string
}

export interface ProvisionResult {
    exitCode: number
}

/**
 * Build argv for `ssh … <remote>`. Used by provisioning (stdin script) and connection tests.
 */
export function buildSshArgv(target: ProvisionSshTarget, remote: string): string[] {
    const common = ["-o", "StrictHostKeyChecking=no", "-o", "ServerAliveInterval=15"]
    if (target.alias?.trim()) {
        return ["ssh", ...common, target.alias.trim(), remote]
    }
    if (!target.host?.trim()) {
        throw new Error("需要 SSH_HOST 或 SSH_ALIAS")
    }
    const port = String(target.port ?? 22)
    const dest = `${target.username?.trim() || "root"}@${target.host.trim()}`
    const base = ["ssh", ...common, "-p", port, dest, remote]
    if (target.password?.trim()) {
        // sshpass uses a plaintext password (local host must have sshpass installed). Switching to alias+key is recommended.
        return ["sshpass", "-p", target.password, ...base]
    }
    return base
}

/** argv for piping provision-pentest-vps.sh to remote `bash -s`. */
export function buildProvisionArgv(target: ProvisionSshTarget): string[] {
    return buildSshArgv(target, "bash -s")
}

/**
 * Push the provisioning script to the remote VPS and execute it, invoking the callback line by line for stdout/stderr (for SSE streaming echo).
 * Resolves with the exit code; non-zero also resolves (the caller decides based on exitCode), only a spawn failure itself rejects.
 */
function buildProvisionScriptPrefix(extraEnv?: Record<string, string>): string {
    if (!extraEnv) return ""
    const lines: string[] = []
    for (const [key, value] of Object.entries(extraEnv)) {
        if (!key.startsWith("TCH_") || !value.trim()) continue
        lines.push(`export ${key}=${JSON.stringify(value.trim())}`)
    }
    return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

export async function provisionKaliVps(
    target: ProvisionSshTarget,
    onLine: (line: string, stream: "stdout" | "stderr") => void,
    signal?: AbortSignal,
    extraEnv?: Record<string, string>,
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

    const script = buildProvisionScriptPrefix(extraEnv) + (await getProvisionScript())
    proc.stdin.write(script)
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
