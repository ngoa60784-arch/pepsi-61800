import type { Subprocess } from "bun"
import { buildSshArgv, type ProvisionSshTarget } from "./provision"

export interface KaliSshTestResult {
    ok: boolean
    message: string
    uid?: string
    isRoot?: boolean
}

const SSH_TEST_REMOTE = "bash -lc 'echo TCH_SSH_OK && id -u'"
const SSH_TEST_MARKER = "TCH_SSH_OK"
const SSH_TEST_TIMEOUT_MS = 20_000

/** Map kali-arsenal MCP env (SSH_*) to a provision/test SSH target. */
export function kaliEnvToProvisionTarget(env: Record<string, string>): ProvisionSshTarget {
    const alias = env.SSH_ALIAS?.trim()
    if (alias) return { alias }
    const host = env.SSH_HOST?.trim()
    if (!host) {
        throw new Error("请填写 SSH_HOST，或改用 SSH_ALIAS（~/.ssh/config 别名）")
    }
    const port = Number.parseInt(env.SSH_PORT?.trim() || "22", 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("SSH_PORT 无效")
    }
    const user = env.SSH_USER?.trim() || "root"
    const password = env.SSH_PASS?.trim() || undefined
    return { host, port, username: user, password }
}

/** Quick SSH reachability check (no MCP spawn). */
export async function testKaliSshConnection(
    target: ProvisionSshTarget,
    signal?: AbortSignal,
): Promise<KaliSshTestResult> {
    const argv = buildSshArgv(target, SSH_TEST_REMOTE)
    const proc: Subprocess<"pipe", "pipe", "pipe"> = Bun.spawn(argv, {
        stdout: "pipe",
        stderr: "pipe",
    })

    const abort = () => proc.kill()
    if (signal) {
        if (signal.aborted) abort()
        else signal.addEventListener("abort", abort, { once: true })
    }

    const timeout = setTimeout(abort, SSH_TEST_TIMEOUT_MS)
    try {
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ])
        const out = `${stdout}\n${stderr}`.trim()
        if (exitCode !== 0) {
            const hint = out.includes("sshpass") ? "本机需安装 sshpass（apt install sshpass）" : ""
            return {
                ok: false,
                message: out.slice(0, 500) || `SSH 退出码 ${exitCode}${hint ? `；${hint}` : ""}`,
            }
        }
        if (!stdout.includes(SSH_TEST_MARKER)) {
            return { ok: false, message: out.slice(0, 500) || "SSH 已连接但未收到测试标记" }
        }
        const uidMatch = stdout.match(/(?:^|\n)(\d+)\s*$/m)
        const uid = uidMatch?.[1]
        const isRoot = uid === "0"
        if (!isRoot) {
            return {
                ok: false,
                message: `已连通，但当前用户 uid=${uid ?? "?"}（一键装环境需要 root，请用 root 或 sudo 用户）`,
                uid,
                isRoot: false,
            }
        }
        const label = target.alias?.trim() || `${target.username || "root"}@${target.host}`
        return {
            ok: true,
            message: `连接成功：${label}（root）`,
            uid,
            isRoot: true,
        }
    } catch (error) {
        return {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
        }
    } finally {
        clearTimeout(timeout)
    }
}

