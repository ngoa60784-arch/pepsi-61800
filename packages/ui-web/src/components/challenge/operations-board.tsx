import { useEffect, useState, startTransition } from "react"
import type { ChallengeProgressDigest } from "../../../../core/src/challenge/progress-digest"
import type { IdeaStatus } from "../../../../core/src/challenge/memory"
import { challenges } from "../../lib/api"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card"
import { ScrollArea } from "../ui/scroll-area"

const IDEA_COLUMNS: Array<{ status: IdeaStatus; label: string; className: string }> = [
    { status: "pending", label: "待验证", className: "border-slate-500/30 bg-slate-500/10" },
    { status: "testing", label: "进行中", className: "border-sky-500/30 bg-sky-500/10" },
    { status: "verified", label: "已证实", className: "border-emerald-500/30 bg-emerald-500/10" },
    { status: "failed", label: "已失败", className: "border-rose-500/30 bg-rose-500/10" },
]

function formatTime(value?: string) {
    if (!value) return ""
    return new Date(value).toLocaleString()
}

function formatEventTime(timestamp: number) {
    return new Date(timestamp).toLocaleString()
}

function verificationBadge(status?: string, correct?: boolean) {
    if (correct) return <Badge className="badge-success">correct</Badge>
    if (status === "verified") return <Badge className="badge-success">verified</Badge>
    if (status === "pending") return <Badge variant="outline">pending</Badge>
    if (status === "rejected") return <Badge variant="destructive">rejected</Badge>
    if (status === "inconclusive") return <Badge variant="outline">inconclusive</Badge>
    return <Badge variant="secondary">finding</Badge>
}

function StatTile(props: { label: string; value: string | number; hint?: string }) {
    return (
        <div className="rounded-lg border px-3 py-2">
            <div className="text-xs text-muted-foreground">{props.label}</div>
            <div className="mt-1 text-sm font-medium">{props.value}</div>
            {props.hint ? <div className="mt-0.5 text-[11px] text-muted-foreground">{props.hint}</div> : null}
        </div>
    )
}

function IdeaColumn(props: { label: string; className: string; items: ChallengeProgressDigest["ideasByStatus"][IdeaStatus] }) {
    return (
        <div className={`flex min-h-0 min-w-0 flex-col rounded-lg border p-2 ${props.className}`}>
            <div className="mb-2 text-xs font-medium">
                {props.label} ({props.items.length})
            </div>
            <ScrollArea className="h-48 pr-2">
                <div className="space-y-2">
                    {props.items.length === 0 ? <p className="text-xs text-muted-foreground">暂无</p> : null}
                    {props.items.map((idea) => (
                        <div key={idea.id} className="rounded-md border bg-background/80 p-2 text-xs">
                            <div className="font-medium leading-snug">{idea.content}</div>
                            {idea.result ? <div className="mt-1 text-muted-foreground">{idea.result}</div> : null}
                            <div className="mt-1 text-[10px] text-muted-foreground">{formatTime(idea.updated_at)}</div>
                        </div>
                    ))}
                </div>
            </ScrollArea>
        </div>
    )
}

