import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent"
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "os"
import { join, resolve } from "node:path"
import type { ConfigManager } from "../config/index"
import { DEFAULT_CONFIG_DIR } from "../config/index"
import { initBuiltinPrompts, refreshBuiltinPrompt, KALI_PROVISIONER_PROMPT_NAME as KALI_PROMPT } from "../config/prompts/index"
import { updateMcpServer } from "../config/mcp/index"
import {
    buildKaliToolCheckRemoteShell,
    checkKaliToolsOnRemote,
    KALI_PROVISION_CHECK_TOOLS,
    type KaliToolCheckResult,
} from "./kali-ssh"
import { provisionKaliVps, type ProvisionResult, type ProvisionSshTarget } from "./provision"

export const KALI_PROVISIONER_PROMPT_NAME = KALI_PROMPT

/** Legacy on-disk session dirs (removed each run; agent uses inMemory only). */
const LEGACY_PROVISION_WORKSPACE = resolve(DEFAULT_CONFIG_DIR, "kali-provision-workspace")
const LEGACY_PROVISION_SESSION_DIR = resolve(DEFAULT_CONFIG_DIR, "kali-provision-session")

const PROVISION_AGENT_TIMEOUT_MS = 45 * 60 * 1000
/** Agent rounds in one in-memory session (keeps diagnosis context between retries). */
export const KALI_PROVISION_MAX_ROUNDS = 6

/** Per-tool hints when automated re-check still reports MISS — agent must adapt, not repeat the same command. */
const TOOL_INSTALL_HINTS: Record<string, string> = {
    nuclei: "ProjectDiscovery：GitHub release / pdtm / go install；确认在 PATH",
    httpx: "同上；常与 nuclei 一起用 pdtm",
    ffuf: "apt 或 GitHub release amd64 → /usr/local/bin/ffuf",
    katana: "go install 固定 tag 或 GitHub release；勿用过旧 tag",
    dnsx: "go install projectdiscovery/dnsx；或 release 二进制",
    naabu: "go install projectdiscovery/naabu",
    subfinder: "go install projectdiscovery/subfinder",
    dalfox: "go install github.com/hahwul/dalfox/v2@latest",
    fscan: "GitHub shadow1ng/fscan release → chmod +x",
    kerbrute: "GitHub ropnop/kerbrute release",
    rustscan: "GitHub RustScan/RustScan release 或 cargo install",
    nxc: "git clone /opt/NetExec → pip install -e .（需 rustc/aardwolf）→ ln -sf 到 /usr/local/bin/nxc",
    jwt_tool: "git clone → pip 依赖 → shebang → ln -sf jwt_tool.py /usr/local/bin/jwt_tool",
    nmap: "apt install nmap",
    sqlmap: "apt install sqlmap",
    hydra: "apt install hydra",
    john: "apt install john",
    masscan: "apt install masscan",
    gobuster: "apt install gobuster",
    nikto: "apt install nikto",
}

/** Keys written into kali-arsenal MCP env before the agent connects. */
export function kaliEnvForMcpServer(env: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
        if (key.startsWith("SSH_") || key.startsWith("TCH_")) {
            out[key] = value
        }
    }
    return out
}

export async function syncKaliArsenalMcpEnv(config: ConfigManager, env: Record<string, string>): Promise<void> {
    const mcpEnv = kaliEnvForMcpServer(env)
    const existing = config.getMcpConfig().mcpServers["kali-arsenal"]
    if (!existing) {
        throw new Error("未找到 MCP 服务 kali-arsenal，请先在设置 → MCP 中启用")
    }
    await updateMcpServer(config.dir, "kali-arsenal", {
        env: { ...existing.env, ...mcpEnv },
    })
}

/** Human-readable SSH target for the agent task (password never echoed). */
export function formatSshTargetForAgent(env: Record<string, string>): string {
    const alias = env.SSH_ALIAS?.trim()
    const lines: string[] = ["## Remote SSH (kali-arsenal MCP is already configured with these values)"]
    if (alias) {
        lines.push(`- SSH_ALIAS: ${alias}`)
        lines.push("- Connection: ~/.ssh/config alias (key / ProxyJump as configured on control host)")
    } else {
        lines.push(`- SSH_HOST: ${env.SSH_HOST?.trim() || "(missing)"}`)
        lines.push(`- SSH_PORT: ${env.SSH_PORT?.trim() || "22"}`)
        lines.push(`- SSH_USER: ${env.SSH_USER?.trim() || "root"}`)
        lines.push(`- SSH_PASS: ${env.SSH_PASS?.trim() ? "(set — do not print in replies)" : "(empty — key auth)"}`)
    }
    const goproxy = env.TCH_GOPROXY?.trim()
    const ghMirror = env.TCH_GH_MIRROR?.trim()
    if (goproxy) lines.push(`- TCH_GOPROXY: ${goproxy}`)
    if (ghMirror) lines.push(`- TCH_GH_MIRROR: ${ghMirror}`)
    return lines.join("\n")
}