export function parseKaliEnvFields(envText: string): Record<string, string> {
    const fields: Record<string, string> = {}
    for (const line of envText.trim().split("\n")) {
        const eq = line.indexOf("=")
        if (eq <= 0) continue
        fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    return fields
}

export function formatKaliEnvFields(fields: Record<string, string>): string {
    const order = ["SSH_ALIAS", "SSH_HOST", "SSH_PORT", "SSH_USER", "SSH_PASS"]
    const lines: string[] = []
    const seen = new Set<string>()
    for (const key of order) {
        if (key in fields) {
            lines.push(`${key}=${fields[key] ?? ""}`)
            seen.add(key)
        }
    }
    for (const [key, value] of Object.entries(fields)) {
        if (!seen.has(key)) lines.push(`${key}=${value}`)
    }
    return lines.join("\n")
}

export function isKaliArsenalServer(name: string, server?: { args?: string[] }): boolean {
    if (name === "kali-arsenal") return true
    return (server?.args ?? []).some((arg) => arg.includes("ssh_mcp.py"))
}

/** Same checklist as provision-pentest-vps.sh stage 6. */
export const KALI_PROVISION_CHECK_TOOLS = [
    "nmap",
    "nuclei",
    "httpx",
    "ffuf",
    "gobuster",
    "sqlmap",
    "hydra",
    "john",
    "masscan",
    "subfinder",
    "katana",
    "dalfox",
    "dnsx",
    "naabu",
    "fscan",
    "kerbrute",
    "rustscan",
    "nikto",
    "nxc",
    "jwt_tool",
] as const

export interface KaliToolCheckEntry {
    tool: string
    ok: boolean
    path?: string
}

export interface KaliToolCheckResult {
    ready: string[]
    missing: string[]
    entries: KaliToolCheckEntry[]
}

/** Nice-to-have; agent can install at runtime if missing. */
export const KALI_OPTIONAL_TOOLS = new Set([
    "fscan",
    "kerbrute",
    "rustscan",
    "dalfox",
    // AD / JWT niche — agent can use other tooling if missing
    "nxc",
    "jwt_tool",
])

/** Core checklist items — provision must verify these as OK before finishing. */
export const KALI_CORE_TOOLS = KALI_PROVISION_CHECK_TOOLS.filter((t) => !KALI_OPTIONAL_TOOLS.has(t))

const TOOL_CHECK_TIMEOUT_MS = 30_000

export const KALI_PENTEST_PATH =
    "/usr/local/bin:/usr/local/go/bin:/root/.local/bin:/opt/pipx/bin:/root/.pdtm/go/bin:/root/.cargo/bin"

/** Remote shell snippet: print OK:tool:path or MISS:tool per checklist item. */
export function buildKaliToolCheckRemoteShell(): string {
    const checks = KALI_PROVISION_CHECK_TOOLS.map((tool) => {
        return `p=$(PATH="${KALI_PENTEST_PATH}:$PATH" command -v ${tool} 2>/dev/null); ` +
            `[ -z "$p" ] && [ -x /usr/local/bin/${tool} ] && p=/usr/local/bin/${tool}; ` +
            `[ -n "$p" ] && echo "OK:${tool}:$p" || echo "MISS:${tool}"`
    }).join("; ")
    return `bash -lc '. /etc/profile.d/pentest-path.sh 2>/dev/null; export PATH="${KALI_PENTEST_PATH}:$PATH"; ${checks}'`
}

/** SSH to remote and run command -v for each core tool (loads pentest-path if present). */
export async function checkKaliToolsOnRemote(
    target: ProvisionSshTarget,
    signal?: AbortSignal,
): Promise<KaliToolCheckResult> {
    const remote = buildKaliToolCheckRemoteShell()
    const argv = buildSshArgv(target, remote)
    const proc: Subprocess<"pipe", "pipe", "pipe"> = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })

    const abort = () => proc.kill()
    if (signal) {
        if (signal.aborted) abort()
        else signal.addEventListener("abort", abort, { once: true })
    }

    const timeout = setTimeout(abort, TOOL_CHECK_TIMEOUT_MS)
    try {
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ])
        if (exitCode !== 0) {
            throw new Error((stdout + stderr).trim().slice(0, 500) || `SSH 退出码 ${exitCode}`)
        }
        const ready: string[] = []
        const missing: string[] = []
        const entries: KaliToolCheckEntry[] = []
        for (const line of stdout.split("\n")) {
            const trimmed = line.trim()
            if (trimmed.startsWith("OK:")) {
                const body = trimmed.slice(3)
                const colon = body.indexOf(":")
                const tool = colon >= 0 ? body.slice(0, colon) : body
                const path = colon >= 0 ? body.slice(colon + 1) : undefined
                ready.push(tool)
                entries.push({ tool, ok: true, path })
            } else if (trimmed.startsWith("MISS:")) {
                const tool = trimmed.slice(5)
                missing.push(tool)
                entries.push({ tool, ok: false })
            }
        }
        return { ready, missing, entries }
    } finally {
        clearTimeout(timeout)
    }
}

/** Parse Ready / Not installed lines from provision script stdout (ANSI stripped). */
export function parseProvisionLogSummary(logs: string[]): KaliToolCheckResult | null {
    let ready: string[] = []
    let missing: string[] = []
    for (const line of logs) {
        const plain = line.replace(/\x1b\[[0-9;]*m/g, "").replace(/^\[stderr\]\s*/, "")
        const readyMatch = plain.match(/Ready\s*\(\d+\):\s*(.+)/i)
        const missMatch = plain.match(/Not installed\s*\(\d+\):\s*(.+)/i)
        if (readyMatch?.[1]) ready = readyMatch[1].trim().split(/\s+/).filter(Boolean)
        if (missMatch?.[1]) missing = missMatch[1].trim().split(/\s+/).filter(Boolean)
    }
    if (ready.length === 0 && missing.length === 0) return null
    const entries: KaliToolCheckEntry[] = [
        ...ready.map((tool) => ({ tool, ok: true as const })),
        ...missing.map((tool) => ({ tool, ok: false as const })),
    ]
    return { ready, missing, entries }
}
