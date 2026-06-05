import { CircleIcon, Loader2, Server } from "lucide-react"
import { formatKaliUptime, type KaliSystemStats } from "@tch/core"
import { Button } from "../ui/button"

function StatItem({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
            <span className="font-mono text-xs tabular-nums">{value}</span>
        </div>
    )
}

export function KaliHostStatusBar({
    kali,
    loading,
    sshHint,
    onProbe,
}: {
    kali: KaliSystemStats | null
    loading: boolean
    sshHint?: string
    onProbe: () => void
}) {
    const probeLabel = loading ? "检测中…" : kali?.ok ? "刷新状态" : "测试连接"

    if (!kali && !loading) {
        return (
            <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                <CircleIcon className="size-3 shrink-0 fill-current text-zinc-400" />
                <Server className="size-3.5 shrink-0" />
                <span>远程 Kali：点击测试连接（读取 MCP kali-arsenal 的 SSH 配置）</span>
                <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={onProbe}>
                    测试连接
                </Button>
            </div>
        )
    }

    if (loading && !kali) {
        return (
            <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
                <span>正在连接 Kali 并采集系统信息…</span>
                <Button type="button" variant="outline" size="sm" className="h-7 text-xs" disabled>
                    {probeLabel}
                </Button>
            </div>
        )
    }

    const display = kali!
    if (!display.ok) {
        return (
            <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
                <CircleIcon className="size-3 shrink-0 fill-current text-amber-500" />
                <Server className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 text-amber-300">
                    Kali SSH {display.label ? `（${display.label}）` : ""}：{display.message ?? sshHint ?? "未连接"}
                </span>
                <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 text-xs" disabled={loading} onClick={onProbe}>
                    {loading ? <Loader2 className="size-3 animate-spin" /> : null}
                    {probeLabel}
                </Button>
            </div>
        )
    }

    const title = display.hostname ? `${display.label ?? "Kali"} · ${display.hostname}` : (display.label ?? "Kali SSH")
    const cpu =
        display.cpuUsagePct != null
            ? `${display.cpuUsagePct}%${display.cpuCount ? ` / ${display.cpuCount}核` : ""}`
            : "—"
    const mem =
        display.memUsedMb != null && display.memTotalMb != null
            ? `${display.memUsedMb} / ${display.memTotalMb} MB${display.memUsedPct != null ? ` (${display.memUsedPct}%)` : ""}`
            : "—"
    const disk =
        display.diskUsedGb != null && display.diskTotalGb != null
            ? `${display.diskUsedGb} / ${display.diskTotalGb} GB${display.diskUsedPct != null ? ` (${display.diskUsedPct}%)` : ""}`
            : "—"
    const load =
        display.load1 != null && display.load5 != null && display.load15 != null
            ? `${display.load1} ${display.load5} ${display.load15}`
            : "—"

    return (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-emerald-500/25 bg-emerald-500/5 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
                <CircleIcon className="size-3 shrink-0 fill-current text-emerald-500" />
                <Server className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-medium">{title}</span>
            </div>
            <div className="flex flex-wrap gap-4">
                <StatItem label="CPU" value={cpu} />
                <StatItem label="内存" value={mem} />
                <StatItem label="磁盘 /" value={disk} />
                <StatItem label="负载" value={load} />
                <StatItem label="运行" value={formatKaliUptime(display.uptimeSec)} />
            </div>
            <Button type="button" variant="outline" size="sm" className="ml-auto h-7 shrink-0 text-xs" disabled={loading} onClick={onProbe}>
                {loading ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
                {probeLabel}
            </Button>
        </div>
    )
}