function buildMissingToolHints(missing: string[]): string[] {
    const lines: string[] = ["## 仍缺工具 — 请换思路排查（禁止原样重试已失败的命令）"]
    for (const tool of missing) {
        const hint = TOOL_INSTALL_HINTS[tool] ?? "查 stderr/日志，换 apt / go / pipx / release / clone 等另一种方式"
        lines.push(`- **${tool}**: ${hint}`)
    }
    return lines
}

/** Build the directive given to the provisioner agent. */
export function buildProvisionerDirective(
    env: Record<string, string>,
    options?: { check?: KaliToolCheckResult; round?: number; isFollowUp?: boolean },
): string {
    const checkShell = buildKaliToolCheckRemoteShell()
    const toolList = KALI_PROVISION_CHECK_TOOLS.join(", ")
    const lines: string[] = []

    if (options?.isFollowUp && options.check) {
        lines.push(
            "# 环境配置 — 继续排查（上一轮未达标）",
            "",
            `控制面复核：${options.check.ready.length} 项 OK，仍缺 ${options.check.missing.length} 项。`,
            `仍缺：${options.check.missing.join(", ")}`,
            "",
            "你的职责是**想办法**让每一项都变成 OK，不是再执行一遍已经失败的安装命令。",
            "对每个 MISS：读错误输出 → 换安装途径或修 PATH/软链 → 再跑检测脚本确认。",
            "",
            ...buildMissingToolHints(options.check.missing),
            "",
        )
    } else {
        lines.push(
            "# 环境配置任务",
            "",
            "你是远程 Kali 上的**环境工程师**。目标：让下面检测脚本对 **全部** 工具输出 OK。",
            "",
            "**不是**「执行几条安装命令就交差」，而是：**排查、尝试、验证、换方案**，直到检测全绿。",
            "",
        )
    }

    lines.push(
        formatSshTargetForAgent(env),
        "",
        `## 工具清单（${KALI_PROVISION_CHECK_TOOLS.length} 项，缺一不可）`,
        toolList,
        "",
        "## 检测命令（每做一批改动后必须重跑）",
        "",
        "```bash",
        checkShell,
        "```",
        "",
        "`OK:工具:路径` = 成功；`MISS:工具` = 还没装好，必须继续想办法。",
        "",
        "## 工作方式",
        "",
        "1. 先跑检测，列出所有 MISS。",
        "2. 对每个 MISS：分析原因（超时？没装？装错路径？命令名不对？）→ 选另一种安装方式 → 验证 `command -v` → 重跑完整检测。",
        "3. 编译/下载超过 2 分钟：`ssh_exec_bg` + `ssh_job_poll`，不要 30s 超时了事。",
        "4. 二进制在非常规路径：写入 `/etc/profile.d/pentest-path.sh` 或 `ln -sf` 到 `/usr/local/bin`。",
        "5. **仅当**检测脚本 20 项全是 OK 才能结束；否则继续。",
    )

    if (options?.round && options.round > 1) {
        lines.push("", `（第 ${options.round} 轮追问 — 同一会话内继续，记住之前失败原因）`)
    }

    return lines.join("\n")
}

export function buildKaliProvisionerTask(env: Record<string, string>): string {
    return buildProvisionerDirective(env)
}

export function buildKaliProvisionerRetryTask(
    env: Record<string, string>,
    check: KaliToolCheckResult,
    round?: number,
): string {
    return buildProvisionerDirective(env, { check, round, isFollowUp: true })
}

