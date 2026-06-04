import { useState, useEffect } from "react"
import { hostSettings, modelPrefs, builtIn, providers } from "../../lib/api"
import type { ActivateModelResult } from "../../lib/api"
import type { ModelConfigEntry, ProviderEntry, Model, Api } from "../../lib/api"
import { useFetch } from "../../hooks/use-fetch"
import { Button } from "../ui/button"
import { Label } from "../ui/label"
import { Input } from "../ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { Badge } from "../ui/badge"
import { Switch } from "../ui/switch"
import { JsonEditorDialog } from "../ui/json-editor-dialog"

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const

function createLocalId(): string {
    if (typeof globalThis.crypto?.randomUUID === "function") {
        return globalThis.crypto.randomUUID().slice(0, 8)
    }
    return Math.random().toString(16).slice(2, 10)
}

function ThinkingLevelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    return (
        <Select value={value || "default"} onValueChange={(v) => onChange(!v || v === "default" ? "" : v)}>
            <SelectTrigger className="h-7 w-24 text-xs">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="default">default</SelectItem>
                {THINKING_LEVELS.map((l) => (
                    <SelectItem key={l} value={l}>{l}</SelectItem>
                ))}
            </SelectContent>
        </Select>
    )
}

function formatProviderLabel(provider: { provider: string; providerId?: string }) {
    return provider.providerId ? `${provider.provider} (${provider.providerId})` : provider.provider
}

