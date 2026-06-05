import { useEffect, useMemo, useRef, useState } from "react"
import { CheckCircle2, Loader2, Server, Wrench, XCircle } from "lucide-react"
import { formatKaliEnvFields, hasFofaCredentials, KALI_OPTIONAL_TOOLS, parseProvisionLogSummary } from "@tch/core/ui"
import { mcpServers } from "../../lib/api"
import type { KaliProvisionEvent, KaliToolCheckResult } from "../../lib/api"

const OPTIONAL_TOOLS = KALI_OPTIONAL_TOOLS
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"

function parseEnvLines(text: string): Record<string, string> {
    const fields: Record<string, string> = {}
    for (const line of text.trim().split("\n")) {
        const eq = line.indexOf("=")
        if (eq <= 0) continue
        fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    return fields
}

/** Merge streaming fragments; keep one line per provision/agent/script event. */
function appendProvisionLogLine(prev: string[], line: string): string[] {
    const trimmed = line.trimEnd()
    if (!trimmed) return prev
    if (prev.length === 0) return [trimmed]
    const last = prev[prev.length - 1]!
    const isStructured =
        trimmed.startsWith("[provision]") ||
        trimmed.startsWith("[agent]") ||
        trimmed.startsWith("[stderr]") ||
        trimmed.startsWith("[error]")
    const lastStructured =
        last.startsWith("[provision]") ||
        last.startsWith("[agent]") ||
        last.startsWith("[stderr]") ||
        last.startsWith("[error]")
    if (!isStructured && !lastStructured && last.length < 4000) {
        return [...prev.slice(0, -1), last + trimmed]
    }
    return [...prev, trimmed]
}


function ToolSummaryBlock({
    title,
    tools,
    variant,
    paths,
}: {
    title: string
    tools: string[]
    variant: "ok" | "miss"
    paths?: Record<string, string>
}) {
    if (tools.length === 0) return null
    return (
        <div className="space-y-2">
            <div className={`flex items-center gap-1.5 text-xs font-medium ${variant === "ok" ? "text-emerald-400" : "text-amber-400"}`}>
                {variant === "ok" ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
                {title}（{tools.length}）
            </div>
            <div className="flex flex-wrap gap-1.5">
                {tools.map((tool) => (
                    <Badge
                        key={tool}
                        variant={variant === "ok" ? "secondary" : "outline"}
                        className="font-mono text-[11px]"
                        title={paths?.[tool] ?? (OPTIONAL_TOOLS.has(tool) ? "可选工具，缺失不影响大部分打靶" : undefined)}
                    >
                        {tool}
                        {OPTIONAL_TOOLS.has(tool) && variant === "miss" ? " (可选)" : ""}
                    </Badge>
                ))}
            </div>
        </div>
    )
}

function ProvisionToolSummary({ summary }: { summary: KaliToolCheckResult }) {
    const total = summary.ready.length + summary.missing.length
    const pathMap: Record<string, string> = {}
    for (const e of summary.entries ?? []) {
        if (e.ok && e.path) pathMap[e.tool] = e.path
    }
    const requiredMissing = summary.missing.filter((t) => !OPTIONAL_TOOLS.has(t))
    const optionalMissing = summary.missing.filter((t) => OPTIONAL_TOOLS.has(t))
    return (
        <div className="space-y-3 rounded-md border bg-background p-3">
            <p className="text-xs text-muted-foreground">
                共检测 {total} 项：{summary.ready.length} 项可用
                {summary.missing.length > 0
                    ? `，${requiredMissing.length} 项核心未装上${optionalMissing.length > 0 ? `（另有 ${optionalMissing.length} 项可选）` : ""}`
                    : "。"}
                {requiredMissing.length > 0
                    ? " 请再跑一次「一键配置环境」（Agent 会按缺失项继续安装）。"
                    : optionalMissing.length > 0
                      ? " 可选工具缺失不影响常规打靶。"
                      : ""}
            </p>
            <ToolSummaryBlock title="已就绪" tools={summary.ready} variant="ok" paths={pathMap} />
            {requiredMissing.length > 0 && <ToolSummaryBlock title="核心未装上" tools={requiredMissing} variant="miss" />}
            {optionalMissing.length > 0 && <ToolSummaryBlock title="可选未装上" tools={optionalMissing} variant="miss" />}
        </div>
    )
}

interface KaliArsenalPanelProps {
    envText: string
    onEnvChange: (text: string) => void
    disabled?: boolean
}

export function KaliArsenalPanel({ envText, onEnvChange, disabled }: KaliArsenalPanelProps) {
    const fields = useMemo(() => parseEnvLines(envText), [envText])
    const [sshTestOk, setSshTestOk] = useState<boolean | null>(null)
    const [sshTestMessage, setSshTestMessage] = useState("")
    const [sshTesting, setSshTesting] = useState(false)
    const [provisioning, setProvisioning] = useState(false)
    const [provisionLogs, setProvisionLogs] = useState<string[]>([])
    const [provisionDone, setProvisionDone] = useState<{ ok: boolean; exitCode: number } | null>(null)
    const [toolSummary, setToolSummary] = useState<KaliToolCheckResult | null>(null)
    const [toolChecking, setToolChecking] = useState(false)
    const [keysSyncing, setKeysSyncing] = useState(false)
    const [keysSyncOk, setKeysSyncOk] = useState<boolean | null>(null)
    const [keysSyncMessage, setKeysSyncMessage] = useState("")
    const [showFullLog, setShowFullLog] = useState(false)
    const abortRef = useRef<AbortController | null>(null)
    const logEndRef = useRef<HTMLDivElement | null>(null)

    const logSummary = useMemo(() => parseProvisionLogSummary(provisionLogs), [provisionLogs])
    const displaySummary = toolSummary ?? logSummary
    const logText = useMemo(() => provisionLogs.join("\n"), [provisionLogs])

    useEffect(() => {
        if (showFullLog && logEndRef.current) {
            logEndRef.current.scrollIntoView({ block: "nearest" })
        }
    }, [logText, showFullLog, provisioning])

    function setField(key: string, value: string) {
        setSshTestOk(null)
        setSshTestMessage("")
        onEnvChange(formatKaliEnvFields({ ...fields, [key]: value }))
    }

    async function handleTestSsh() {
        setSshTesting(true)
        setSshTestOk(null)
        setSshTestMessage("")
        try {
            const result = await mcpServers.testKaliSsh(fields)
            setSshTestOk(result.ok)
            setSshTestMessage(result.message)
        } catch (error) {
            setSshTestOk(false)
            setSshTestMessage(error instanceof Error ? error.message : String(error))
        } finally {
            setSshTesting(false)
        }
    }

    async function handleCheckTools() {
        setToolChecking(true)
        setToolSummary(null)
        try {
            const result = await mcpServers.checkKaliTools(fields)
            setToolSummary(result)
        } catch (error) {
            setSshTestMessage(error instanceof Error ? error.message : String(error))
        } finally {
            setToolChecking(false)
        }
    }

    async function handleProvision() {
        if (!sshTestOk) return
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller
        setProvisioning(true)
        setProvisionLogs([])
        setProvisionDone(null)
        setToolSummary(null)
        setShowFullLog(false)
        let provisionSucceeded = false

        const appendLog = (event: KaliProvisionEvent) => {
            if (event.type === "log") {
                const prefix = event.stream === "stderr" ? "[stderr] " : ""
                setProvisionLogs((prev) => {
                    const next = appendProvisionLogLine(prev, `${prefix}${event.line}`)
                    const parsed = parseProvisionLogSummary(next)
                    if (parsed) setToolSummary(parsed)
                    return next
                })
            } else if (event.type === "done") {
                provisionSucceeded = event.ok
                setProvisionDone({ ok: event.ok, exitCode: event.exitCode })
                setShowFullLog(false)
            } else if (event.type === "error") {
                setProvisionLogs((prev) => appendProvisionLogLine(prev, `[error] ${event.message}`))
                setProvisionDone({ ok: false, exitCode: 1 })
                setShowFullLog(false)
            }
        }

        try {
            await mcpServers.provisionKali(fields, appendLog, controller.signal)
        } catch (error) {
            if (!controller.signal.aborted) {
                setProvisionLogs((prev) => [...prev, error instanceof Error ? error.message : String(error)])
                setProvisionDone({ ok: false, exitCode: 1 })
            }
        } finally {
            setProvisioning(false)
            abortRef.current = null
            try {
                const result = await mcpServers.checkKaliTools(fields)
                setToolSummary(result)
            } catch {
                // 保留安装日志中解析出的清单
            }
            if (hasFofaCredentials(fields) && sshTestOk && provisionSucceeded) {
                try {
                    const sync = await mcpServers.syncKaliPentestKeys(fields)
                    setKeysSyncOk(sync.ok)
                    setKeysSyncMessage(sync.message)
                } catch {
                    // 用户可手动点「同步 FOFA 到 Kali」
                }
            }
        }
    }

    function handleCancelProvision() {
        abortRef.current?.abort()
        setProvisioning(false)
    }

    async function handleSyncPentestKeys() {
        setKeysSyncing(true)
        setKeysSyncOk(null)
        setKeysSyncMessage("")
        try {
            const result = await mcpServers.syncKaliPentestKeys(fields)
            setKeysSyncOk(result.ok)
            setKeysSyncMessage(result.message)
        } catch (error) {
            setKeysSyncOk(false)
            setKeysSyncMessage(error instanceof Error ? error.message : String(error))
        } finally {
            setKeysSyncing(false)
        }
    }

    const useAlias = Boolean(fields.SSH_ALIAS?.trim())
    const fofaReady = hasFofaCredentials(fields)

    return (
        <div className="space-y-4 rounded-lg border border-primary/20 bg-primary/5 p-4">
            <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <Server className="size-4" />
                    远程 Kali（kali-arsenal SSH）
                </div>
                <p className="text-xs text-muted-foreground">
                    Solver 在本地 Docker 运行；打靶命令走此 SSH。「一键配置环境」由 Agent <strong>排查并装全</strong> 20 项（同一会话内多轮追问，非机械执行命令）；仍缺时最后才跑系统脚本。需默认模型。国外 VPS 请勿填 <code className="text-[10px]">TCH_GH_MIRROR</code>。
                </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="kali-ssh-alias">SSH 别名（可选，~/.ssh/config）</Label>
                    <Input
                        id="kali-ssh-alias"
                        placeholder="kali-vps"
                        value={fields.SSH_ALIAS ?? ""}
                        disabled={disabled}
                        onChange={(e) => setField("SSH_ALIAS", e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">填写后优先走别名（支持密钥、ProxyJump）；可不填下方主机密码。</p>
                </div>
                {!useAlias && (
                    <>
                        <div className="space-y-1.5">
                            <Label htmlFor="kali-ssh-host">SSH_HOST</Label>
                            <Input
                                id="kali-ssh-host"
                                placeholder="203.0.113.10"
                                value={fields.SSH_HOST ?? ""}
                                disabled={disabled}
                                onChange={(e) => setField("SSH_HOST", e.target.value)}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="kali-ssh-port">SSH_PORT</Label>
                            <Input
                                id="kali-ssh-port"
                                placeholder="22"
                                value={fields.SSH_PORT ?? "22"}
                                disabled={disabled}
                                onChange={(e) => setField("SSH_PORT", e.target.value)}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="kali-ssh-user">SSH_USER</Label>
                            <Input
                                id="kali-ssh-user"
                                placeholder="root"
                                value={fields.SSH_USER ?? "root"}
                                disabled={disabled}
                                onChange={(e) => setField("SSH_USER", e.target.value)}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="kali-ssh-pass">SSH_PASS</Label>
                            <Input
                                id="kali-ssh-pass"
                                type="password"
                                placeholder="密码（密钥登录可留空）"
                                value={fields.SSH_PASS ?? ""}
                                disabled={disabled}
                                onChange={(e) => setField("SSH_PASS", e.target.value)}
                            />
                        </div>
                    </>
                )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 rounded-md border border-dashed p-3">
                <div className="space-y-1 sm:col-span-2 text-xs font-medium text-muted-foreground">
                    FOFA（可选，写入远程 <code className="text-[10px]">/root/.pentest-keys/keys.env</code>）
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor="kali-fofa-email">FOFA_EMAIL</Label>
                    <Input
                        id="kali-fofa-email"
                        type="email"
                        autoComplete="off"
                        placeholder="注册邮箱"
                        value={fields.FOFA_EMAIL ?? ""}
                        disabled={disabled}
                        onChange={(e) => setField("FOFA_EMAIL", e.target.value)}
                    />
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor="kali-fofa-key">FOFA_KEY</Label>
                    <Input
                        id="kali-fofa-key"
                        type="password"
                        autoComplete="off"
                        placeholder="API Key"
                        value={fields.FOFA_KEY ?? ""}
                        disabled={disabled}
                        onChange={(e) => setField("FOFA_KEY", e.target.value)}
                    />
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor="kali-fofa-email-2">FOFA_EMAIL_2（备用）</Label>
                    <Input
                        id="kali-fofa-email-2"
                        type="email"
                        autoComplete="off"
                        value={fields.FOFA_EMAIL_2 ?? ""}
                        disabled={disabled}
                        onChange={(e) => setField("FOFA_EMAIL_2", e.target.value)}
                    />
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor="kali-fofa-key-2">FOFA_KEY_2（备用）</Label>
                    <Input
                        id="kali-fofa-key-2"
                        type="password"
                        autoComplete="off"
                        value={fields.FOFA_KEY_2 ?? ""}
                        disabled={disabled}
                        onChange={(e) => setField("FOFA_KEY_2", e.target.value)}
                    />
                </div>
                <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={disabled || keysSyncing || !fofaReady || !sshTestOk}
                        onClick={handleSyncPentestKeys}
                        title={!fofaReady ? "请填写 FOFA_EMAIL 与 FOFA_KEY" : !sshTestOk ? "请先测试 SSH 连接" : undefined}
                    >
                        {keysSyncing ? <Loader2 className="size-4 mr-1.5 animate-spin" /> : null}
                        同步 FOFA 到 Kali
                    </Button>
                    <p className="text-xs text-muted-foreground">
                        保存 MCP 配置后密钥在本地 <code className="text-[10px]">mcp.json</code>；同步后远程 shell 可 source keys.env 供 pentest skill 使用。
                    </p>
                </div>
                {keysSyncMessage && (
                    <div
                        className={`sm:col-span-2 rounded-md border px-3 py-2 text-xs ${keysSyncOk ? "alert-success" : "alert-error"}`}
                    >
                        {keysSyncMessage}
                    </div>
                )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 rounded-md border border-dashed p-3">
                <div className="space-y-1 sm:col-span-2 text-xs font-medium text-muted-foreground">网络加速（可选，GitHub/Go 慢时填写）</div>
                <div className="space-y-1.5">
                    <Label htmlFor="kali-goproxy">TCH_GOPROXY</Label>
                    <Input
                        id="kali-goproxy"
                        placeholder="https://goproxy.cn,direct"
                        value={fields.TCH_GOPROXY ?? ""}
                        disabled={disabled}
                        onChange={(e) => setField("TCH_GOPROXY", e.target.value)}
                    />
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor="kali-gh-mirror">TCH_GH_MIRROR</Label>
                    <Input
                        id="kali-gh-mirror"
                        placeholder="https://mirror.ghproxy.com/"
                        value={fields.TCH_GH_MIRROR ?? ""}
                        disabled={disabled}
                        onChange={(e) => setField("TCH_GH_MIRROR", e.target.value)}
                    />
                </div>
            </div>

            {sshTestMessage && (
                <div
                    className={`rounded-md border px-3 py-2 text-xs ${sshTestOk ? "alert-success" : "alert-error"}`}
                >
                    {sshTestMessage}
                </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" disabled={disabled || sshTesting} onClick={handleTestSsh}>
                    {sshTesting ? <Loader2 className="size-4 mr-1.5 animate-spin" /> : null}
                    测试 SSH 连接
                </Button>
                <Button
                    type="button"
                    size="sm"
                    disabled={disabled || !sshTestOk || provisioning}
                    onClick={handleProvision}
                    title={!sshTestOk ? "请先测试连接并成功" : undefined}
                >
                    <Wrench className="size-4 mr-1.5" />
                    一键配置环境
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled || sshTesting || toolChecking || (!sshTestOk && !displaySummary)}
                    onClick={handleCheckTools}
                    title="SSH 连通后，远程检测 20 项核心工具是否在 PATH 中"
                >
                    {toolChecking ? <Loader2 className="size-4 mr-1.5 animate-spin" /> : null}
                    检测已装工具
                </Button>
                {provisioning && (
                    <Button type="button" variant="ghost" size="sm" onClick={handleCancelProvision}>
                        取消
                    </Button>
                )}
            </div>

            {displaySummary && <ProvisionToolSummary summary={displaySummary} />}

            {(provisioning || provisionLogs.length > 0) && (
                <div className="min-w-0 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                        <Label className="shrink-0">安装日志</Label>
                        {provisionLogs.length > 0 && (
                            <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={() => setShowFullLog((v) => !v)}>
                                {showFullLog ? "收起日志" : "展开完整日志"}
                            </Button>
                        )}
                    </div>
                    {provisioning && !showFullLog && (
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Loader2 className="size-3.5 shrink-0 animate-spin" />
                            Agent 正在远程安装… 结果见上方清单；需要细节可展开日志。
                        </p>
                    )}
                    {showFullLog && (
                        <div className="max-h-40 w-full min-w-0 overflow-y-auto overflow-x-auto rounded-md border bg-background p-3">
                            <pre className="w-full min-w-0 whitespace-pre-wrap break-words font-mono text-left text-[11px] leading-relaxed">
                                {logText || "正在启动 Agent 并通过 SSH 安装工具…"}
                            </pre>
                            <div ref={logEndRef} />
                        </div>
                    )}
                    {!showFullLog && !provisioning && provisionLogs.length > 0 && (
                        <p className="text-xs text-muted-foreground">日志已收起；安装结果见上方清单。需要排查时可点「展开完整日志」。</p>
                    )}
                    {provisionDone && (
                        <p className={`text-xs ${provisionDone.ok && displaySummary?.missing.length === 0 ? "text-emerald-400" : "text-amber-400"}`}>
                            {provisionDone.ok && displaySummary && displaySummary.missing.length === 0
                                ? "环境配置完成，20 项工具均已就绪。"
                                : `配置未完全成功（退出码 ${provisionDone.exitCode}）。见上方「未装上」清单；可展开日志查看兜底脚本输出，修正后重试。`}
                        </p>
                    )}
                </div>
            )}
        </div>
    )
}