function MemoryList(props: { title: string; items: ChallengeProgressDigest["memoryFacts"]; empty: string }) {
    return (
        <div className="space-y-2">
            <div className="text-sm font-medium">
                {props.title} ({props.items.length})
            </div>
            {props.items.length === 0 ? (
                <p className="text-xs text-muted-foreground">{props.empty}</p>
            ) : (
                <ul className="space-y-1.5 text-xs">
                    {props.items.map((item) => (
                        <li key={item.id} className="rounded-md border bg-background/60 px-2 py-1.5">
                            <span className="text-muted-foreground">[{item.kind}] </span>
                            {item.content}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}

interface OperationsBoardProps {
    challengeId: string
    onOpenAttackFlow?: () => void
}

export function OperationsBoard({ challengeId, onOpenAttackFlow }: OperationsBoardProps) {
    const [digest, setDigest] = useState<ChallengeProgressDigest | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState("")
    const [showPlanner, setShowPlanner] = useState(false)

    useEffect(() => {
        let active = true
        setLoading(true)
        setError("")
        void challenges
            .progress(challengeId)
            .then((next) => {
                if (active) setDigest(next)
            })
            .catch((nextError) => {
                if (active) setError(nextError instanceof Error ? nextError.message : String(nextError))
            })
            .finally(() => {
                if (active) setLoading(false)
            })
        return () => {
            active = false
        }
    }, [challengeId])

    useEffect(() => {
        const source = new EventSource(`/api/challenges/${encodeURIComponent(challengeId)}/progress/stream`)
        source.addEventListener("digest", (event) => {
            try {
                const next = JSON.parse((event as MessageEvent).data) as ChallengeProgressDigest
                startTransition(() => setDigest(next))
            } catch {
                // ignore malformed frame
            }
        })
        return () => source.close()
    }, [challengeId])

    if (loading && !digest) {
        return <div className="py-8 text-center text-sm text-muted-foreground">加载作战看板…</div>
    }
    if (error && !digest) {
        return <div className="rounded-lg border p-4 text-sm text-red-500">{error}</div>
    }
    if (!digest) {
        return <div className="py-8 text-center text-sm text-muted-foreground">暂无看板数据。</div>
    }

    return (
        <div className="min-w-0 space-y-4">
            <Card>
                <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <CardTitle className="text-base">指挥条</CardTitle>
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">{digest.phaseLabel}</Badge>
                            {digest.objectiveAchieved ? <Badge className="badge-success">主目标已达成</Badge> : null}
                            {digest.testingPaused ? <Badge variant="outline">测试已暂停</Badge> : null}
                            {digest.pruneRecommended ? <Badge variant="destructive">建议换打法</Badge> : null}
                            {onOpenAttackFlow ? (
                                <Button type="button" variant="outline" size="sm" onClick={onOpenAttackFlow}>
                                    攻击流
                                </Button>
                            ) : null}
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <StatTile label="实例状态" value={digest.instanceStatus} />
                    <StatTile label="活跃 Solver" value={digest.activeSolverCount} />
                    <StatTile label="有效 Findings" value={digest.findingCount} hint={`提交 ${digest.submissionCount} 条`} />
                    <StatTile label="成功率 / 死路" value={`${Math.round(digest.successRate * 100)}%`} hint={`死路 ${digest.failedRouteCount}`} />
                </CardContent>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Solver 焦点</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {digest.solvers.length === 0 ? (
                            <p className="text-sm text-muted-foreground">当前无运行中 Solver。</p>
                        ) : (
                            digest.solvers.map((solver) => (
                                <div key={solver.id} className="rounded-md border px-3 py-2 text-sm">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-mono text-xs">{solver.id}</span>
                                        <Badge variant="outline">{solver.status}</Badge>
                                        {solver.promptName ? <Badge variant="secondary">{solver.promptName}</Badge> : null}
                                    </div>
                                    <div className="mt-1 text-muted-foreground">{solver.currentFocus}</div>
                                </div>
                            ))
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="pb-2">
                        <div className="flex items-center justify-between gap-2">
                            <CardTitle className="text-sm">Planner</CardTitle>
                            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowPlanner((v) => !v)}>
                                {showPlanner ? "收起" : "展开"}
                            </Button>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                        {digest.battlePlan ? (
                            <>
                                <div>
                                    <div className="text-xs text-muted-foreground">作战意图</div>
                                    <div className="mt-1 whitespace-pre-wrap">{digest.battlePlan.strategy}</div>
                                </div>
                                {digest.battlePlan.nextCheckpoint ? (
                                    <div>
                                        <div className="text-xs text-muted-foreground">下一检查点</div>
                                        <div className="mt-1">{digest.battlePlan.nextCheckpoint}</div>
                                    </div>
                                ) : null}
                                <div className="text-[11px] text-muted-foreground">更新于 {formatTime(digest.battlePlan.updated_at)}</div>
                            </>
                        ) : (
                            <p className="text-muted-foreground">Planner 尚未写入 battlePlan。</p>
                        )}
                        {showPlanner && digest.plannerSummary ? (
                            <div className="rounded-md border bg-muted/30 p-2 text-xs whitespace-pre-wrap">{digest.plannerSummary}</div>
                        ) : null}
                    </CardContent>
                </Card>
            </div>

            <div>
                <div className="mb-2 text-sm font-medium">思路看板</div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    {IDEA_COLUMNS.map((column) => (
                        <IdeaColumn key={column.status} label={column.label} className={column.className} items={digest.ideasByStatus[column.status]} />
                    ))}
                </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Memory 摘要</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <MemoryList title="事实 / 证据" items={digest.memoryFacts} empty="尚无事实记录。" />
                        <MemoryList title="死路 / 边界" items={digest.memoryFailures} empty="尚无失败边界。" />
                        <MemoryList title="凭据线索" items={digest.memoryCredentials} empty="尚无凭据类 memory。" />
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Findings 与资产</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-2">
                            <div className="text-sm font-medium">Findings ({digest.findings.length})</div>
                            {digest.findings.length === 0 ? (
                                <p className="text-xs text-muted-foreground">尚无有效 finding。</p>
                            ) : (
                                <ul className="space-y-2 text-xs">
                                    {digest.findings.map((finding) => (
                                        <li key={finding.id} className="rounded-md border px-2 py-1.5">
                                            <div className="flex flex-wrap items-center gap-2">
                                                {verificationBadge(finding.verification_status, finding.correct)}
                                                {finding.hasWriteup ? <Badge variant="outline">writeup</Badge> : null}
                                            </div>
                                            <div className="mt-1">{finding.title}</div>
                                            <div className="mt-1 text-[10px] text-muted-foreground">{formatTime(finding.created_at)}</div>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                        {digest.stateAssets.length > 0 ? (
                            <div className="space-y-2">
                                <div className="text-sm font-medium">结构化资产</div>
                                <ul className="space-y-1 font-mono text-[11px] text-muted-foreground">
                                    {digest.stateAssets.map((line) => (
                                        <li key={line}>{line}</li>
                                    ))}
                                </ul>
                            </div>
                        ) : null}
                    </CardContent>
                </Card>
            </div>

            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-sm">最新动态</CardTitle>
                </CardHeader>
                <CardContent>
                    {digest.recentEvents.length === 0 ? (
                        <p className="text-sm text-muted-foreground">暂无时间线事件。</p>
                    ) : (
                        <ul className="space-y-2 text-sm">
                            {digest.recentEvents.map((event) => (
                                <li key={event.id} className="flex gap-3 rounded-md border px-3 py-2">
                                    <div className="shrink-0 text-[11px] text-muted-foreground">{formatEventTime(event.timestamp)}</div>
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Badge variant="outline">{event.lane}</Badge>
                                            <span className="font-medium">{event.title}</span>
                                        </div>
                                        <div className="mt-0.5 text-xs text-muted-foreground">{event.summary}</div>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </CardContent>
            </Card>

            <p className="text-[11px] text-muted-foreground">更新于 {formatTime(digest.updatedAt)} · SSE 实时推送</p>
        </div>
    )
}