export function ModelsPage() {
    const { data: configs, loading, reload } = useFetch(modelPrefs.list)
    const { data: host, reload: reloadHost } = useFetch(hostSettings.get)
    const { data: providerList } = useFetch(providers.list)
    const activeModelPrefId = host?.defaultModelPrefId?.trim() || ""

    const [recommendedModel, setRecommendedModel] = useState<Model<Api> | null>(null)
    const [selectedProvider, setSelectedProvider] = useState("")
    const [providerModelList, setProviderModelList] = useState<Partial<Model<Api>>[]>([])
    const [loadingModels, setLoadingModels] = useState(false)
    const [selectedModelId, setSelectedModelId] = useState("")
    const [customModelId, setCustomModelId] = useState("")

    // Configured providers come only from provider-prefs.
    type ProviderOption = { key: string; name: string; providerId?: string; label: string; api?: string }
    const providerOptions: ProviderOption[] = []
    if (providerList)
        for (const p of providerList) {
            const parts: string[] = [p.id]
            if (p.api) parts.push(p.api)
            if (p.baseUrl) parts.push(p.baseUrl.replace(/^https?:\/\//, "").split("/")[0])
            providerOptions.push({ key: p.id, name: p.name, providerId: p.id, api: p.api, label: parts.length > 0 ? `${p.name}  (${parts.join(" · ")})` : p.name })
        }
    const configuredProviders = providerOptions.map((o) => o.name)
    const selectedProviderOption = providerOptions.find((option) => option.key === selectedProvider)
    const selectedProviderName = selectedProviderOption?.name ?? ""
    const selectedRuntimeProvider = selectedProviderOption?.providerId ? `provider:${selectedProviderOption.providerId}` : selectedProviderName

    const effectiveModelId = selectedModelId === "__custom__" ? customModelId.trim() : selectedModelId

    // Fetch discovered models whenever provider changes
    useEffect(() => {
        if (!selectedProviderName) {
            setProviderModelList([])
            return
        }
        setLoadingModels(true)
        builtIn
            .discoverModels(selectedRuntimeProvider)
            .then((discovered) => {
                setProviderModelList(
                    discovered.map((d) => ({
                        provider: selectedProviderName,
                        id: d.id,
                        name: d.name,
                        api: "unknown",
                    })),
                )
                setLoadingModels(false)
            })
            .catch(() => {
                setProviderModelList([])
                setLoadingModels(false)
            })
    }, [selectedProviderName, selectedRuntimeProvider])

    // Filter models by configured protocol if set
    const configuredApi = selectedProviderOption?.api
    const filteredModels = configuredApi ? providerModelList.filter((m) => m.api === configuredApi || m.api === "unknown") : providerModelList

    const [addReasoning, setAddReasoning] = useState<boolean>(false)
    const [addContextWindow, setAddContextWindow] = useState("")
    const [addMaxTokens, setAddMaxTokens] = useState("")
    const [addThinkingLevel, setAddThinkingLevel] = useState("")

    const selectedListedModel = filteredModels.find((m) => m.id === effectiveModelId)
    const selectedCatalogModel = recommendedModel ?? undefined
    const selectedResolvedModel = selectedCatalogModel ?? selectedListedModel

    useEffect(() => {
        if (!effectiveModelId || !configuredApi) {
            setRecommendedModel(null)
            return
        }
        let cancelled = false
        builtIn
            .lookupModel(configuredApi, effectiveModelId)
            .then((model) => {
                if (cancelled) return
                setRecommendedModel(model)
            })
            .catch(() => {
                if (cancelled) return
                setRecommendedModel(null)
            })
        return () => {
            cancelled = true
        }
    }, [configuredApi, effectiveModelId])

    // 选择模型时，从目录预填
    useEffect(() => {
        if (!effectiveModelId || effectiveModelId === "__custom__") return
        const model = selectedResolvedModel
        if (model) {
            setAddReasoning(!!model.reasoning)
            setAddContextWindow(model.contextWindow ? String(model.contextWindow) : "")
            setAddMaxTokens(model.maxTokens ? String(model.maxTokens) : "")
        }
    }, [effectiveModelId, selectedResolvedModel])

    const [dupAlert, setDupAlert] = useState<string | null>(null)
    const [activatingId, setActivatingId] = useState<string | null>(null)
    const [activateAlert, setActivateAlert] = useState<{ ok: boolean; message: string } | null>(null)

    async function handleAdd() {
        if (!selectedProviderName || !effectiveModelId) return
        const baseModel = selectedResolvedModel
        const entry: ModelConfigEntry = {
            id: createLocalId(),
            provider: selectedProviderName,
            providerId: selectedProviderOption?.providerId,
            modelId: effectiveModelId,
            name: baseModel?.name,
            reasoning: addReasoning,
            contextWindow: parseInt(addContextWindow) || undefined,
            maxTokens: parseInt(addMaxTokens) || undefined,
            thinkingLevel: addThinkingLevel || undefined,
            ...(baseModel?.compat ? { compat: baseModel.compat } : {}),
            ...(baseModel?.cost ? { cost: baseModel.cost } : {}),
            ...(baseModel?.input ? { input: baseModel.input } : {}),
        }
        const result = await modelPrefs.add(entry)
        if (result.rejected) {
            setDupAlert(result.rejected)
            return
        }
        setSelectedModelId("")
        setCustomModelId("")
        setAddReasoning(false)
        setAddContextWindow("")
        setAddMaxTokens("")
        setAddThinkingLevel("")
        reload()
    }

    async function handleRemove(id: string) {
        await modelPrefs.remove(id)
        reload()
    }

    async function handleUpdate(entry: ModelConfigEntry, patch: Partial<ModelConfigEntry>) {
        const result = await modelPrefs.add({ ...entry, ...patch })
        if (result.rejected) {
            setDupAlert(result.rejected)
            reload()
            return
        }
        reload()
    }

    const [testingKey, setTestingKey] = useState<string | null>(null)
    const [testAlert, setTestAlert] = useState<{
        key: string
        ok: boolean
        message: string
        details?: {
            modelPrefId: string
            provider: string
            providerId?: string
            providerLabel: string
            runtimeProvider: string
            modelId: string
            api?: string
            baseUrl?: string
            baseOrigin?: string
            baseHost?: string
            basePath?: string
            thinkingLevel?: string
            reasoning?: boolean
            contextWindow?: number
            maxTokens?: number
            apiKeySummary?: string
            headers?: Record<string, string>
            compat?: Record<string, unknown>
        }
    } | null>(null)

    async function handleActivate(entry: ModelConfigEntry) {
        setActivatingId(entry.id)
        setActivateAlert(null)
        try {
            const result: ActivateModelResult = await modelPrefs.activate(entry.id)
            await reloadHost()
            const parts = [
                `已设为系统默认模型`,
                result.promptsUpdated > 0 ? `更新 ${result.promptsUpdated} 个 Prompt` : null,
                result.plannerUpdated ? "调度器" : null,
                result.verifierUpdated ? "验证器" : null,
            ].filter(Boolean)
            setActivateAlert({ ok: true, message: parts.join("，") })
        } catch (error) {
            setActivateAlert({ ok: false, message: error instanceof Error ? error.message : String(error) })
        } finally {
            setActivatingId(null)
        }
    }

    async function handleTest(id: string, label: string) {
        setTestingKey(id)
        setTestAlert(null)
        try {
            const result = await modelPrefs.test(id)
            setTestAlert({ key: label, ok: result.ok, message: result.ok ? result.response || "OK" : result.error || "失败", details: result.details })
        } catch (e: any) {
            setTestAlert({ key: label, ok: false, message: e.message || "请求失败" })
        } finally {
            setTestingKey(null)
        }
    }

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between">
                    <CardTitle>模型</CardTitle>
                    <Badge variant="secondary">{configs?.length ?? 0} 已配置</Badge>
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                {configuredProviders.length === 0 ? (
                    <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">尚未配置提供商，请先添加提供商。</div>
                ) : (
                    <>
                        <div className="grid gap-3 lg:grid-cols-[minmax(16rem,auto)_minmax(0,1fr)_auto]">
                            <div className="space-y-2">
                                <Label>提供商</Label>
                                <Select
                                    value={selectedProvider}
                                    onValueChange={(val) => {
                                        setSelectedProvider(val ?? "")
                                        setSelectedModelId("")
                                        setCustomModelId("")
                                        setAddReasoning(false)
                                        setAddContextWindow("")
                                        setAddMaxTokens("")
                                        setAddThinkingLevel("")
                                    }}
                                >
                                    <SelectTrigger>
                                        <SelectValue placeholder="选择提供商">{selectedProviderOption?.label}</SelectValue>
                                    </SelectTrigger>
                                    <SelectContent className="min-w-[var(--radix-select-trigger-width)] w-auto max-w-[32rem]">
                                        {providerOptions.map((o) => (
                                            <SelectItem key={o.key} value={o.key}>
                                                {o.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="min-w-0 space-y-2">
                                <Label>模型</Label>
                                {selectedModelId === "__custom__" ? (
                                    <div className="flex gap-1">
                                        <Input placeholder="model-id" value={customModelId} onChange={(e) => setCustomModelId(e.target.value)} />
                                        <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedModelId("")} className="shrink-0 text-xs">
                                            ×
                                        </Button>
                                    </div>
                                ) : (
                                    <Select value={selectedModelId} onValueChange={(val) => setSelectedModelId(val ?? "")} disabled={!selectedProvider || loadingModels}>
                                        <SelectTrigger>
                                            <SelectValue
                                                placeholder={
                                                    !selectedProvider
                                                        ? "请先选择 Provider"
                                                        : loadingModels
                                                          ? "加载模型中…"
                                                          : filteredModels.length === 0
                                                            ? "无模型（使用自定义）"
                                                            : "选择模型"
                                                }
                                            />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {filteredModels.map((m) => (
                                                <SelectItem key={m.id} value={m.id}>
                                                    <span>{m.name}</span>
                                                    {m.api !== "unknown" && <span className="ml-2 text-xs text-muted-foreground">{m.api}</span>}
                                                </SelectItem>
                                            ))}
                                            <SelectItem value="__custom__">自定义模型 ID…</SelectItem>
                                        </SelectContent>
                                    </Select>
                                )}
                            </div>
                            <div className="space-y-2">
                                <Label className="invisible">操作</Label>
                                <Button className="w-full lg:w-auto" onClick={handleAdd} disabled={!selectedProvider || !effectiveModelId}>
                                    添加
                                </Button>
                            </div>
                        </div>

                        {effectiveModelId && (
                            <div className="grid gap-3 lg:grid-cols-[6rem_8rem_8rem_8rem]">
                                <div className="space-y-2">
                                    <Label className="text-xs">推理</Label>
                                    <div className="flex h-9 items-center">
                                        <Switch checked={addReasoning} onCheckedChange={setAddReasoning} />
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <Label className="text-xs">上下文窗口</Label>
                                    <Input type="number" className="h-9 text-xs" value={addContextWindow} onChange={(e) => setAddContextWindow(e.target.value)} placeholder="—" />
                                </div>
                                <div className="space-y-2">
                                    <Label className="text-xs">最大 Token</Label>
                                    <Input type="number" className="h-9 text-xs" value={addMaxTokens} onChange={(e) => setAddMaxTokens(e.target.value)} placeholder="—" />
                                </div>
                                <div className="space-y-2">
                                    <Label className="text-xs">思考</Label>
                                    <ThinkingLevelSelect value={addThinkingLevel} onChange={setAddThinkingLevel} />
                                </div>
                            </div>
                        )}
                        {effectiveModelId &&
                            (() => {
                                const model = selectedResolvedModel
                                const tags: string[] = []
                                if (model?.compat) tags.push("compat")
                                if (model?.cost) tags.push("cost")
                                if (model?.input) tags.push(`input: ${(model.input as string[]).join(", ")}`)
                                return tags.length > 0 ? <p className="text-[11px] text-muted-foreground">自动继承: {tags.join(" · ")}</p> : null
                            })()}
                    </>
                )}

                {activateAlert && (
                    <div
                        className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${activateAlert.ok ? "alert-success" : "alert-error"}`}
                    >
                        <span>{activateAlert.message}</span>
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setActivateAlert(null)}>
                            ×
                        </Button>
                    </div>
                )}

                {dupAlert && (
                    <div className="flex items-center justify-between rounded-md alert-warning rounded-md px-3 py-2 text-sm">
                        <span>⚠️ {dupAlert}</span>
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setDupAlert(null)}>
                            ×
                        </Button>
                    </div>
                )}

                {testAlert && (
                    <div
                        className={`flex items-center justify-between rounded-lg border px-4 py-2 text-sm ${testAlert.ok ? "alert-success" : "alert-error"}`}
                    >
                        <span>
                            <span className="font-medium">{testAlert.key}</span>: {testAlert.message}
                        </span>
                        <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setTestAlert(null)}>
                            ×
                        </Button>
                    </div>
                )}
                {testAlert?.details && (
                    <div className="rounded-lg border bg-muted/30 px-4 py-3 text-xs font-mono text-muted-foreground">
                        <div>provider: {testAlert.details.providerLabel}</div>
                        <div>providerId: {testAlert.details.providerId ?? "—"}</div>
                        <div>runtimeProvider: {testAlert.details.runtimeProvider}</div>
                        <div>modelId: {testAlert.details.modelId}</div>
                        <div>protocol: {testAlert.details.api ?? "—"}</div>
                        <div>baseUrl: {testAlert.details.baseUrl ?? "—"}</div>
                        <div>apiKey: {testAlert.details.apiKeySummary ?? "—"}</div>
                        <div>reasoning: {typeof testAlert.details.reasoning === "boolean" ? String(testAlert.details.reasoning) : "—"}</div>
                        <div>contextWindow: {testAlert.details.contextWindow ?? "—"}</div>
                        <div>maxTokens: {testAlert.details.maxTokens ?? "—"}</div>
                        <div>thinkingLevel: {testAlert.details.thinkingLevel ?? "—"}</div>
                        <div>headers: {testAlert.details.headers ? JSON.stringify(testAlert.details.headers) : "—"}</div>
                        <div>compat: {testAlert.details.compat ? JSON.stringify(testAlert.details.compat) : "—"}</div>
                        <div>modelPrefId: {testAlert.details.modelPrefId}</div>
                    </div>
                )}

                {loading ? (
                    <p className="text-sm text-muted-foreground">加载中…</p>
                ) : !configs || configs.length === 0 ? (
                    <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">尚未配置模型。</div>
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>提供商</TableHead>
                                <TableHead>模型</TableHead>
                                <TableHead>推理</TableHead>
                                <TableHead>上下文</TableHead>
                                <TableHead>最大 Token</TableHead>
                                <TableHead>思考</TableHead>
                                <TableHead>扩展</TableHead>
                                <TableHead className="w-28">启用</TableHead>
                                <TableHead className="w-32 text-right">操作</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {(() => {
                                const keyCount = new Map<string, number>()
                                for (const m of configs) {
                                            const k = `${m.providerId ?? m.provider}:${m.modelId}`
                                            keyCount.set(k, (keyCount.get(k) ?? 0) + 1)
                                        }
                                return configs.map((m) => (
                                    <TableRow key={m.id}>
                                        <TableCell className="font-medium">{formatProviderLabel(m)}</TableCell>
                                        <TableCell className="font-mono text-xs text-muted-foreground">
                                            {m.name ?? m.modelId}
                                            {(keyCount.get(`${m.providerId ?? m.provider}:${m.modelId}`) ?? 0) > 1 && (
                                                <Badge variant="outline" className="ml-1.5 font-mono text-[10px]">
                                                    {m.id}
                                                </Badge>
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            <Switch checked={!!m.reasoning} onCheckedChange={(v) => handleUpdate(m, { reasoning: v })} />
                                        </TableCell>
                                        <TableCell>
                                            <Input
                                                type="number"
                                                className="h-7 w-20 text-xs"
                                                defaultValue={m.contextWindow ?? ""}
                                                placeholder="—"
                                                onBlur={(e) => {
                                                    const v = parseInt(e.target.value)
                                                    if (v !== (m.contextWindow ?? 0)) handleUpdate(m, { contextWindow: v || undefined })
                                                }}
                                            />
                                        </TableCell>
                                        <TableCell>
                                            <Input
                                                type="number"
                                                className="h-7 w-20 text-xs"
                                                defaultValue={m.maxTokens ?? ""}
                                                placeholder="—"
                                                onBlur={(e) => {
                                                    const v = parseInt(e.target.value)
                                                    if (v !== (m.maxTokens ?? 0)) handleUpdate(m, { maxTokens: v || undefined })
                                                }}
                                            />
                                        </TableCell>
                                        <TableCell>
                                            <ThinkingLevelSelect value={m.thinkingLevel ?? ""} onChange={(v) => handleUpdate(m, { thinkingLevel: v || undefined })} />
                                        </TableCell>
                                        <TableCell>
                                            <JsonEditorDialog label="headers" value={m.headers} onSave={(v) => handleUpdate(m, { headers: v as Record<string, string> | undefined })} />
                                            <JsonEditorDialog label="compat" value={m.compat} onSave={(v) => handleUpdate(m, { compat: v as Record<string, unknown> | undefined })} />
                                        </TableCell>
                                        <TableCell>
                                            {activeModelPrefId === m.id ? (
                                                <Badge variant="default" className="text-[10px]">
                                                    系统默认
                                                </Badge>
                                            ) : (
                                                <Button
                                                    type="button"
                                                    variant="secondary"
                                                    size="sm"
                                                    className="h-7 text-xs"
                                                    disabled={activatingId === m.id}
                                                    onClick={() => handleActivate(m)}
                                                    title="设为全局默认，并更新所有 Agent / 子 Agent / 调度器 / 验证器的模型"
                                                >
                                                    {activatingId === m.id ? "启用中…" : "启用"}
                                                </Button>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-right space-x-1">
                                            <Button variant="ghost" size="sm" disabled={testingKey === m.id} onClick={() => handleTest(m.id, `${formatProviderLabel(m)}:${m.modelId}`)}>
                                                {testingKey === m.id ? "测试中…" : "测试"}
                                            </Button>
                                            <Button variant="ghost" size="sm" onClick={() => handleRemove(m.id)}>
                                                删除
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                ))
                            })()}
                        </TableBody>
                    </Table>
                )}
            </CardContent>
        </Card>
    )
}
