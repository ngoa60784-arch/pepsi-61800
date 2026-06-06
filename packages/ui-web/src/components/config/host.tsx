import type { FormEvent } from "react"
import { useEffect, useState } from "react"
import { hostCapacity, hostPlannerPrompt, hostSettings, modelPrefs, planner } from "../../lib/api"
import type { HostCapacity } from "../../lib/api"
import type { HostSettings, PlannerHealth } from "../../lib/api"
import { useFetch } from "../../hooks/use-fetch"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { Textarea } from "../ui/textarea"

const DEFAULT_MAX_SOLVERS = 1
const DEFAULT_PLANNER_TICK_SECONDS = 30
const DEFAULT_STALE_TIMEOUT_MINUTES = 60
const NONE_MODEL_VALUE = "__none__"

function formatPlannerModelLabel(model: { provider: string; providerId?: string; modelId: string; name?: string }) {
    const provider = model.providerId ? `${model.provider} (${model.providerId})` : model.provider
    return `${provider}/${model.modelId}${model.name ? ` (${model.name})` : ""}`
}

function normalizeModelPrefId(value: unknown) {
    return value == null ? "" : String(value)
}

export function PlannerPage() {
    const { data, loading, error, reload } = useFetch(hostSettings.get)
    const { data: plannerPromptData, reload: reloadPlannerPrompt } = useFetch(hostPlannerPrompt.get)
    const { data: models } = useFetch(modelPrefs.list)
    const [maxSolvers, setMaxSolvers] = useState(String(DEFAULT_MAX_SOLVERS))
    const [execSurface, setExecSurface] = useState<"remote-vps" | "local-host">("remote-vps")
    const [plannerPromptContent, setPlannerPromptContent] = useState("")
    const [plannerModelId, setPlannerModelId] = useState("")
    const [defaultModelId, setDefaultModelId] = useState("")
    const [plannerTickSeconds, setPlannerTickSeconds] = useState(String(DEFAULT_PLANNER_TICK_SECONDS))
    const [staleTimeoutMinutes, setStaleTimeoutMinutes] = useState(String(DEFAULT_STALE_TIMEOUT_MINUTES))
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState("")
    const [plannerHealth, setPlannerHealth] = useState<PlannerHealth | null>(null)
    const [capacity, setCapacity] = useState<HostCapacity | null>(null)

    useEffect(() => {
        let cancelled = false
        void hostCapacity
            .get()
            .then((next) => {
                if (!cancelled) setCapacity(next)
            })
            .catch(() => {
                if (!cancelled) setCapacity(null)
            })
        return () => {
            cancelled = true
        }
    }, [])

    useEffect(() => {
        let cancelled = false
        async function loadPlannerHealth() {
            try {
                const health = await planner.health()
                if (!cancelled) setPlannerHealth(health)
            } catch {
                if (!cancelled) setPlannerHealth(null)
            }
        }
        void loadPlannerHealth()
        const timer = setInterval(() => void loadPlannerHealth(), 15_000)
        return () => {
            cancelled = true
            clearInterval(timer)
        }
    }, [])

    useEffect(() => {
        setMaxSolvers(String(data?.runtime.maxSolvers ?? DEFAULT_MAX_SOLVERS))
        setExecSurface(data?.runtime.execSurface === "local-host" ? "local-host" : "remote-vps")
        setPlannerTickSeconds(String(Math.max(5, Math.round((data?.planner.tickIntervalMs ?? DEFAULT_PLANNER_TICK_SECONDS * 1000) / 1000))))
        setStaleTimeoutMinutes(String(Math.max(1, Math.round((data?.planner.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MINUTES * 60 * 1000) / 60000))))
        setDefaultModelId(normalizeModelPrefId(data?.defaultModelPrefId))
    }, [data])

    useEffect(() => {
        setPlannerPromptContent(plannerPromptData?.content ?? "")
        setPlannerModelId(normalizeModelPrefId(plannerPromptData?.meta.model))
    }, [plannerPromptData])

    async function handleSave(event: FormEvent) {
        event.preventDefault()
        setSaving(true)
        setMessage("")
        try {
            const runtime: HostSettings["runtime"] = {
                maxSolvers: Math.max(0, Number(maxSolvers) || DEFAULT_MAX_SOLVERS),
                execSurface,
            }
            const planner = {
                enabled: true,
                tickIntervalMs: Math.max(5, Number(plannerTickSeconds) || DEFAULT_PLANNER_TICK_SECONDS) * 1000,
                staleTimeoutMs: Math.max(1, Number(staleTimeoutMinutes) || DEFAULT_STALE_TIMEOUT_MINUTES) * 60 * 1000,
            }

            let syncNote = ""
            const defaultId = defaultModelId.trim()
            if (defaultId) {
                const result = await modelPrefs.activate(defaultId)
                const parts = [
                    "已同步全部 Agent",
                    result.plannerUpdated ? "调度器" : null,
                    result.promptsUpdated > 0 ? `${result.promptsUpdated} 个 Prompt` : null,
                    result.verifierUpdated ? "验证器" : null,
                ].filter(Boolean)
                syncNote = parts.join("，")
                await hostSettings.set({ runtime, planner })
            } else {
                await hostSettings.set({ runtime, planner, defaultModelPrefId: undefined })
            }

            const plannerModel = plannerModelId.trim() || defaultId || undefined
            await hostPlannerPrompt.set(plannerPromptContent, plannerModel)

            setMessage(syncNote ? `已保存；${syncNote}` : "已保存")
            reload()
            reloadPlannerPrompt()
        } catch (error) {
            setMessage(error instanceof Error ? error.message : String(error))
        } finally {
            setSaving(false)
        }
    }

    return (
        <form onSubmit={handleSave} className="space-y-4">
            {plannerHealth?.alerting && (
                <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-900 dark:text-rose-200">
                    调度器已连续失败 {plannerHealth.consecutiveFailures} 次。
                    {plannerHealth.lastError ? ` 最近错误：${plannerHealth.lastError}` : null}
                    {plannerHealth.currentTickIntervalMs > plannerHealth.baseTickIntervalMs
                        ? ` 当前 tick 已退避至 ${Math.round(plannerHealth.currentTickIntervalMs / 1000)} 秒。`
                        : null}
                </div>
            )}
            <div className="space-y-4 rounded-lg border p-4">
                <div className="space-y-1">
                    <div className="text-sm font-medium">调度器运行时</div>
                    <div className="text-sm text-muted-foreground">
                        调度器自动调度始终开启。Solver 以本机进程运行；打靶命令默认经 kali-arsenal 远程 Kali，也可配置为本机执行。
                    </div>
                </div>
                <div className="space-y-2">
                    <Label>命令执行位置</Label>
                    <Select
                        value={execSurface}
                        onValueChange={(value) => setExecSurface(value === "local-host" ? "local-host" : "remote-vps")}
                    >
                        <SelectTrigger>
                            <SelectValue placeholder="选择执行面" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="remote-vps">远程 VPS（kali-arsenal）</SelectItem>
                            <SelectItem value="local-host">本机（bash）</SelectItem>
                        </SelectContent>
                    </Select>
                    <div className="text-sm text-muted-foreground">
                        注入 `TCH_EXEC_SURFACE` 到 Solver；`本机` 时 Prompt 允许本地 bash 扫打授权目标。
                    </div>
                </div>
                <div className="space-y-2">
                    <Label htmlFor="runtime-max-solvers">最大 Solver 数</Label>
                    <Input
                        id="runtime-max-solvers"
                        type="number"
                        min="0"
                        value={maxSolvers}
                        onChange={(event) => setMaxSolvers(event.target.value)}
                    />
                    <div className="text-sm text-muted-foreground">调度器最多同时保留多少个 solver。`0` 等价于暂停自动调度。</div>
                </div>
                {capacity && (
                    <div className="rounded-lg border border-border/85 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                        宿主机约 {capacity.total_memory_mb} MB 内存、{capacity.cpu_count} 核。
                        推荐每 Solver：内存 {capacity.recommended_memory}、CPU {capacity.recommended_cpus}（多 Solver 并行时请自行估算总占用）。
                    </div>
                )}
                <div className="space-y-2">
                    <Label>默认 Agent 模型（所有 AI 统一使用）</Label>
                    <Select
                        value={defaultModelId || NONE_MODEL_VALUE}
                        onValueChange={(value) => {
                            const id = value === NONE_MODEL_VALUE ? "" : (value ?? "")
                            setDefaultModelId(id)
                            if (id) setPlannerModelId(id)
                        }}
                    >
                        <SelectTrigger>
                            <SelectValue placeholder="选择默认模型">
                                {(() => {
                                    const model = models?.find((item) => item.id === defaultModelId)
                                    if (!defaultModelId) return "（用第一个可用模型）"
                                    if (!model) return defaultModelId
                                    return formatPlannerModelLabel(model)
                                })()}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={NONE_MODEL_VALUE}>（用第一个可用模型）</SelectItem>
                            {(models ?? []).map((model) => (
                                <SelectItem key={model.id} value={model.id}>
                                    {formatPlannerModelLabel(model)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <div className="text-sm text-muted-foreground">
                        保存时会与「模型」页的「启用」相同：写入系统默认，并同步调度器及全部 Agent/子 Agent/验证器的模型。下方「调度器模型」会随此项联动；若需仅改调度器可单独改后再保存。
                    </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                        <Label htmlFor="planner-tick-seconds">调度器 Tick 间隔（秒）</Label>
                        <Input
                            id="planner-tick-seconds"
                            type="number"
                            min="5"
                            value={plannerTickSeconds}
                            onChange={(event) => setPlannerTickSeconds(event.target.value)}
                        />
                        <div className="text-sm text-muted-foreground">challenge 同步完成后，按这个间隔进入下一轮规划。最小 5 秒。</div>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="planner-stale-timeout">停滞超时（分钟）</Label>
                        <Input
                            id="planner-stale-timeout"
                            type="number"
                            min="1"
                            value={staleTimeoutMinutes}
                            onChange={(event) => setStaleTimeoutMinutes(event.target.value)}
                        />
                        <div className="text-sm text-muted-foreground">某题占用 solver 超过这个时长后，会被视为停滞，调度器可把窗口让给别的题。</div>
                    </div>
                </div>
            </div>

            <div className="space-y-2 rounded-lg border p-4">
                <div className="space-y-1">
                    <Label htmlFor="planner-prompt-content">调度器系统提示词</Label>
                    <div className="text-sm text-muted-foreground">
                        配置调度器系统提示词。模型默认与上方「默认 Agent 模型」一致；保存默认时会自动写入 CHALLENGE_PLANNER。
                    </div>
                </div>
                <div className="space-y-2">
                    <Label>调度器模型</Label>
                    <Select value={plannerModelId || NONE_MODEL_VALUE} onValueChange={(value) => setPlannerModelId(value === NONE_MODEL_VALUE ? "" : (value ?? ""))}>
                        <SelectTrigger>
                            <SelectValue placeholder="选择调度器模型">
                                {(() => {
                                    const model = models?.find((item) => item.id === plannerModelId)
                                    if (!plannerModelId) return "不指定"
                                    if (!model) return plannerModelId
                                    return formatPlannerModelLabel(model)
                                })()}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={NONE_MODEL_VALUE}>不指定</SelectItem>
                            {(models ?? []).map((model) => (
                                <SelectItem key={model.id} value={model.id}>
                                    {formatPlannerModelLabel(model)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <Textarea
                    id="planner-prompt-content"
                    value={plannerPromptContent}
                    onChange={(event) => setPlannerPromptContent(event.target.value)}
                    rows={14}
                />
            </div>

            <div className="flex items-center gap-3">
                <Button type="submit" disabled={saving}>
                    {saving ? "保存中…" : "保存"}
                </Button>
                {loading && <span className="text-sm text-muted-foreground">加载中…</span>}
                {!loading && message && <span className="text-sm text-muted-foreground">{message}</span>}
                {!loading && error && <span className="text-sm text-red-500">{error}</span>}
            </div>
        </form>
    )
}
