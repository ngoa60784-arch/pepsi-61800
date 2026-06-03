import type { FormEvent } from "react"
import { useEffect, useState } from "react"
import { hostPlannerPrompt, hostSettings, modelPrefs, providers } from "../../lib/api"
import type { ProviderEntry } from "../../lib/api"
import { useFetch } from "../../hooks/use-fetch"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { Switch } from "../ui/switch"
import { Textarea } from "../ui/textarea"

const DEFAULT_MAX_SOLVERS = 1
const DEFAULT_PLANNER_TICK_SECONDS = 30
const DEFAULT_STALE_TIMEOUT_MINUTES = 60
const DEFAULT_RUNTIME_NETWORK_MODE = "host"
const NONE_MODEL_VALUE = "__none__"

function formatPlannerModelLabel(model: { provider: string; providerId?: string; modelId: string; name?: string }) {
    const provider = model.providerId ? `${model.provider} (${model.providerId})` : model.provider
    return `${provider}/${model.modelId}${model.name ? ` (${model.name})` : ""}`
}

function normalizeModelPrefId(value: unknown) {
    return value == null ? "" : String(value)
}

function normalizeBaseUrl(baseUrl?: string) {
    const text = baseUrl?.trim()
    if (!text) return ""
    return text.replace(/\/+$/, "")
}

function formatProviderNames(providers: ProviderEntry[]) {
    return providers.map((item) => `${item.name} (${item.id})`).join(", ")
}

function buildProviderBaseUrlItems(providerList: ProviderEntry[] | null | undefined) {
    const grouped = new Map<string, ProviderEntry[]>()
    for (const item of providerList ?? []) {
        const key = normalizeBaseUrl(item.baseUrl)
        if (!key) continue
        const list = grouped.get(key) ?? []
        list.push(item)
        grouped.set(key, list)
    }
    return [...grouped.entries()]
        .map(([baseUrl, items]) => ({ baseUrl, items }))
        .sort((a, b) => a.baseUrl.localeCompare(b.baseUrl))
}