/** Map agent session events to human-readable provision log lines. */
export function formatProvisionerAgentLog(event: AgentSessionEvent): string | undefined {
    if (event.type === "tool_execution_start") {
        const name = String(event.toolName ?? "tool")
        const short = name.replace(/^mcp_kali_arsenal_/, "")
        const args = event.args as Record<string, unknown> | undefined
        let detail = ""
        if (short === "ssh_execute" || short.includes("ssh_execute")) {
            const cmd = typeof args?.command === "string" ? args.command : typeof args?.cmd === "string" ? args.cmd : ""
            if (cmd) detail = `: ${cmd.length > 200 ? `${cmd.slice(0, 200)}…` : cmd}`
        } else if (short === "ssh_exec_bg") {
            const cmd = typeof args?.cmd === "string" ? args.cmd : ""
            if (cmd) detail = `: ${cmd.length > 120 ? `${cmd.slice(0, 120)}…` : cmd}`
        }
        return `[agent] → ${short}${detail}`
    }
    if (event.type === "tool_execution_end") {
        const name = String(event.toolName ?? "tool").replace(/^mcp_kali_arsenal_/, "")
        return event.isError ? `[agent] ✗ ${name}` : `[agent] ✓ ${name}`
    }
    // Do not stream text_delta — each token becomes one UI log line and breaks the MCP dialog layout.
    if (event.type === "agent_end") {
        const err = (event as { error?: string }).error
        return err ? `[agent] 结束（错误: ${err}）` : "[agent] 结束"
    }
    return undefined
}

/** Remove old disk-backed provisioner sessions (current runs use inMemory only). */
export async function cleanupProvisionerPersistence(): Promise<void> {
    await rm(LEGACY_PROVISION_WORKSPACE, { recursive: true, force: true })
    await rm(LEGACY_PROVISION_SESSION_DIR, { recursive: true, force: true })
}

async function ensureProvisionerPrompt(config: ConfigManager): Promise<void> {
    await refreshBuiltinPrompt(config.dir, KALI_PROVISIONER_PROMPT_NAME)
    let prompt = await config.getPrompt(KALI_PROVISIONER_PROMPT_NAME)
    if (!prompt) {
        await initBuiltinPrompts(config.dir)
        await refreshBuiltinPrompt(config.dir, KALI_PROVISIONER_PROMPT_NAME)
        prompt = await config.getPrompt(KALI_PROVISIONER_PROMPT_NAME)
    }
    if (!prompt) {
        throw new Error(`内置 Prompt ${KALI_PROVISIONER_PROMPT_NAME} 未就绪，请重启 Web 服务`)
    }
}

/** Echo task text into provision logs so operators can verify what the model received. */
export function logProvisionerTaskToStream(
    task: string,
    onLine: (line: string, stream: "stdout" | "stderr") => void,
    label: string,
): void {
    onLine(`[provision] --- ${label} ---`, "stdout")
    const lines = task.split("\n")
    const max = 35
    for (const line of lines.slice(0, max)) {
        onLine(`[provision] | ${line}`, "stdout")
    }
    if (lines.length > max) {
        onLine(`[provision] | …（共 ${lines.length} 行，已截断）`, "stdout")
    }
    onLine("[provision] ---", "stdout")
}

async function promptProvisionerSession(
    session: Awaited<ReturnType<typeof createAgentSession>>["session"],
    task: string,
    onLine: (line: string, stream: "stdout" | "stderr") => void,
): Promise<boolean> {
    let agentOk = true
    await new Promise<void>((resolve, reject) => {
        session.subscribe((event: AgentSessionEvent) => {
            const line = formatProvisionerAgentLog(event)
            if (line) onLine(line, "stdout")
            if (event.type === "agent_end") {
                const err = (event as { error?: string }).error
                if (err) agentOk = false
                resolve()
            }
        })
        session.prompt(task, { expandPromptTemplates: true, source: "rpc" }).catch((err: unknown) => {
            agentOk = false
            reject(err)
        })
    })
    return agentOk
}

export type ProvisionerPromptFn = (task: string) => Promise<boolean>

/**
 * One in-memory Agent session for the whole provision run.
 * `run` may call `prompt` multiple times so the model keeps prior failure context.
 */
async function withProvisionerAgentSession(
    config: ConfigManager,
    onLine: (line: string, stream: "stdout" | "stderr") => void,
    signal: AbortSignal | undefined,
    run: (prompt: ProvisionerPromptFn) => Promise<void>,
): Promise<{ agentOk: boolean }> {
    await ensureProvisionerPrompt(config)

    const sessionOpts = await config.resolvePromptSession(KALI_PROVISIONER_PROMPT_NAME)
    if (!sessionOpts) {
        throw new Error(`无法加载 ${KALI_PROVISIONER_PROMPT_NAME} 会话配置`)
    }
    if (!sessionOpts.model) {
        throw new Error("请先在「设置 → 模型」配置 API Key 与默认模型，Agent 才能安装工具")
    }

    const workspaceDir = await mkdtemp(join(tmpdir(), "tch-kali-provision-"))
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined
    let agentOk = true

    try {
        const created = await createAgentSession({
            ...sessionOpts,
            cwd: workspaceDir,
            sessionManager: SessionManager.inMemory(),
        })
        session = created.session
        await session.bindExtensions({})

        const abortAgent = () => {
            void session?.abort().catch(() => {})
        }
        if (signal) {
            if (signal.aborted) abortAgent()
            else signal.addEventListener("abort", abortAgent, { once: true })
        }

        const timeout = setTimeout(abortAgent, PROVISION_AGENT_TIMEOUT_MS)

        const prompt: ProvisionerPromptFn = async (task) => {
            if (signal?.aborted) return false
            const ok = await promptProvisionerSession(session!, task, onLine)
            if (!ok) agentOk = false
            return ok
        }

        try {
            await run(prompt)
        } catch (error) {
            agentOk = false
            onLine(error instanceof Error ? error.message : String(error), "stderr")
        } finally {
            clearTimeout(timeout)
            try {
                session.dispose()
            } catch {
                // ignore
            }
            session = undefined
        }
    } finally {
        await rm(workspaceDir, { recursive: true, force: true })
    }

    return { agentOk }
}

