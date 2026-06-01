import { useEffect, useState } from "react"
import { challenges, hostSettings, prompts, runtime } from "../../lib/api"
import type { ChallengeDetails, ChallengeInfoRecord, ChallengeStatsOverview, ChallengeStatsOverviewBucket, IdeaRecord, MemoryEntry, SolverInstance } from "../../lib/api"
import { useFetch } from "../../hooks/use-fetch"
import { BarChart3Icon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { Badge } from "../ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card"
import { Button } from "../ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Skeleton } from "../ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { Switch } from "../ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs"
import { Textarea } from "../ui/textarea"
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

function formatTime(value?: string) {
    if (!value) return "unknown"
    return new Date(value).toLocaleString()
}

function formatSolverTime(value?: number) {
    if (!value) return "unknown"
    return new Date(value).toLocaleString()
}

function formatMinutes(value?: number) {
    if (!value || value <= 0) return "0 min"
    return `${Math.round(value / 60000)} min`
}

function formatTokenCount(value?: number) {
    if (!value || value <= 0) return "0"
    if (value < 1000) return `${value}`
    if (value < 10000) return `${(value / 1000).toFixed(1)}k`
    return `${Math.round(value / 1000)}k`
}

function challengeStatus(challenge: ChallengeInfoRecord) {
    if (challenge.flag_count > 0 && challenge.flag_got_count >= challenge.flag_count) return "solved"
    return challenge.instance_status || "unknown"
}

function challengeStatusBadgeClass(status: string) {
    if (status === "solved") {
        return "border-green-600/30 bg-green-500/15 text-green-700"
    }
    return ""
}

function activeSolvers(solvers: SolverInstance[]) {
    return solvers.filter((solver) => solver.status === "starting" || solver.status === "running" || solver.status === "stopping")
}

function sortSolverStatsByNewestFirst(
    items: ChallengeDetails["solver_stats"],
    solvers: SolverInstance[],
): ChallengeDetails["solver_stats"] {
    return [...items].sort((left, right) => {
        const leftLiveSolver = solvers.find((item) => item.id === left.solver_id)
        const rightLiveSolver = solvers.find((item) => item.id === right.solver_id)
        const leftTime = left.started_at ? Date.parse(left.started_at) : leftLiveSolver?.createdAt ?? 0
        const rightTime = right.started_at ? Date.parse(right.started_at) : rightLiveSolver?.createdAt ?? 0
        return rightTime - leftTime
    })
}

function filterLabel(value: string, fallback: string) {
    return value === "all" ? fallback : value
}

function hintPreview(value?: string | null) {
    const text = value?.trim() ?? ""
    if (!text) return "—"
    return text.length > 80 ? `${text.slice(0, 80)}...` : text
}

function formatPercent(value?: number) {
    if (!value || value <= 0) return "0%"
    return `${Math.round(value * 100)}%`
}

function truncateLabel(value: string, maxChars = 16): string {
    const text = value.trim()
    if (!text) return text
    const chars = Array.from(text)
    if (chars.length <= maxChars) return text
    return `${chars.slice(0, maxChars).join("")}…`
}

function formatShortDuration(value?: number) {
    if (!value || value <= 0) return "0m"
    const totalMinutes = Math.round(value / 60000)
    if (totalMinutes < 60) return `${totalMinutes}m`
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return `${hours}h ${minutes}m`
}

const MEMORY_KIND_OPTIONS: MemoryEntry["kind"][] = ["fact", "evidence", "failure", "note", "hint"]
const IDEA_STATUS_OPTIONS: IdeaRecord["status"][] = ["pending", "testing", "verified", "failed", "skipped"]

interface MemoryFormState {
    kind: MemoryEntry["kind"]
    content: string
    refsText: string
    source: string
}

interface IdeaFormState {
    content: string
    status: IdeaRecord["status"]
    result: string
}

function createMemoryFormState(challengeId: string, entry?: MemoryEntry): MemoryFormState {
    if (!entry) {
        return {
            kind: "note",
            content: "",
            refsText: "",
            source: `challenge-ui:${challengeId}`,
        }
    }
    return {
        kind: entry.kind,
        content: entry.content,
        refsText: entry.refs.join("\n"),
        source: entry.source,
    }
}

function createIdeaFormState(entry?: IdeaRecord): IdeaFormState {
    if (!entry) {
        return {
            content: "",
            status: "pending",
            result: "",
        }
    }
    return {
        content: entry.content,
        status: entry.status,
        result: entry.result,
    }
}

function parseRefs(refsText: string): string[] {
    return refsText
        .split("\n")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
}

function StatsRankingTable(props: { items: ChallengeStatsOverviewBucket[]; empty: string }) {
    const { items, empty } = props

    if (items.length === 0) return <div className="text-sm text-muted-foreground">{empty}</div>

    return (
        <div className="max-h-72 overflow-auto rounded-lg border">
            <Table>
                <TableHeader className="sticky top-0 bg-background">
                    <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Challenges</TableHead>
                        <TableHead>Flags</TableHead>
                        <TableHead>Flag Rate</TableHead>
                        <TableHead>Error</TableHead>
                        <TableHead>Time</TableHead>
                        <TableHead>Tokens</TableHead>
                        <TableHead>Quality</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {items.map((item) => (
                        <TableRow key={item.key}>
                            <TableCell className="font-medium">{item.label}</TableCell>
                            <TableCell>{item.challenge_count}</TableCell>
                            <TableCell>{item.solved_count}/{item.total_flag_count}</TableCell>
                            <TableCell>{formatPercent(item.completion_rate)}</TableCell>
                            <TableCell>{formatPercent(item.error_rate)}</TableCell>
                            <TableCell>{formatMinutes(item.total_duration_ms)}</TableCell>
                            <TableCell>{formatTokenCount(item.total_tokens)}</TableCell>
                            <TableCell>{Math.round(item.quality_score)}</TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    )
}

function statsChartHeight(count: number) {
    return Math.max(180, count * 36)
}

function StatsBucketCharts(props: { title: string; items: ChallengeStatsOverviewBucket[] }) {
    const { title, items } = props
    const [tab, setTab] = useState("success")

    if (items.length === 0) return null

    const data = items.map((item) => ({
        name: item.label,
        flagCount: item.solved_count,
        completionRate: Math.round(item.completion_rate * 100),
        errorRate: Math.round(item.error_rate * 100),
        totalMinutes: Math.round(item.total_duration_ms / 60000),
        totalTokens: Math.round(item.total_tokens / 1000),
        quality: Math.round(item.quality_score),
        completed: item.solved_count > 0,
    }))
    const height = statsChartHeight(data.length)

    return (
        <div className="space-y-4">
            <div className="rounded-lg border border-dashed p-4">
                <div className="mb-3 text-sm font-medium text-muted-foreground">{title} · Summary</div>
                <div className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-4">
                    <div className="rounded-md border px-3 py-2">
                        <div className="text-xs">Items</div>
                        <div className="mt-1 text-base font-medium text-foreground">{items.length}</div>
                    </div>
                    <div className="rounded-md border px-3 py-2">
                        <div className="text-xs">Avg Flag Rate</div>
                        <div className="mt-1 text-base font-medium text-foreground">
                            {formatPercent(items.reduce((sum, item) => sum + item.completion_rate, 0) / items.length)}
                        </div>
                    </div>
                    <div className="rounded-md border px-3 py-2">
                        <div className="text-xs">Avg Time</div>
                        <div className="mt-1 text-base font-medium text-foreground">
                            {formatMinutes(items.reduce((sum, item) => sum + item.total_duration_ms, 0) / items.length)}
                        </div>
                    </div>
                    <div className="rounded-md border px-3 py-2">
                        <div className="text-xs">Avg Tokens</div>
                        <div className="mt-1 text-base font-medium text-foreground">
                            {formatTokenCount(Math.round(items.reduce((sum, item) => sum + item.total_tokens, 0) / items.length))}
                        </div>
                    </div>
                </div>
            </div>

            <Tabs value={tab} onValueChange={setTab} className="space-y-4">
                <TabsList>
                    <TabsTrigger value="success">Success</TabsTrigger>
                    <TabsTrigger value="time">Time</TabsTrigger>
                    <TabsTrigger value="tokens">Tokens</TabsTrigger>
                    <TabsTrigger value="quality">Quality</TabsTrigger>
                </TabsList>

                <TabsContent value="success" className="rounded-lg border p-4">
                    <div className="mb-3 text-sm font-medium">{title} · Flags</div>
                    <div style={{ height }}>
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                                <CartesianGrid strokeDasharray="3 3" />
                                <XAxis type="number" allowDecimals={false} />
                                <YAxis type="category" dataKey="name" width={220} />
                                <Tooltip />
                                <Legend />
                                <Bar dataKey="flagCount" name="Flags" fill="#2563eb" radius={[0, 4, 4, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </TabsContent>

                <TabsContent value="time" className="rounded-lg border p-4">
                    <div className="mb-3 text-sm font-medium">{title} · Time</div>
                    <div style={{ height }}>
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                                <CartesianGrid strokeDasharray="3 3" />
                                <XAxis type="number" />
                                <YAxis type="category" dataKey="name" width={220} />
                                <Tooltip />
                                <Bar dataKey="totalMinutes" name="Time (min)" radius={[0, 4, 4, 0]}>
                                    {data.map((entry) => (
                                        <Cell key={`${entry.name}-time`} fill={entry.completed ? "#16a34a" : "#7c3aed"} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </TabsContent>

                <TabsContent value="tokens" className="rounded-lg border p-4">
                    <div className="mb-3 text-sm font-medium">{title} · Tokens</div>
                    <div style={{ height }}>
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                                <CartesianGrid strokeDasharray="3 3" />
                                <XAxis type="number" />
                                <YAxis type="category" dataKey="name" width={220} />
                                <Tooltip />
                                <Bar dataKey="totalTokens" name="Tokens (k)" radius={[0, 4, 4, 0]}>
                                    {data.map((entry) => (
                                        <Cell key={`${entry.name}-tokens`} fill={entry.completed ? "#16a34a" : "#ea580c"} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </TabsContent>

                <TabsContent value="quality" className="rounded-lg border p-4">
                    <div className="mb-3 text-sm font-medium">{title} · Quality</div>
                    <div style={{ height }}>
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                                <CartesianGrid strokeDasharray="3 3" />
                                <XAxis type="number" />
                                <YAxis type="category" dataKey="name" width={220} />
                                <Tooltip />
                                <Bar dataKey="quality" name="Quality" radius={[0, 4, 4, 0]}>
                                    {data.map((entry) => (
                                        <Cell key={`${entry.name}-quality`} fill={entry.completed ? "#16a34a" : "#0f766e"} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </TabsContent>
            </Tabs>
        </div>
    )
}

function StatsOverviewDialog(props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    statsOverview?: ChallengeStatsOverview
    loading: boolean
}) {
    const { open, onOpenChange, statsOverview, loading } = props
    const [tab, setTab] = useState("overview")
    const [challengeMetric, setChallengeMetric] = useState("time")

    const pieData = statsOverview
        ? [
              { name: "Solved Flags", value: statsOverview.flags_solved, color: "#16a34a" },
              { name: "Remaining Flags", value: Math.max(statsOverview.flags_total - statsOverview.flags_solved, 0), color: "#d4d4d8" },
          ]
        : []
    const challengeMetricData = (statsOverview?.challenge_series ?? []).map((item) => ({
        name: item.title || item.challenge_id,
        axisLabel: truncateLabel(item.title || item.challenge_id, 14),
        durationMinutes: Math.round(item.solve_duration_ms / 60000),
        tokensK: Math.round(item.total_tokens / 1000),
        quality: Math.round(item.quality_score),
        completed: item.solved,
    }))
    challengeMetricData.sort((left, right) => {
        const valueDiff =
            challengeMetric === "tokens"
                ? right.tokensK - left.tokensK
                : challengeMetric === "quality"
                  ? right.quality - left.quality
                  : right.durationMinutes - left.durationMinutes
        if (valueDiff !== 0) return valueDiff
        if (left.completed !== right.completed) return Number(right.completed) - Number(left.completed)
        return left.name.localeCompare(right.name)
    })
    const challengeMetricHeight = statsChartHeight(challengeMetricData.length)
    const challengeMetricKey = challengeMetric === "tokens" ? "tokensK" : challengeMetric === "quality" ? "quality" : "durationMinutes"
    const challengeMetricLabel = challengeMetric === "tokens" ? "Tokens (k)" : challengeMetric === "quality" ? "Quality" : "Solve Time (min)"
    const challengeMetricColor = challengeMetric === "tokens" ? "#ea580c" : challengeMetric === "quality" ? "#0f766e" : "#2563eb"

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] max-w-6xl overflow-y-auto">
                {loading || !statsOverview ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>Challenge Stats</DialogTitle>
                            <DialogDescription>图表化展示目标完成情况，以及模型 / Prompt 维度统计。</DialogDescription>
                        </DialogHeader>
                        <div className="text-sm text-muted-foreground">Loading stats...</div>
                    </>
                ) : (
                    <Tabs value={tab} onValueChange={setTab} className="space-y-4">
                        <DialogHeader>
                            <DialogTitle>Challenge Stats</DialogTitle>
                            <DialogDescription>图表化展示目标完成情况，以及模型 / Prompt 维度统计。</DialogDescription>
                        </DialogHeader>
                        <TabsList>
                            <TabsTrigger value="overview">Overview</TabsTrigger>
                            <TabsTrigger value="models">Models</TabsTrigger>
                            <TabsTrigger value="prompts">Prompts</TabsTrigger>
                        </TabsList>

                        <TabsContent value="overview" className="space-y-4">
                            <div className="grid gap-4 md:grid-cols-7">
                                <div className="rounded-lg border px-4 py-3">
                                    <div className="text-xs text-muted-foreground">Completion</div>
                                    <div className="mt-1 text-lg font-semibold">{formatPercent(statsOverview.flag_completion_rate)}</div>
                                    <div className="text-xs text-muted-foreground">{statsOverview.flags_solved}/{statsOverview.flags_total} flags</div>
                                </div>
                                <div className="rounded-lg border px-4 py-3">
                                    <div className="text-xs text-muted-foreground">Error Rate</div>
                                    <div className="mt-1 text-lg font-semibold">{formatPercent(statsOverview.error_rate)}</div>
                                    <div className="text-xs text-muted-foreground">{statsOverview.correct_submission_count}/{statsOverview.submission_count} correct</div>
                                </div>
                                <div className="rounded-lg border px-4 py-3">
                                    <div className="text-xs text-muted-foreground">Total Solver Time</div>
                                    <div className="mt-1 text-lg font-semibold">{formatMinutes(statsOverview.solver_active_duration_ms_total)}</div>
                                    <div className="text-xs text-muted-foreground">wall {formatMinutes(statsOverview.wall_time_ms_total)}</div>
                                </div>
                                <div className="rounded-lg border px-4 py-3">
                                    <div className="text-xs text-muted-foreground">Average Solve Time</div>
                                    <div className="mt-1 text-lg font-semibold">
                                        {formatMinutes(
                                            statsOverview.challenges_solved > 0
                                                ? Math.round(statsOverview.wall_time_ms_total / statsOverview.challenges_solved)
                                                : 0,
                                        )}
                                    </div>
                                    <div className="text-xs text-muted-foreground">solved only</div>
                                </div>
                                <div className="rounded-lg border px-4 py-3">
                                    <div className="text-xs text-muted-foreground">Total Tokens</div>
                                    <div className="mt-1 text-lg font-semibold">{formatTokenCount(statsOverview.total_tokens)}</div>
                                    <div className="text-xs text-muted-foreground">all solvers</div>
                                </div>
                                <div className="rounded-lg border px-4 py-3">
                                    <div className="text-xs text-muted-foreground">Average Tokens</div>
                                    <div className="mt-1 text-lg font-semibold">
                                        {formatTokenCount(
                                            statsOverview.solver_count > 0 ? Math.round(statsOverview.total_tokens / statsOverview.solver_count) : 0,
                                        )}
                                    </div>
                                    <div className="text-xs text-muted-foreground">per solver</div>
                                </div>
                                <div className="rounded-lg border px-4 py-3">
                                    <div className="text-xs text-muted-foreground">Quality</div>
                                    <div className="mt-1 text-lg font-semibold">{Math.round(statsOverview.quality_score)}</div>
                                    <div className="text-xs text-muted-foreground">weighted by solved progress</div>
                                </div>
                            </div>
                            <div className="grid gap-4 lg:grid-cols-2">
                                <div className="rounded-lg border p-4">
                                    <div className="mb-3 text-sm font-medium">Flag Completion</div>
                                    <div className="h-72">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <PieChart>
                                                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={96} label>
                                                    {pieData.map((item) => (
                                                        <Cell key={item.name} fill={item.color} />
                                                    ))}
                                                </Pie>
                                                <Tooltip />
                                                <Legend />
                                            </PieChart>
                                        </ResponsiveContainer>
                                    </div>
                                </div>
                                <div className="rounded-lg border p-4">
                                    <div className="mb-3 flex items-center justify-between gap-3">
                                        <div className="text-sm font-medium">Challenge Metrics</div>
                                        <Tabs value={challengeMetric} onValueChange={setChallengeMetric}>
                                            <TabsList>
                                                <TabsTrigger value="time">Time</TabsTrigger>
                                                <TabsTrigger value="tokens">Tokens</TabsTrigger>
                                                <TabsTrigger value="quality">Quality</TabsTrigger>
                                            </TabsList>
                                        </Tabs>
                                    </div>
                                    <div className="max-h-96 overflow-y-auto pr-1">
                                        <div style={{ height: challengeMetricHeight }}>
                                            <ResponsiveContainer width="100%" height="100%">
                                                <BarChart data={challengeMetricData} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                                                    <CartesianGrid strokeDasharray="3 3" />
                                                    <XAxis type="number" allowDecimals={false} />
                                                    <YAxis type="category" dataKey="axisLabel" width={150} tick={{ fontSize: 12 }} />
                                                    <Tooltip
                                                        labelFormatter={(label, payload) => {
                                                            const first = payload?.[0] as { payload?: { name?: string } } | undefined
                                                            if (first?.payload?.name) return first.payload.name
                                                            if (typeof label === "string" || typeof label === "number") return String(label)
                                                            return ""
                                                        }}
                                                    />
                                                    <Legend />
                                                    <Bar dataKey={challengeMetricKey} name={challengeMetricLabel} radius={[0, 4, 4, 0]}>
                                                        {challengeMetricData.map((entry) => (
                                                            <Cell
                                                                key={`${entry.name}-${challengeMetric}`}
                                                                fill={entry.completed ? "#16a34a" : challengeMetricColor}
                                                            />
                                                        ))}
                                                    </Bar>
                                                </BarChart>
                                            </ResponsiveContainer>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </TabsContent>

                        <TabsContent value="models" className="space-y-4">
                            <StatsBucketCharts title="Model Performance" items={statsOverview.models} />
                            <StatsRankingTable items={statsOverview.models} empty="No model stats yet." />
                        </TabsContent>

                        <TabsContent value="prompts" className="space-y-4">
                            <StatsBucketCharts title="Prompt Performance" items={statsOverview.prompts} />
                            <StatsRankingTable items={statsOverview.prompts} empty="No prompt stats yet." />
                        </TabsContent>
                    </Tabs>
                )}
            </DialogContent>
        </Dialog>
    )
}

export function ChallengePage({ challengeId }: { challengeId?: string }) {
    const { data: challengeList, loading, reload } = useFetch(challenges.list)
    const { data: hostConfig } = useFetch(hostSettings.get)
    const { data: statsOverview, loading: statsOverviewLoading } = useFetch(challenges.statsOverview)
    const [details, setDetails] = useState<ChallengeDetails | null>(null)
    const [detailsLoading, setDetailsLoading] = useState(false)
    const [detailsError, setDetailsError] = useState("")
    const [search, setSearch] = useState("")
    const [difficultyFilter, setDifficultyFilter] = useState("all")
    const [levelFilter, setLevelFilter] = useState("all")
    const [statusFilter, setStatusFilter] = useState("all")
    const [hintFilter, setHintFilter] = useState("all")
    const [dialogOpen, setDialogOpen] = useState(false)
    const [statsDialogOpen, setStatsDialogOpen] = useState(false)
    const [startDialogOpen, setStartDialogOpen] = useState(false)
    const [detailTab, setDetailTab] = useState("solvers")
    const [plannerDialogOpen, setPlannerDialogOpen] = useState(false)
    const [plannerEnabled, setPlannerEnabled] = useState(false)
    const [answerModeEnabled, setAnswerModeEnabled] = useState(false)
    const [plannerStrategy, setPlannerStrategy] = useState("")
    const [plannerSaving, setPlannerSaving] = useState(false)
    const [plannerMessage, setPlannerMessage] = useState("")
    const [startingSolver, setStartingSolver] = useState(false)
    const [exportingSessions, setExportingSessions] = useState(false)
    const [completionBusy, setCompletionBusy] = useState(false)
    const [completionMessage, setCompletionMessage] = useState("")
    const [startingChallengeId, setStartingChallengeId] = useState("")
    const [stoppingSolverId, setStoppingSolverId] = useState("")
    const [selectedStartChallengeId, setSelectedStartChallengeId] = useState("")
    const [startPromptName, setStartPromptName] = useState("")
    const [boardError, setBoardError] = useState("")
    const [boardBusyKey, setBoardBusyKey] = useState("")
    const [memoryDialogOpen, setMemoryDialogOpen] = useState(false)
    const [editingMemory, setEditingMemory] = useState<MemoryEntry | null>(null)
    const [memoryForm, setMemoryForm] = useState<MemoryFormState>(() => createMemoryFormState(challengeId || "challenge"))
    const [ideaDialogOpen, setIdeaDialogOpen] = useState(false)
    const [editingIdea, setEditingIdea] = useState<IdeaRecord | null>(null)
    const [ideaForm, setIdeaForm] = useState<IdeaFormState>(() => createIdeaFormState())
    const [creating, setCreating] = useState(false)
    const [createError, setCreateError] = useState("")
    const [startSolverError, setStartSolverError] = useState("")
    const [sessionExportError, setSessionExportError] = useState("")
    const [draftId, setDraftId] = useState("")
    const [draftTitle, setDraftTitle] = useState("")
    const [draftDifficulty, setDraftDifficulty] = useState("easy")
    const [draftDescription, setDraftDescription] = useState("")
    const [draftLevel, setDraftLevel] = useState("1")
    const [draftTotalScore, setDraftTotalScore] = useState("100")
    const [draftEntrypoints, setDraftEntrypoints] = useState([""])
    const [draftFlags, setDraftFlags] = useState([""])
    const [draftHintContent, setDraftHintContent] = useState("")

    const manualAddEnabled = hostConfig?.challenge.mockEnabled === true
    const challengeItems = challengeList ?? []
    const { data: agentPrompts, loading: promptsLoading } = useFetch(prompts.listAgents)

    useEffect(() => {
        setPlannerEnabled(hostConfig?.planner.enabled === true)
        setAnswerModeEnabled(hostConfig?.challenge.answerModeEnabled === true)
        setPlannerStrategy(hostConfig?.planner.strategy ?? "")
    }, [hostConfig?.challenge.answerModeEnabled, hostConfig?.planner.enabled, hostConfig?.planner.strategy])

    const difficultyOptions = [...new Set(challengeItems.map((challenge) => challenge.difficulty).filter(Boolean))].sort()
    const levelOptions = [...new Set(challengeItems.map((challenge) => `${challenge.level}`).filter(Boolean))].sort((a, b) => Number(a) - Number(b))
    const statusOptions = [...new Set(challengeItems.map((challenge) => challengeStatus(challenge)).filter(Boolean))].sort()

    const filteredChallenges = challengeItems.filter((challenge) => {
        const keyword = search.trim().toLowerCase()
        if (
            keyword &&
            ![
                challenge.id,
                challenge.title,
                challenge.difficulty,
                challenge.description,
                challenge.instance_status,
                challenge.entrypoint?.join(" ") ?? "",
            ]
                .join(" ")
                .toLowerCase()
                .includes(keyword)
        ) {
            return false
        }
        if (difficultyFilter !== "all" && challenge.difficulty !== difficultyFilter) return false
        if (levelFilter !== "all" && `${challenge.level}` !== levelFilter) return false
        if (statusFilter !== "all" && challengeStatus(challenge) !== statusFilter) return false
        if (hintFilter === "viewed" && !challenge.hint_viewed) return false
        if (hintFilter === "not-viewed" && challenge.hint_viewed) return false
        return true
    })

    useEffect(() => {
        if (!challengeId) {
            setDetails(null)
            setDetailsError("")
            return
        }
        let active = true
        setDetailsLoading(true)
        setDetailsError("")
        setDetailTab("solvers")
        setSessionExportError("")
        void challenges
            .get(challengeId)
            .then((next) => {
                if (active) setDetails(next)
            })
            .catch((error) => {
                if (active) setDetailsError(error instanceof Error ? error.message : String(error))
            })
            .finally(() => {
                if (active) setDetailsLoading(false)
            })
        return () => {
            active = false
        }
    }, [challengeId])

    function openRuntimeDetailInNewTab(solverId: string) {
        const url = new URL(location.href)
        url.hash = `#/runtime/${encodeURIComponent(solverId)}`
        window.open(url.toString(), "_blank", "noopener,noreferrer")
    }

    async function reloadDetails() {
        if (!challengeId) return
        try {
            const next = await challenges.get(challengeId)
            setDetails(next)
        } catch {
            // ignore reload errors; keep existing view
        }
    }

    async function handleConfirmComplete() {
        if (!challengeId || completionBusy) return
        if (!window.confirm("确认该目标主目标已达成？将停掉它的所有 solver，planner 也不再补派。")) return
        setCompletionBusy(true)
        setCompletionMessage("")
        try {
            await challenges.complete(challengeId)
            setCompletionMessage("已标记完成，正在停止该目标的 solver。")
            await reloadDetails()
        } catch (error) {
            setCompletionMessage(error instanceof Error ? error.message : String(error))
        } finally {
            setCompletionBusy(false)
        }
    }

    async function handleRevokeComplete() {
        if (!challengeId || completionBusy) return
        if (!window.confirm("撤销完成判定？将把之前停掉的 solver 用原 session 续跑（带上下文接着推进），planner 重新接管。")) return
        setCompletionBusy(true)
        setCompletionMessage("")
        try {
            const result = await challenges.revokeComplete(challengeId)
            setCompletionMessage(result.resumed.length > 0 ? `已撤销完成，续跑 ${result.resumed.length} 个 solver。` : "已撤销完成（无可续跑的 solver，planner 会重新调度）。")
            await reloadDetails()
        } catch (error) {
            setCompletionMessage(error instanceof Error ? error.message : String(error))
        } finally {
            setCompletionBusy(false)
        }
    }

    async function handleExportSolverSessions() {
        if (!challengeId) return
        setExportingSessions(true)
        setSessionExportError("")
        try {
            const result = await challenges.exportSolverSessions(challengeId)
            const downloadUrl = URL.createObjectURL(result.blob)
            const anchor = document.createElement("a")
            anchor.href = downloadUrl
            anchor.download = result.fileName
            document.body.appendChild(anchor)
            anchor.click()
            anchor.remove()
            window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0)
        } catch (error) {
            setSessionExportError(error instanceof Error ? error.message : String(error))
        } finally {
            setExportingSessions(false)
        }
    }

    async function handleTogglePlanner() {
        const nextEnabled = !plannerEnabled
        setPlannerSaving(true)
        setPlannerMessage("")
        try {
            await hostSettings.set({
                planner: {
                    enabled: nextEnabled,
                },
            })
            setPlannerEnabled(nextEnabled)
            setPlannerMessage(nextEnabled ? "Planner enabled" : "Planner disabled")
        } catch (error) {
            setPlannerMessage(error instanceof Error ? error.message : String(error))
        } finally {
            setPlannerSaving(false)
        }
    }

    async function handleToggleAnswerMode() {
        const nextEnabled = !answerModeEnabled
        setPlannerSaving(true)
        setPlannerMessage("")
        try {
            await hostSettings.set({
                challenge: {
                    answerModeEnabled: nextEnabled,
                },
                ...(nextEnabled
                    ? {
                          planner: {
                              enabled: true,
                          },
                      }
                    : {}),
            })
            setAnswerModeEnabled(nextEnabled)
            if (nextEnabled) setPlannerEnabled(true)
            setPlannerMessage(nextEnabled ? "Answer mode enabled" : "Answer mode disabled")
        } catch (error) {
            setPlannerMessage(error instanceof Error ? error.message : String(error))
        } finally {
            setPlannerSaving(false)
        }
    }

    async function handleSavePlannerStrategy() {
        setPlannerSaving(true)
        setPlannerMessage("")
        try {
            await hostSettings.set({
                planner: {
                    strategy: plannerStrategy.trim() || undefined,
                },
            })
            setPlannerMessage("Planner strategy saved")
            setPlannerDialogOpen(false)
        } catch (error) {
            setPlannerMessage(error instanceof Error ? error.message : String(error))
        } finally {
            setPlannerSaving(false)
        }
    }

    async function handleStartSolver(challengeId: string, promptName: string) {
        setStartingChallengeId(challengeId)
        setStartSolverError("")
        try {
            const solver = await challenges.startSolver(challengeId, promptName)
            setStartDialogOpen(false)
            setSelectedStartChallengeId("")
            setStartPromptName("")
            location.hash = `#/runtime/${solver.id}`
        } catch (error) {
            setStartSolverError(error instanceof Error ? error.message : String(error))
        } finally {
            setStartingChallengeId("")
        }
    }

    function openStartSolverDialog(nextChallengeId: string) {
        setSelectedStartChallengeId(nextChallengeId)
        setStartPromptName("")
        setStartSolverError("")
        setStartDialogOpen(true)
    }

    async function handleConfirmStartSolver() {
        if (!selectedStartChallengeId || !startPromptName) return
        setStartingSolver(true)
        await handleStartSolver(selectedStartChallengeId, startPromptName)
        setStartingSolver(false)
    }

    async function handleStopSolver(solverId: string) {
        setStoppingSolverId(solverId)
        setStartSolverError("")
        try {
            await runtime.stop(solverId)
            if (challengeId) {
                const next = await challenges.get(challengeId)
                setDetails(next)
            }
            reload()
        } catch (error) {
            setStartSolverError(error instanceof Error ? error.message : String(error))
        } finally {
            setStoppingSolverId("")
        }
    }

    async function reloadChallengeDetails() {
        if (!challengeId) return
        const next = await challenges.get(challengeId)
        setDetails(next)
    }

    function openCreateMemoryDialog() {
        if (!challengeId) return
        setEditingMemory(null)
        setMemoryForm(createMemoryFormState(challengeId))
        setMemoryDialogOpen(true)
    }

    function openEditMemoryDialog(entry: MemoryEntry) {
        if (!challengeId) return
        setEditingMemory(entry)
        setMemoryForm(createMemoryFormState(challengeId, entry))
        setMemoryDialogOpen(true)
    }

    function openCreateIdeaDialog() {
        setEditingIdea(null)
        setIdeaForm(createIdeaFormState())
        setIdeaDialogOpen(true)
    }

    function openEditIdeaDialog(entry: IdeaRecord) {
        setEditingIdea(entry)
        setIdeaForm(createIdeaFormState(entry))
        setIdeaDialogOpen(true)
    }

    async function handleSaveMemory() {
        if (!challengeId) return
        setBoardBusyKey(editingMemory ? `memory-save:${editingMemory.id}` : "memory-create")
        setBoardError("")
        try {
            if (editingMemory) {
                await challenges.updateMemory(challengeId, editingMemory.id, {
                    kind: memoryForm.kind,
                    content: memoryForm.content,
                    refs: parseRefs(memoryForm.refsText),
                    source: memoryForm.source,
                })
            } else {
                await challenges.addMemory(challengeId, {
                    kind: memoryForm.kind,
                    content: memoryForm.content,
                    refs: parseRefs(memoryForm.refsText),
                    source: memoryForm.source,
                })
            }
            setMemoryDialogOpen(false)
            await reloadChallengeDetails()
        } catch (error) {
            setBoardError(error instanceof Error ? error.message : String(error))
        } finally {
            setBoardBusyKey("")
        }
    }

    async function handleDeleteMemory(entry: MemoryEntry) {
        if (!challengeId) return
        if (!window.confirm(`删除 memory ${entry.id}？`)) return
        setBoardBusyKey(`memory-delete:${entry.id}`)
        setBoardError("")
        try {
            await challenges.deleteMemory(challengeId, entry.id)
            await reloadChallengeDetails()
        } catch (error) {
            setBoardError(error instanceof Error ? error.message : String(error))
        } finally {
            setBoardBusyKey("")
        }
    }

    async function handleSaveIdea() {
        if (!challengeId) return
        setBoardBusyKey(editingIdea ? `idea-save:${editingIdea.id}` : "idea-create")
        setBoardError("")
        try {
            if (editingIdea) {
                await challenges.updateIdea(challengeId, editingIdea.id, {
                    content: ideaForm.content,
                    status: ideaForm.status,
                    result: ideaForm.result,
                })
            } else {
                await challenges.addIdea(challengeId, {
                    content: ideaForm.content,
                    status: ideaForm.status,
                    result: ideaForm.result,
                })
            }
            setIdeaDialogOpen(false)
            await reloadChallengeDetails()
        } catch (error) {
            setBoardError(error instanceof Error ? error.message : String(error))
        } finally {
            setBoardBusyKey("")
        }
    }

    async function handleDeleteIdea(entry: IdeaRecord) {
        if (!challengeId) return
        if (!window.confirm(`删除 idea ${entry.id}？`)) return
        setBoardBusyKey(`idea-delete:${entry.id}`)
        setBoardError("")
        try {
            await challenges.deleteIdea(challengeId, entry.id)
            await reloadChallengeDetails()
        } catch (error) {
            setBoardError(error instanceof Error ? error.message : String(error))
        } finally {
            setBoardBusyKey("")
        }
    }

    if (!challengeId) {
        async function handleCreateChallenge() {
            setCreating(true)
            setCreateError("")
            try {
                await challenges.create({
                    id: draftId.trim(),
                    title: draftTitle.trim(),
                    difficulty: draftDifficulty.trim(),
                    description: draftDescription.trim(),
                    level: parseInt(draftLevel, 10) || 0,
                    total_score: parseInt(draftTotalScore, 10) || 0,
                    total_got_score: 0,
                    flag_count: draftFlags.filter((item) => item.trim().length > 0).length,
                    flag_got_count: 0,
                    hint_viewed: false,
                    hint_content: draftHintContent.trim() || null,
                    instance_status: "stopped",
                    entrypoint: draftEntrypoints.map((item) => item.trim()).filter((item) => item.length > 0),
                    flags: draftFlags.map((item) => item.trim()).filter((item) => item.length > 0),
                })
                setDialogOpen(false)
                setDraftId("")
                setDraftTitle("")
                setDraftDifficulty("easy")
                setDraftDescription("")
                setDraftLevel("1")
                setDraftTotalScore("100")
                setDraftEntrypoints([""])
                setDraftFlags([""])
                setDraftHintContent("")
                reload()
            } catch (error) {
                setCreateError(error instanceof Error ? error.message : String(error))
            } finally {
                setCreating(false)
            }
        }

        return (
            <div className="flex min-w-0 flex-1 flex-col gap-4 p-6">
                <Card>
                    <CardHeader>
                        <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                                <CardTitle>Challenges</CardTitle>
                                <Button variant="outline" size="sm" onClick={() => setPlannerDialogOpen(true)}>
                                    Planner Strategy
                                </Button>
                                <div className="flex h-7 items-center gap-2 rounded-[min(var(--radius-md),12px)] border px-2.5 text-[0.8rem]">
                                    <span className="text-muted-foreground">Planner</span>
                                    <Switch checked={plannerEnabled} onCheckedChange={() => void handleTogglePlanner()} disabled={plannerSaving} />
                                </div>
                                <div className="flex h-7 items-center gap-2 rounded-[min(var(--radius-md),12px)] border px-2.5 text-[0.8rem]">
                                    <span className="text-muted-foreground">Answer Mode</span>
                                    <Switch checked={answerModeEnabled} onCheckedChange={() => void handleToggleAnswerMode()} disabled={plannerSaving} />
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <Button variant="outline" size="sm" onClick={() => setStatsDialogOpen(true)}>
                                    <BarChart3Icon className="size-4" />
                                </Button>
                                <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)} disabled={!manualAddEnabled}>
                                    Add Challenge
                                </Button>
                                <Button variant="outline" size="sm" onClick={() => reload()}>
                                    Refresh
                                </Button>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div className="mb-4 flex flex-wrap items-center gap-3">
                            <Input className="w-64" placeholder="Search challenge" value={search} onChange={(event) => setSearch(event.target.value)} />
                            <Select value={difficultyFilter} onValueChange={(value) => setDifficultyFilter(value ?? "all")}>
                                <SelectTrigger className="w-40">
                                    <SelectValue>{filterLabel(difficultyFilter, "All Difficulty")}</SelectValue>
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Difficulty</SelectItem>
                                    {difficultyOptions.map((option) => (
                                        <SelectItem key={option} value={option}>
                                            {option}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Select value={levelFilter} onValueChange={(value) => setLevelFilter(value ?? "all")}>
                                <SelectTrigger className="w-32">
                                    <SelectValue>{filterLabel(levelFilter, "All Level")}</SelectValue>
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Level</SelectItem>
                                    {levelOptions.map((option) => (
                                        <SelectItem key={option} value={option}>
                                            Level {option}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value ?? "all")}>
                                <SelectTrigger className="w-40">
                                    <SelectValue>{filterLabel(statusFilter, "All Status")}</SelectValue>
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Status</SelectItem>
                                    {statusOptions.map((option) => (
                                        <SelectItem key={option} value={option}>
                                            {option}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Select value={hintFilter} onValueChange={(value) => setHintFilter(value ?? "all")}>
                                <SelectTrigger className="w-40">
                                    <SelectValue>{filterLabel(hintFilter, "All Hint")}</SelectValue>
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Hint</SelectItem>
                                    <SelectItem value="viewed">Viewed</SelectItem>
                                    <SelectItem value="not-viewed">Not Viewed</SelectItem>
                                </SelectContent>
                            </Select>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                    setSearch("")
                                    setDifficultyFilter("all")
                                    setLevelFilter("all")
                                    setStatusFilter("all")
                                    setHintFilter("all")
                                }}
                            >
                                Reset
                            </Button>
                        </div>
                        {!manualAddEnabled && (
                            <div className="mb-4 text-sm text-muted-foreground">Manual add is only available when mock mode is enabled.</div>
                        )}
                        {(loading || filteredChallenges.length > 0) && (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>ID</TableHead>
                                        <TableHead>Title</TableHead>
                                        <TableHead>Difficulty</TableHead>
                                        <TableHead>Level</TableHead>
                                        <TableHead>Hint</TableHead>
                                        <TableHead>Hint Content</TableHead>
                                        <TableHead>Entrypoint</TableHead>
                                        <TableHead>Score</TableHead>
                                        <TableHead>Flags</TableHead>
                                        <TableHead>Status</TableHead>
                                        <TableHead>Actions</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {loading &&
                                        Array.from({ length: 6 }).map((_, index) => (
                                            <TableRow key={`skeleton-${index}`}>
                                                <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                                                <TableCell><Skeleton className="h-4 w-full max-w-[22rem]" /></TableCell>
                                                <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                                                <TableCell><Skeleton className="h-4 w-10" /></TableCell>
                                                <TableCell><Skeleton className="h-5 w-20 rounded-full" /></TableCell>
                                                <TableCell><Skeleton className="h-4 w-10" /></TableCell>
                                                <TableCell><Skeleton className="h-4 w-full max-w-[18rem]" /></TableCell>
                                                <TableCell><Skeleton className="h-4 w-full max-w-[14rem]" /></TableCell>
                                                <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                                                <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                                                <TableCell><Skeleton className="h-8 w-24" /></TableCell>
                                            </TableRow>
                                        ))}
                                    {!loading &&
                                        filteredChallenges.map((challenge) => (
                                            <TableRow
                                                key={challenge.id}
                                                className="cursor-pointer"
                                                onClick={() => {
                                                    location.hash = `#/challenge/${challenge.id}`
                                                }}
                                            >
                                                <TableCell className="font-mono text-xs">{challenge.id}</TableCell>
                                                <TableCell className="max-w-[32rem]">
                                                    <div className="truncate font-medium">{challenge.title}</div>
                                                    <div className="truncate text-xs text-muted-foreground">{challenge.description || "No description."}</div>
                                                </TableCell>
                                                <TableCell>{challenge.difficulty}</TableCell>
                                                <TableCell>{challenge.level}</TableCell>
                                                <TableCell>{challenge.hint_viewed ? "Yes" : "No"}</TableCell>
                                                <TableCell className="max-w-[20rem]">
                                                    <div className="truncate text-xs text-muted-foreground">{hintPreview(challenge.hint_content)}</div>
                                                </TableCell>
                                                <TableCell className="max-w-[20rem]">
                                                    <div className="truncate text-xs text-muted-foreground">
                                                        {challenge.entrypoint?.join(", ") || "—"}
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    {challenge.total_got_score}/{challenge.total_score}
                                                </TableCell>
                                                <TableCell>
                                                    {challenge.flag_got_count}/{challenge.flag_count}
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant="outline" className={challengeStatusBadgeClass(challengeStatus(challenge))}>
                                                        {challengeStatus(challenge)}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell>
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        disabled={startingChallengeId === challenge.id || challengeStatus(challenge) === "solved"}
                                                        onClick={(event) => {
                                                            event.stopPropagation()
                                                            openStartSolverDialog(challenge.id)
                                                        }}
                                                    >
                                                        {startingChallengeId === challenge.id ? "Starting..." : "Start Solver"}
                                                    </Button>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                </TableBody>
                            </Table>
                        )}
                        {startSolverError && <div className="mt-4 text-sm text-red-500">{startSolverError}</div>}
                        {plannerMessage && <div className="mt-4 text-sm text-muted-foreground">{plannerMessage}</div>}
                        {!loading && challengeItems.length === 0 && <div className="text-sm text-muted-foreground">No challenges.</div>}
                        {!loading && challengeItems.length > 0 && filteredChallenges.length === 0 && <div className="text-sm text-muted-foreground">No matching challenges.</div>}
                    </CardContent>
                </Card>

                <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                    <DialogContent className="max-w-2xl">
                        <DialogHeader>
                            <DialogTitle>Add Challenge</DialogTitle>
                            <DialogDescription>One challenge creates one directory with `challenge.json`, memory, ideas, attempts, and submissions.</DialogDescription>
                        </DialogHeader>
                        <div className="grid gap-3 md:grid-cols-2">
                            <div className="space-y-2">
                                <Label htmlFor="challenge-id">Challenge ID</Label>
                                <Input id="challenge-id" placeholder="web-001" value={draftId} onChange={(event) => setDraftId(event.target.value)} />
                                <div className="text-xs text-muted-foreground">Stored id will always use the `mock-` prefix.</div>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="challenge-title">Title</Label>
                                <Input id="challenge-title" placeholder="Login Panel" value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="challenge-difficulty">Difficulty</Label>
                                <Select value={draftDifficulty} onValueChange={(value) => setDraftDifficulty(value ?? "easy")}>
                                    <SelectTrigger id="challenge-difficulty">
                                        <SelectValue>{draftDifficulty}</SelectValue>
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="easy">easy</SelectItem>
                                        <SelectItem value="medium">medium</SelectItem>
                                        <SelectItem value="hard">hard</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="challenge-level">Level</Label>
                                <Input id="challenge-level" placeholder="1" value={draftLevel} onChange={(event) => setDraftLevel(event.target.value)} />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="challenge-total-score">Total Score</Label>
                                <Input id="challenge-total-score" placeholder="100" value={draftTotalScore} onChange={(event) => setDraftTotalScore(event.target.value)} />
                            </div>
                            <div className="space-y-2 md:col-span-2">
                                <Label htmlFor="challenge-entrypoint">Entrypoint</Label>
                                <div className="space-y-2">
                                    {draftEntrypoints.map((entrypoint, index) => (
                                        <div key={`entrypoint-${index}`} className="flex items-center gap-2">
                                            <Input
                                                id={index === 0 ? "challenge-entrypoint" : undefined}
                                                placeholder="127.0.0.1:8080"
                                                value={entrypoint}
                                                onChange={(event) => {
                                                    const next = [...draftEntrypoints]
                                                    next[index] = event.target.value
                                                    setDraftEntrypoints(next)
                                                }}
                                            />
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                type="button"
                                                onClick={() => {
                                                    setDraftEntrypoints(draftEntrypoints.filter((_, itemIndex) => itemIndex !== index))
                                                }}
                                                disabled={draftEntrypoints.length === 1}
                                            >
                                                Remove
                                            </Button>
                                        </div>
                                    ))}
                                    <Button variant="outline" size="sm" type="button" onClick={() => setDraftEntrypoints([...draftEntrypoints, ""])}>
                                        Add Entrypoint
                                    </Button>
                                </div>
                            </div>
                            <div className="space-y-2 md:col-span-2">
                                <Label htmlFor="challenge-flags">Flags</Label>
                                <div className="space-y-2">
                                    {draftFlags.map((flag, index) => (
                                        <div key={`flag-${index}`} className="flex items-center gap-2">
                                            <Input
                                                id={index === 0 ? "challenge-flags" : undefined}
                                                placeholder="flag{example}"
                                                value={flag}
                                                onChange={(event) => {
                                                    const next = [...draftFlags]
                                                    next[index] = event.target.value
                                                    setDraftFlags(next)
                                                }}
                                            />
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                type="button"
                                                onClick={() => {
                                                    setDraftFlags(draftFlags.filter((_, itemIndex) => itemIndex !== index))
                                                }}
                                                disabled={draftFlags.length === 1}
                                            >
                                                Remove
                                            </Button>
                                        </div>
                                    ))}
                                    <Button variant="outline" size="sm" type="button" onClick={() => setDraftFlags([...draftFlags, ""])}>
                                        Add Flag
                                    </Button>
                                </div>
                            </div>
                            <div className="space-y-2 md:col-span-2">
                                <Label htmlFor="challenge-hint-content">Hint Content</Label>
                                <Textarea
                                    id="challenge-hint-content"
                                    placeholder="Optional hint returned by mock challenge API"
                                    value={draftHintContent}
                                    onChange={(event) => setDraftHintContent(event.target.value)}
                                />
                            </div>
                            <div className="space-y-2 md:col-span-2">
                                <Label htmlFor="challenge-description">Description</Label>
                                <Textarea id="challenge-description" placeholder="Challenge description" value={draftDescription} onChange={(event) => setDraftDescription(event.target.value)} />
                            </div>
                        </div>
                        {createError && <div className="text-sm text-red-500">{createError}</div>}
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setDialogOpen(false)}>
                                Cancel
                            </Button>
                            <Button
                                onClick={() => void handleCreateChallenge()}
                                disabled={creating || !manualAddEnabled || !draftId.trim() || !draftTitle.trim() || draftFlags.every((item) => item.trim().length === 0)}
                            >
                                {creating ? "Creating..." : "Create"}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>

                <StatsOverviewDialog
                    open={statsDialogOpen}
                    onOpenChange={setStatsDialogOpen}
                    statsOverview={statsOverview ?? undefined}
                    loading={statsOverviewLoading}
                />
                <Dialog open={startDialogOpen} onOpenChange={setStartDialogOpen}>
                    <DialogContent className="max-w-md">
                        <DialogHeader>
                            <DialogTitle>Start Solver</DialogTitle>
                            <DialogDescription>手动启动必须显式选择一个 agent prompt。</DialogDescription>
                        </DialogHeader>
                        <div className="space-y-2">
                            <Label htmlFor="challenge-start-prompt">Prompt</Label>
                            <Select value={startPromptName} onValueChange={(value) => setStartPromptName(value ?? "")}>
                                <SelectTrigger id="challenge-start-prompt">
                                    <SelectValue>{startPromptName || "Select prompt"}</SelectValue>
                                </SelectTrigger>
                                <SelectContent>
                                    {(agentPrompts ?? []).map((prompt) => (
                                        <SelectItem key={prompt.name} value={prompt.name}>
                                            {prompt.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {promptsLoading && <div className="text-xs text-muted-foreground">Loading prompts...</div>}
                        </div>
                        {startSolverError && <div className="text-sm text-red-500">{startSolverError}</div>}
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setStartDialogOpen(false)}>
                                Cancel
                            </Button>
                            <Button onClick={() => void handleConfirmStartSolver()} disabled={!startPromptName || promptsLoading || startingSolver}>
                                {startingSolver ? "Starting..." : "Start"}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
                <Dialog open={plannerDialogOpen} onOpenChange={setPlannerDialogOpen}>
                    <DialogContent className="max-w-2xl">
                        <DialogHeader>
                            <DialogTitle>Planner Strategy</DialogTitle>
                            <DialogDescription>这部分会作为系统提示词附加项注入给演练规划 agent，用来表达用户的调度偏好。</DialogDescription>
                        </DialogHeader>
                        <div className="space-y-2">
                            <Label htmlFor="planner-strategy-list">Strategy</Label>
                            <Textarea
                                id="planner-strategy-list"
                                placeholder="例如：前期优先简单题；卡住 20 分钟就看 hint；最后两题集中火力。"
                                value={plannerStrategy}
                                onChange={(event) => setPlannerStrategy(event.target.value)}
                                rows={8}
                            />
                        </div>
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setPlannerDialogOpen(false)}>
                                Cancel
                            </Button>
                            <Button onClick={() => void handleSavePlannerStrategy()} disabled={plannerSaving}>
                                {plannerSaving ? "Saving..." : "Save"}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </div>
        )
    }

    return (
        <div className="flex min-w-0 flex-1 flex-col gap-4 p-6">
            <div>
                <Button variant="outline" size="sm" onClick={() => (location.hash = "#/")}>
                    Back
                </Button>
            </div>

            {detailsLoading && (
                <Card>
                    <CardContent className="p-6 text-sm text-muted-foreground">Loading challenge details...</CardContent>
                </Card>
            )}

            {detailsError && (
                <Card>
                    <CardContent className="p-6 text-sm text-red-500">{detailsError}</CardContent>
                </Card>
            )}

            {details && (
                <div className="min-w-0 space-y-6">
                    <div className="min-w-0 space-y-3 border-b pb-6">
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0 space-y-2">
                                <div className="break-words text-2xl font-semibold">{details.challenge.title}</div>
                                <div className="flex flex-wrap gap-2">
                                    <Badge variant="outline">{details.challenge.id}</Badge>
                                    <Badge variant="outline">{details.challenge.difficulty}</Badge>
                                    <Badge variant="outline">level {details.challenge.level}</Badge>
                                    <Badge variant="outline" className={challengeStatusBadgeClass(challengeStatus(details.challenge))}>
                                        {challengeStatus(details.challenge)}
                                    </Badge>
                                </div>
                            </div>
                            <div className="shrink-0 space-y-3 text-right text-sm text-muted-foreground">
                                <div>
                                    <div>score {details.challenge.total_got_score}/{details.challenge.total_score}</div>
                                    <div>flags {details.challenge.flag_got_count}/{details.challenge.flag_count}</div>
                                    <div>attempts {details.attempts.length}</div>
                                    <div>submissions {details.submissions.length}</div>
                                </div>
                                <div className="flex justify-end gap-2">
                                    <Button variant="outline" size="sm" onClick={() => void handleExportSolverSessions()} disabled={exportingSessions || details.solver_stats.length === 0}>
                                        {exportingSessions ? "Exporting..." : "Export Sessions"}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => {
                                            location.hash = `#/challenge/${encodeURIComponent(details.challenge.id)}/attack-flow`
                                        }}
                                    >
                                        Attack Flow
                                    </Button>
                                    <Button
                                        size="sm"
                                        onClick={() => openStartSolverDialog(details.challenge.id)}
                                        disabled={startingSolver || challengeStatus(details.challenge) === "solved"}
                                    >
                                        {startingChallengeId === details.challenge.id ? "Starting..." : "Start Solver"}
                                    </Button>
                                    {details.challenge.objective_achieved === true ? (
                                        <Button variant="outline" size="sm" onClick={() => void handleRevokeComplete()} disabled={completionBusy}>
                                            {completionBusy ? "处理中..." : "撤销完成"}
                                        </Button>
                                    ) : (
                                        <Button variant="outline" size="sm" onClick={() => void handleConfirmComplete()} disabled={completionBusy}>
                                            {completionBusy ? "处理中..." : "确认完成"}
                                        </Button>
                                    )}
                                </div>
                            </div>
                        </div>
                        {startSolverError && <div className="text-sm text-red-500">{startSolverError}</div>}
                        {sessionExportError && <div className="text-sm text-red-500">{sessionExportError}</div>}
                        {completionMessage && <div className="text-sm text-muted-foreground">{completionMessage}</div>}
                        {plannerMessage && <div className="text-sm text-muted-foreground">{plannerMessage}</div>}
                        <div className="grid gap-6 md:grid-cols-2">
                            <section className="min-w-0 space-y-2">
                                <div className="text-sm font-medium">Description</div>
                                <div className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{details.challenge.description || "No description."}</div>
                            </section>
                            <section className="min-w-0 space-y-2">
                                <div className="flex items-center gap-2 text-sm font-medium">
                                    <span>Hint</span>
                                    <Badge variant="outline">{details.challenge.hint_viewed ? "viewed" : "not viewed"}</Badge>
                                </div>
                                <div className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                                    {details.challenge.hint_content?.trim() || "No hint content."}
                                </div>
                            </section>
                        </div>
                        <div className="grid gap-3 md:grid-cols-4">
                            <div className="rounded-lg border px-4 py-3">
                                <div className="text-xs text-muted-foreground">Wall Time</div>
                                <div className="mt-1 text-sm font-medium">{formatMinutes(details.stats.solve_duration_ms)}</div>
                            </div>
                            <div className="rounded-lg border px-4 py-3">
                                <div className="text-xs text-muted-foreground">Total Solver Time</div>
                                <div className="mt-1 text-sm font-medium">{formatMinutes(details.stats.solver_active_duration_ms_total)}</div>
                            </div>
                            <div className="rounded-lg border px-4 py-3">
                                <div className="text-xs text-muted-foreground">Total Tokens</div>
                                <div className="mt-1 text-sm font-medium">{formatTokenCount(details.stats.usage.total)}</div>
                            </div>
                            <div className="rounded-lg border px-4 py-3">
                                <div className="text-xs text-muted-foreground">Solvers</div>
                                <div className="mt-1 text-sm font-medium">{details.stats.solver_count}</div>
                            </div>
                        </div>
                    </div>

                    <Tabs value={detailTab} onValueChange={setDetailTab} className="min-w-0 space-y-4">
                        <TabsList>
                            <TabsTrigger value="solvers">Solvers</TabsTrigger>
                            <TabsTrigger value="memory">Memory</TabsTrigger>
                            <TabsTrigger value="ideas">Ideas</TabsTrigger>
                            <TabsTrigger value="submissions">Submissions</TabsTrigger>
                        </TabsList>

                        <TabsContent value="solvers" className="min-w-0 space-y-3">
                            {details.solver_stats.length > 0 && (
                                <div className="min-w-0 space-y-3">
                                    {sortSolverStatsByNewestFirst(details.solver_stats, details.solvers).map((solverStat) => {
                                        const liveSolver = details.solvers.find((item) => item.id === solverStat.solver_id)
                                        const clickable = Boolean(liveSolver) || solverStat.solver_id.trim().length > 0
                                        const stoppable = liveSolver && activeSolvers([liveSolver]).length > 0
                                        return (
                                            <div
                                                key={solverStat.solver_id}
                                                role={clickable ? "button" : undefined}
                                                tabIndex={clickable ? 0 : undefined}
                                                onClick={() => {
                                                    if (!clickable) return
                                                    openRuntimeDetailInNewTab(solverStat.solver_id)
                                                }}
                                                onKeyDown={(event) => {
                                                    if (!clickable) return
                                                    if (event.key !== "Enter" && event.key !== " ") return
                                                    event.preventDefault()
                                                    openRuntimeDetailInNewTab(solverStat.solver_id)
                                                }}
                                                className={`w-full min-w-0 rounded-lg border px-4 py-3 text-left transition ${
                                                    clickable ? "cursor-pointer hover:bg-muted/50" : ""
                                                }`}
                                            >
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="min-w-0">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <div className="break-all font-medium">{solverStat.solver_id}</div>
                                                            {liveSolver && <Badge variant="outline">{liveSolver.status}</Badge>}
                                                        </div>
                                                        <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
                                                            {solverStat.prompt_name && <span>prompt {solverStat.prompt_name}</span>}
                                                            {solverStat.model_name && <span>model {solverStat.model_name}</span>}
                                                        </div>
                                                    </div>
                                                    <div className="shrink-0 text-right text-xs text-muted-foreground">
                                                        <div>
                                                            started{" "}
                                                            {solverStat.started_at
                                                                ? formatTime(solverStat.started_at)
                                                                : liveSolver
                                                                  ? formatSolverTime(liveSolver.createdAt)
                                                                  : "unknown"}
                                                        </div>
                                                        <div>duration {formatMinutes(solverStat.duration_ms)}</div>
                                                        <div>tokens {formatTokenCount(solverStat.usage.total)}</div>
                                                        {stoppable && (
                                                            <div className="mt-2">
                                                                <Button
                                                                    size="sm"
                                                                    variant="outline"
                                                                    disabled={stoppingSolverId === solverStat.solver_id}
                                                                    onClick={(event) => {
                                                                        event.stopPropagation()
                                                                        void handleStopSolver(solverStat.solver_id)
                                                                    }}
                                                                >
                                                                    {stoppingSolverId === solverStat.solver_id ? "Stopping..." : "Stop"}
                                                                </Button>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            )}
                            {details.solver_stats.length === 0 && <div className="text-sm text-muted-foreground">No solvers.</div>}
                        </TabsContent>

                        <TabsContent value="memory" className="min-w-0 space-y-3">
                            <div className="flex justify-end">
                                <Button size="sm" onClick={openCreateMemoryDialog}>
                                    <PlusIcon className="size-4" />
                                    新增 Memory
                                </Button>
                            </div>
                            {boardError ? <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-500">{boardError}</div> : null}
                            {details.memory.length === 0 && <div className="text-sm text-muted-foreground">No memory entries yet.</div>}
                            {details.memory.map((entry) => (
                                <div key={entry.id} className="min-w-0 rounded-lg border px-4 py-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="flex items-center gap-2">
                                            <Badge variant="outline">{entry.kind}</Badge>
                                            <code className="text-xs text-muted-foreground">{entry.id}</code>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Button variant="ghost" size="icon-sm" disabled={boardBusyKey.length > 0} onClick={() => openEditMemoryDialog(entry)}>
                                                <PencilIcon className="size-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                disabled={boardBusyKey.length > 0}
                                                onClick={() => {
                                                    void handleDeleteMemory(entry)
                                                }}
                                            >
                                                <Trash2Icon className="size-4" />
                                            </Button>
                                        </div>
                                    </div>
                                    <div className="mt-2 break-words text-sm">{entry.content}</div>
                                    {entry.refs.length > 0 ? <div className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{entry.refs.join("\n")}</div> : null}
                                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 break-all text-xs text-muted-foreground">
                                        <span>{entry.source}</span>
                                        <span>{formatTime(entry.updated_at)}</span>
                                    </div>
                                </div>
                            ))}
                        </TabsContent>

                        <TabsContent value="ideas" className="min-w-0 space-y-3">
                            <div className="flex justify-end">
                                <Button size="sm" onClick={openCreateIdeaDialog}>
                                    <PlusIcon className="size-4" />
                                    新增 Idea
                                </Button>
                            </div>
                            {boardError ? <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-500">{boardError}</div> : null}
                            {details.ideas.length === 0 && <div className="text-sm text-muted-foreground">No ideas yet.</div>}
                            {details.ideas.map((idea) => (
                                <div key={idea.id} className="min-w-0 rounded-lg border px-4 py-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="min-w-0 break-words text-sm font-medium">{idea.content}</div>
                                            <div className="mt-1 text-xs text-muted-foreground">{idea.id}</div>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Badge variant="outline">{idea.status}</Badge>
                                            <Button variant="ghost" size="icon-sm" disabled={boardBusyKey.length > 0} onClick={() => openEditIdeaDialog(idea)}>
                                                <PencilIcon className="size-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                disabled={boardBusyKey.length > 0}
                                                onClick={() => {
                                                    void handleDeleteIdea(idea)
                                                }}
                                            >
                                                <Trash2Icon className="size-4" />
                                            </Button>
                                        </div>
                                    </div>
                                    {idea.result && <div className="mt-2 break-words text-xs text-muted-foreground">{idea.result}</div>}
                                </div>
                            ))}
                        </TabsContent>

                        <TabsContent value="submissions" className="min-w-0 space-y-3">
                            {details.submissions.length === 0 && <div className="text-sm text-muted-foreground">No submissions yet.</div>}
                            {details.submissions.map((submission) => {
                                const solverId = submission.solver_id?.trim() || ""
                                const clickable = solverId.length > 0
                                return (
                                    <div
                                        key={submission.id}
                                        role={clickable ? "button" : undefined}
                                        tabIndex={clickable ? 0 : undefined}
                                        onClick={() => {
                                            if (!clickable) return
                                            openRuntimeDetailInNewTab(solverId)
                                        }}
                                        onKeyDown={(event) => {
                                            if (!clickable) return
                                            if (event.key !== "Enter" && event.key !== " ") return
                                            event.preventDefault()
                                            openRuntimeDetailInNewTab(solverId)
                                        }}
                                        className={`min-w-0 rounded-lg border px-4 py-3 transition ${
                                            clickable ? "cursor-pointer hover:bg-muted/50" : ""
                                        }`}
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="min-w-0 flex items-center gap-2">
                                                <Badge
                                                    variant={submission.correct ? "outline" : "outline"}
                                                    className={submission.correct ? "border-green-600/30 bg-green-500/15 text-green-700" : ""}
                                                >
                                                    {submission.correct ? "correct" : "incorrect"}
                                                </Badge>
                                                <code className="min-w-0 break-all text-xs">{submission.flag}</code>
                                            </div>
                                            <div className="text-xs text-muted-foreground">{formatTime(submission.created_at)}</div>
                                        </div>
                                        <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                                            {submission.solver_id && <span>solver {submission.solver_id}</span>}
                                            {submission.prompt_name && <span>prompt {submission.prompt_name}</span>}
                                            {submission.model_name && <span>model {submission.model_name}</span>}
                                        </div>
                                        {submission.writeup && (
                                            <div className="mt-2 space-y-1">
                                                <div className="text-xs font-medium text-foreground">Writeup</div>
                                                <div className="break-words text-sm text-muted-foreground">{submission.writeup}</div>
                                            </div>
                                        )}
                                        {submission.message && <div className="mt-2 break-words text-sm text-muted-foreground">{submission.message}</div>}
                                    </div>
                                )
                            })}
                        </TabsContent>
                    </Tabs>
                </div>
            )}
            <Dialog open={startDialogOpen} onOpenChange={setStartDialogOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Start Solver</DialogTitle>
                        <DialogDescription>手动启动必须显式选择一个 agent prompt。</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2">
                        <Label htmlFor="challenge-start-prompt-detail">Prompt</Label>
                        <Select value={startPromptName} onValueChange={(value) => setStartPromptName(value ?? "")}>
                            <SelectTrigger id="challenge-start-prompt-detail">
                                <SelectValue>{startPromptName || "Select prompt"}</SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                                {(agentPrompts ?? []).map((prompt) => (
                                    <SelectItem key={prompt.name} value={prompt.name}>
                                        {prompt.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {promptsLoading && <div className="text-xs text-muted-foreground">Loading prompts...</div>}
                    </div>
                    {startSolverError && <div className="text-sm text-red-500">{startSolverError}</div>}
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setStartDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={() => void handleConfirmStartSolver()} disabled={!startPromptName || promptsLoading || startingSolver}>
                            {startingSolver ? "Starting..." : "Start"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            <Dialog open={memoryDialogOpen} onOpenChange={setMemoryDialogOpen}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{editingMemory ? "编辑 Memory" : "新增 Memory"}</DialogTitle>
                        <DialogDescription>用于维护 durable facts、evidence、failure boundaries 或 hint。</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label>Kind</Label>
                            <Select value={memoryForm.kind} onValueChange={(value) => setMemoryForm((current) => ({ ...current, kind: value as MemoryEntry["kind"] }))}>
                                <SelectTrigger>
                                    <SelectValue placeholder="选择 kind" />
                                </SelectTrigger>
                                <SelectContent>
                                    {MEMORY_KIND_OPTIONS.map((item) => (
                                        <SelectItem key={item} value={item}>
                                            {item}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <Label>Content</Label>
                            <Textarea rows={4} value={memoryForm.content} onChange={(event) => setMemoryForm((current) => ({ ...current, content: event.target.value }))} />
                        </div>
                        <div className="space-y-2">
                            <Label>Refs</Label>
                            <Textarea
                                rows={3}
                                placeholder="每行一个引用路径或说明"
                                value={memoryForm.refsText}
                                onChange={(event) => setMemoryForm((current) => ({ ...current, refsText: event.target.value }))}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Source</Label>
                            <Textarea rows={2} value={memoryForm.source} onChange={(event) => setMemoryForm((current) => ({ ...current, source: event.target.value }))} />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setMemoryDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={() => void handleSaveMemory()} disabled={boardBusyKey.length > 0 || !memoryForm.content.trim() || !memoryForm.source.trim()}>
                            保存
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            <Dialog open={ideaDialogOpen} onOpenChange={setIdeaDialogOpen}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{editingIdea ? "编辑 Idea" : "新增 Idea"}</DialogTitle>
                        <DialogDescription>idea 是待验证假设。新增和编辑都支持调整内容、状态和结果。</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label>Content</Label>
                            <Textarea
                                rows={3}
                                placeholder="输入待验证假设"
                                value={ideaForm.content}
                                onChange={(event) => setIdeaForm((current) => ({ ...current, content: event.target.value }))}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Status</Label>
                            <Select value={ideaForm.status} onValueChange={(value) => setIdeaForm((current) => ({ ...current, status: value as IdeaRecord["status"] }))}>
                                <SelectTrigger>
                                    <SelectValue placeholder="选择 status" />
                                </SelectTrigger>
                                <SelectContent>
                                    {IDEA_STATUS_OPTIONS.map((item) => (
                                        <SelectItem key={item} value={item}>
                                            {item}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <Label>Result</Label>
                            <Textarea rows={4} value={ideaForm.result} onChange={(event) => setIdeaForm((current) => ({ ...current, result: event.target.value }))} />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIdeaDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={() => void handleSaveIdea()} disabled={boardBusyKey.length > 0 || !ideaForm.content.trim()}>
                            保存
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