export function HostPage() {
    const { data, loading, error, reload } = useFetch(hostSettings.get)
    const { data: providerList } = useFetch(providers.list)
    const [mockEnabled, setMockEnabled] = useState(false)
    const [answerModeEnabled, setAnswerModeEnabled] = useState(false)
    const [apiBaseUrl, setApiBaseUrl] = useState("")
    const [agentToken, setAgentToken] = useState("")
    const [baseUrlMappings, setBaseUrlMappings] = useState<Record<string, string>>({})
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState("")

    const providerBaseUrlItems = buildProviderBaseUrlItems(providerList)
    const providerBaseUrlKeys = providerBaseUrlItems.map((item) => item.baseUrl).join("\n")

    useEffect(() => {
        setMockEnabled(data?.challenge.mockEnabled === true)
        setAnswerModeEnabled(data?.challenge.answerModeEnabled === true)
        setApiBaseUrl(data?.challenge.apiBaseUrl ?? "")
        setAgentToken(data?.challenge.agentToken ?? "")
    }, [data])

    useEffect(() => {
        const mappingBySourceBaseUrl: Record<string, string> = {}
        for (const item of data?.challenge.baseUrlMappings ?? []) {
            const key = normalizeBaseUrl(item.sourceBaseUrl)
            if (!key) continue
            mappingBySourceBaseUrl[key] = item.gatewayBaseUrl ?? ""
        }
        setBaseUrlMappings((current) => {
            const next: Record<string, string> = {}
            for (const { baseUrl } of providerBaseUrlItems) {
                const savedValue = mappingBySourceBaseUrl[baseUrl]
                next[baseUrl] = savedValue && savedValue.trim().length > 0 ? savedValue : (current[baseUrl] ?? "")
            }
            return next
        })
    }, [data?.challenge.baseUrlMappings, providerBaseUrlKeys])

    useEffect(() => {
        setBaseUrlMappings((current) => {
            const next: Record<string, string> = {}
            let changed = false
            for (const { baseUrl } of providerBaseUrlItems) {
                const value = current[baseUrl] ?? ""
                next[baseUrl] = value
                if (!(baseUrl in current)) changed = true
            }
            if (!changed && Object.keys(current).length === Object.keys(next).length) {
                return current
            }
            return next
        })
    }, [providerBaseUrlKeys])

    async function handleSave(event: FormEvent) {
        event.preventDefault()
        setSaving(true)
        setMessage("")
        try {
            await hostSettings.set({
                challenge: {
                    mockEnabled,
                    answerModeEnabled,
                    apiBaseUrl: apiBaseUrl.trim() || undefined,
                    agentToken: agentToken.trim() || undefined,
                    baseUrlMappings: providerBaseUrlItems
                        .map(({ baseUrl }) => ({
                            sourceBaseUrl: baseUrl,
                            gatewayBaseUrl: normalizeBaseUrl(baseUrlMappings[baseUrl]),
                        }))
                        .filter((item) => item.gatewayBaseUrl),
                },
                ...(answerModeEnabled
                    ? {
                          planner: {
                              enabled: true,
                          },
                      }
                    : {}),
            })
            setMessage("已保存")
            reload()
        } catch (error) {
            setMessage(error instanceof Error ? error.message : String(error))
        } finally {
            setSaving(false)
        }
    }

    return (
        <form onSubmit={handleSave} className="space-y-4">
            <div className="space-y-4 rounded-lg border p-4">
                <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium">目标来源</div>
                    <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">Mock 模式</span>
                        <Switch id="challenge-mock-enabled" checked={mockEnabled} onCheckedChange={setMockEnabled} />
                    </div>
                </div>
                <div className="space-y-2">
                    <Label htmlFor="challenge-api-base-url">API 基址</Label>
                    <Input
                        id="challenge-api-base-url"
                        placeholder="https://challenge.example.com"
                        value={apiBaseUrl}
                        onChange={(event) => setApiBaseUrl(event.target.value)}
                        disabled={mockEnabled}
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="challenge-agent-token">Agent 令牌</Label>
                    <Input
                        id="challenge-agent-token"
                        type="password"
                        placeholder="agent-token"
                        value={agentToken}
                        onChange={(event) => setAgentToken(event.target.value)}
                        disabled={mockEnabled}
                    />
                </div>
            </div>

            <div className="space-y-4 rounded-lg border p-4">
                <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium">答题模式</div>
                    <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">启用</span>
                        <Switch id="challenge-answer-mode-enabled" checked={answerModeEnabled} onCheckedChange={setAnswerModeEnabled} />
                    </div>
                </div>
                <div className="space-y-3">
                    <div className="text-sm font-medium">API 基址映射</div>
                    {providerBaseUrlItems.length === 0 ? (
                        <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">尚未配置 Provider API 基址。</div>
                    ) : (
                        <div className="space-y-3">
                            {providerBaseUrlItems.map(({ baseUrl, items }) => (
                                <GatewayMappingRow
                                    key={baseUrl}
                                    baseUrl={baseUrl}
                                    providers={items}
                                    gatewayBaseUrl={baseUrlMappings[baseUrl] ?? ""}
                                    onGatewayBaseUrlChange={(value) =>
                                        setBaseUrlMappings((current) => ({
                                            ...current,
                                            [baseUrl]: value,
                                        }))
                                    }
                                />
                            ))}
                        </div>
                    )}
                </div>
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

function GatewayMappingRow(props: {
    baseUrl: string
    providers: ProviderEntry[]
    gatewayBaseUrl: string
    onGatewayBaseUrlChange: (value: string) => void
}) {
    const { baseUrl, providers, gatewayBaseUrl, onGatewayBaseUrlChange } = props
    const hasValue = gatewayBaseUrl.trim().length > 0

    return (
        <div className="grid gap-3 rounded-lg border p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">原始 API 基址</div>
                <div className="break-all rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs">{baseUrl}</div>
                <div className="text-xs text-muted-foreground">{formatProviderNames(providers)}</div>
            </div>
            <div className="space-y-1">
                <Label htmlFor={`gateway-base-url-${baseUrl}`}>Gateway 基址</Label>
                <Input
                    id={`gateway-base-url-${baseUrl}`}
                    value={gatewayBaseUrl}
                    onChange={(event) => onGatewayBaseUrlChange(event.target.value)}
                    placeholder="http://10.0.0.24/64_xxxxxxxx"
                    className={hasValue ? "border-green-500/40 bg-green-500/5 font-mono text-green-700 dark:text-green-400" : ""}
                />
            </div>
        </div>
    )
}

export function PlannerPage() {
    const { data, loading, error, reload } = useFetch(hostSettings.get)
    const { data: plannerPromptData, reload: reloadPlannerPrompt } = useFetch(hostPlannerPrompt.get)
    const { data: models } = useFetch(modelPrefs.list)
    const [maxSolvers, setMaxSolvers] = useState(String(DEFAULT_MAX_SOLVERS))
    const [networkMode, setNetworkMode] = useState(DEFAULT_RUNTIME_NETWORK_MODE)
    const [memory, setMemory] = useState("")
    const [cpus, setCpus] = useState("")
    const [plannerPromptContent, setPlannerPromptContent] = useState("")
    const [plannerModelId, setPlannerModelId] = useState("")
    const [defaultModelId, setDefaultModelId] = useState("")
    const [plannerTickSeconds, setPlannerTickSeconds] = useState(String(DEFAULT_PLANNER_TICK_SECONDS))
    const [staleTimeoutMinutes, setStaleTimeoutMinutes] = useState(String(DEFAULT_STALE_TIMEOUT_MINUTES))
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState("")

    useEffect(() => {
        setMaxSolvers(String(data?.runtime.maxSolvers ?? DEFAULT_MAX_SOLVERS))
        setNetworkMode(data?.runtime.networkMode === "bridge" ? "bridge" : DEFAULT_RUNTIME_NETWORK_MODE)
        setMemory(data?.runtime.memory ?? "")
        setCpus(data?.runtime.cpus != null ? String(data.runtime.cpus) : "")
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
            await hostPlannerPrompt.set(plannerPromptContent, plannerModelId || undefined)
            await hostSettings.set({
                runtime: {
                    maxSolvers: Math.max(0, Number(maxSolvers) || DEFAULT_MAX_SOLVERS),
                    networkMode: networkMode === "bridge" ? "bridge" : "host",
                    memory: memory.trim() || undefined,
                    cpus: cpus.trim() && Number(cpus) > 0 ? Number(cpus) : undefined,
                },
                planner: {
                    enabled: true,
                    tickIntervalMs: Math.max(5, Number(plannerTickSeconds) || DEFAULT_PLANNER_TICK_SECONDS) * 1000,
                    staleTimeoutMs: Math.max(1, Number(staleTimeoutMinutes) || DEFAULT_STALE_TIMEOUT_MINUTES) * 60 * 1000,
                },
                defaultModelPrefId: defaultModelId || undefined,
            })
            setMessage("已保存")
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
            <div className="space-y-4 rounded-lg border p-4">
                <div className="space-y-1">
                    <div className="text-sm font-medium">调度器运行时</div>
                    <div className="text-sm text-muted-foreground">调度器自动调度始终开启。这里控制 tick 频率、超时和并发上限；策略文案在目标页面配置。</div>
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
                <div className="space-y-2">
                    <Label>Docker 网络模式</Label>
                    <Select value={networkMode} onValueChange={(value) => setNetworkMode(value === "bridge" ? "bridge" : "host")}>
                        <SelectTrigger>
                            <SelectValue placeholder="选择容器网络模式" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="host">host</SelectItem>
                            <SelectItem value="bridge">bridge</SelectItem>
                        </SelectContent>
                    </Select>
                    <div className="text-sm text-muted-foreground">solver 容器启动时使用的 Docker 网络模式。</div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                        <Label htmlFor="runtime-memory">内存上限 / Solver</Label>
                        <Input
                            id="runtime-memory"
                            placeholder="如 2g、512m（留空 = 不限制）"
                            value={memory}
                            onChange={(event) => setMemory(event.target.value)}
                        />
                        <div className="text-sm text-muted-foreground">单个 solver 容器内存上限（Docker `--memory`）。防止失控扫描/爆破吃满宿主。仅 docker 后端生效。</div>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="runtime-cpus">CPU 上限 / Solver</Label>
                        <Input
                            id="runtime-cpus"
                            type="number"
                            min="0"
                            step="0.5"
                            placeholder="如 1.5、2（留空 = 不限制）"
                            value={cpus}
                            onChange={(event) => setCpus(event.target.value)}
                        />
                        <div className="text-sm text-muted-foreground">单个 solver 容器 CPU 核数上限（Docker `--cpus`）。仅 docker 后端生效。</div>
                    </div>
                </div>
                <div className="space-y-2">
                    <Label>默认 Agent 模型（所有 AI 统一使用）</Label>
                    <Select value={defaultModelId || NONE_MODEL_VALUE} onValueChange={(value) => setDefaultModelId(value === NONE_MODEL_VALUE ? "" : (value ?? ""))}>
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
                        调度层(planner)、执行层(solver)、验证(verifier)、指挥官(commander)、观察者(observer)在各自提示词未单独指定模型时，统一使用这个模型。留空则用第一个可用模型。
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
                    <div className="text-sm text-muted-foreground">配置演练规划 agent 的系统提示词和默认模型。</div>
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