/**
 * Agent-driven Kali provisioning: one session, repeated follow-ups until check passes or max rounds.
 * Shell script runs only if the agent still leaves gaps after all agent rounds (last resort).
 */
export async function provisionKaliWithAgent(
    config: ConfigManager,
    target: ProvisionSshTarget,
    env: Record<string, string>,
    onLine: (line: string, stream: "stdout" | "stderr") => void,
    signal?: AbortSignal,
): Promise<ProvisionResult & { toolCheck?: KaliToolCheckResult }> {
    await cleanupProvisionerPersistence()
    await syncKaliArsenalMcpEnv(config, env)

    onLine(
        `[provision] 由 Agent 排查并装全 ${KALI_PROVISION_CHECK_TOOLS.length} 项（同一会话内多轮追问，不保存到磁盘）`,
        "stdout",
    )

    let check: KaliToolCheckResult = { ready: [], missing: [...KALI_PROVISION_CHECK_TOOLS], entries: [] }
    let agentRounds = 0

    onLine("[provision] 启动 Agent 会话（单会话多轮追问）…", "stdout")
    const agentResult = await withProvisionerAgentSession(config, onLine, signal, async (prompt) => {
        const initialTask = buildKaliProvisionerTask(env)
        logProvisionerTaskToStream(initialTask, onLine, "Agent 用户消息（首轮）")
        agentRounds++
        await prompt(initialTask)

        check = await checkKaliToolsOnRemote(target, signal)
        onLine(`[provision] 复核：${check.ready.length} 就绪，${check.missing.length} 仍缺`, "stdout")

        let round = 2
        while (check.missing.length > 0 && round <= KALI_PROVISION_MAX_ROUNDS && !signal?.aborted) {
            onLine(
                `[provision] 仍缺 ${check.missing.join(", ")} — 同一会话追问 ${round}（换思路，禁止重复失败命令）…`,
                "stdout",
            )
            const followUpTask = buildKaliProvisionerRetryTask(env, check, round)
            logProvisionerTaskToStream(followUpTask, onLine, `Agent 用户消息（追问 ${round}）`)
            agentRounds++
            await prompt(followUpTask)
            check = await checkKaliToolsOnRemote(target, signal)
            onLine(`[provision] 复核：${check.ready.length} 就绪，${check.missing.length} 仍缺`, "stdout")
            round++
        }
    })

    let finalCheck = check
    const agentOk = agentResult.agentOk

    if (finalCheck.missing.length > 0 && !signal?.aborted) {
        onLine(
            `[provision] Agent 经 ${agentRounds} 次对话仍缺 ${finalCheck.missing.length} 项，启用系统安装脚本（最后手段）…`,
            "stdout",
        )
        onLine(`[provision] 仍缺：${finalCheck.missing.join(", ")}`, "stdout")
        const scriptResult = await provisionKaliVps(target, onLine, signal, env)
        if (scriptResult.exitCode !== 0) {
            onLine(`[provision] 兜底脚本退出码 ${scriptResult.exitCode}`, "stdout")
        }
        finalCheck = await checkKaliToolsOnRemote(target, signal)
        onLine(
            `[provision] 兜底后：${finalCheck.ready.length} 就绪，${finalCheck.missing.length} 仍缺`,
            "stdout",
        )
    }

    const ok = finalCheck.missing.length === 0
    if (ok) {
        onLine("[provision] 全部 20 项工具已就绪。", "stdout")
    } else if (!signal?.aborted) {
        onLine(`[provision] 仍未就绪：${finalCheck.missing.join(", ")}`, "stdout")
    }

    await cleanupProvisionerPersistence()

    return {
        exitCode: ok ? 0 : 1,
        toolCheck: finalCheck,
    }
}
