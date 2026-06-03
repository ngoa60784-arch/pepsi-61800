import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react"
import { createElement, startTransition, useEffect, useMemo, useRef, useState } from "react"
import type { Edge, EdgeProps, Node, NodeMouseHandler } from "@xyflow/react"
import { Background, BaseEdge, Controls, EdgeLabelRenderer, MarkerType, Position, ReactFlow, getBezierPath, useReactFlow } from "@xyflow/react"
import { BellIcon, BotIcon, DatabaseIcon, FlagIcon, LightbulbIcon, PauseIcon, PlayIcon, RotateCcwIcon, RouteIcon, SendIcon, TargetIcon } from "lucide-react"
import { challenges, runtime } from "../../lib/api"
import type { AttackTimelineEvent, AttackTimelineSnapshot, ChallengeInfoRecord, IdeaRecord, MemoryEntry } from "../../lib/api"
import type { ElkDirection } from "../../lib/elk-layout"
import { layoutFlowElements } from "../../lib/elk-layout"
import type { RuntimeDetailsView, RuntimeThreadView } from "../runtime/types"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { Card, CardContent } from "../ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { Slider } from "../ui/slider"
import { cn } from "../../lib/utils"

type KnowledgeGroup = "task" | "memory-failure" | "memory-evidence" | "memory-fact" | "memory-hint" | "memory-note" | "idea-active"
type FlowNode = Node<{ label: ReactNode; solverId?: string; eventId?: string; rawId?: string; graphRole?: "task" | "memory" | "idea"; knowledgeGroup?: KnowledgeGroup }>
type FlowLayoutMode = "elk" | "mindmap"
type FlowGraph = { nodes: FlowNode[]; edges: Edge[]; layoutEdges?: Edge[] }

function EventFlowEdge(props: EdgeProps) {
    const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, label } = props
    const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
    const pathId = `${id}-path`
    const data = (props.data as { particleColor?: string; active?: boolean; direction?: "forward" | "reverse" } | undefined) ?? {}
    const particleColor = data.particleColor ?? "#0ea5e9"
    const active = data.active === true
    const reverse = data.direction === "reverse"

    const labelText = label ? clip(String(label), 72) : ""

    return (
        <g>
            <path
                id={pathId}
                d={edgePath}
                fill="none"
                style={{
                    stroke: style?.stroke ?? "#64748b",
                    strokeWidth: active ? 2.2 : 1.3,
                    strokeOpacity: active ? 0.95 : 0.55,
                    strokeDasharray: active ? "10 8" : style?.strokeDasharray,
                }}
                markerEnd={active && !reverse ? markerEnd : undefined}
                markerStart={active && reverse ? markerEnd : undefined}
            >
                {active ? <animate attributeName="stroke-dashoffset" dur="1.4s" repeatCount="indefinite" values={reverse ? "0;18" : "0;-18"} /> : null}
            </path>
            <BaseEdge id={id} path={edgePath} style={{ stroke: "transparent", strokeWidth: 10 }} />
            {labelText ? (
                <EdgeLabelRenderer>
                    <div
                        className="pointer-events-none absolute max-w-[240px] -translate-x-1/2 -translate-y-1/2 rounded-md border border-slate-300/80 bg-white/95 px-2 py-1 text-[11px] font-semibold leading-snug text-slate-700 shadow-sm"
                        style={{
                            left: `${labelX}px`,
                            top: `${labelY - 12}px`,
                            display: "-webkit-box",
                            WebkitBoxOrient: "vertical",
                            WebkitLineClamp: 2,
                            overflow: "hidden",
                        }}
                    >
                        {labelText}
                    </div>
                </EdgeLabelRenderer>
            ) : null}
        </g>
    )
}

const EDGE_TYPES = { "event-flow": EventFlowEdge }

interface RuntimeOfficialMessageListElement extends HTMLElement {
    messages: Record<string, unknown>[]
    tools: unknown[]
    pendingToolCalls?: ReadonlySet<string>
    isStreaming: boolean
    subagentThreadsByToolCallId?: Record<string, RuntimeThreadView[]>
}

interface AttackFlowProps {
    challengeId: string
}

const DEFAULT_PANEL_WIDTHS = [50, 50]
const DEFAULT_GRAPH_HEIGHTS = [50, 50]
const MIN_PANEL_WIDTH_PERCENT = 28
const MIN_GRAPH_HEIGHT_PERCENT = 24
const PANEL_KEYBOARD_STEP = 3
const GRAPH_KEYBOARD_STEP = 3
const TIMELINE_TIME_COLUMN_WIDTH = 72
const TIMELINE_LANE_WIDTH = 112
const TIMELINE_COLUMN_GAP = 8
const REPLAY_STEP_MS = 220
const CHALLENGE_NODE_WIDTH = 360
const CHALLENGE_NODE_HEIGHT = 132
const PLAYBACK_SPEED_OPTIONS = ["0.5", "1", "2", "4"] as const
type PlaybackSpeed = (typeof PLAYBACK_SPEED_OPTIONS)[number]

function resizePanelWidths(widths: number[], deltaPercent: number) {
    const next = [...widths]
    const pairTotal = next[0] + next[1]
    const minWidth = Math.min(MIN_PANEL_WIDTH_PERCENT, pairTotal / 2)
    const left = Math.min(Math.max(next[0] + deltaPercent, minWidth), pairTotal - minWidth)
    next[0] = Number(left.toFixed(2))
    next[1] = Number((pairTotal - left).toFixed(2))
    return next
}

function resizeGraphHeights(heights: number[], deltaPercent: number) {
    const next = [...heights]
    const pairTotal = next[0] + next[1]
    const minHeight = Math.min(MIN_GRAPH_HEIGHT_PERCENT, pairTotal / 2)
    const top = Math.min(Math.max(next[0] + deltaPercent, minHeight), pairTotal - minHeight)
    next[0] = Number(top.toFixed(2))
    next[1] = Number((pairTotal - top).toFixed(2))
    return next
}

function isResizeObserverLoopError(value: unknown) {
    const message = value instanceof Error ? value.message : String(value)
    return message.includes("ResizeObserver loop completed with undelivered notifications") || message.includes("ResizeObserver loop limit exceeded")
}

function installResizeObserverLoopErrorGuard() {
    if (typeof window === "undefined") return
    const key = "__tchAttackFlowResizeObserverGuard"
    const guardedWindow = window as Window & { [key]?: boolean }
    if (guardedWindow[key]) return
    guardedWindow[key] = true

    window.addEventListener("error", (event) => {
        if (!isResizeObserverLoopError(event.error ?? event.message)) return
        event.preventDefault()
        event.stopImmediatePropagation()
    }, true)
    window.addEventListener("unhandledrejection", (event) => {
        if (!isResizeObserverLoopError(event.reason)) return
        event.preventDefault()
    }, true)
}

installResizeObserverLoopErrorGuard()

function formatTimelineTime(value?: number) {
    if (!value) return "开始"
    return new Date(value).toLocaleString()
}

function formatCompactDuration(start: number, end: number) {
    const totalSeconds = Math.max(0, Math.floor((end - start) / 1000))
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    if (hours > 0) return `${hours}h ${minutes}m`
    if (minutes > 0) return `${minutes}m ${seconds}s`
    return `${seconds}s`
}

function clip(value: unknown, maxChars = 96) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}...`
}

function payloadObject(event: AttackTimelineEvent): Record<string, unknown> | undefined {
    return event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : undefined
}

function memoryFromEvent(event: AttackTimelineEvent): MemoryEntry | undefined {
    const entry = payloadObject(event)?.entry
    if (!entry || typeof entry !== "object") return
    if (typeof (entry as { id?: unknown }).id !== "string") return
    const value = entry as Partial<MemoryEntry> & { id: string }
    return {
        id: value.id,
        challengeId: value.challengeId ?? event.challengeId,
        kind: value.kind ?? "note",
        content: value.content ?? "",
        refs: Array.isArray(value.refs) ? value.refs.filter((item): item is string => typeof item === "string") : [],
        source: value.source ?? "runtime",
        created_at: value.created_at ?? new Date(event.timestamp).toISOString(),
        updated_at: value.updated_at ?? value.created_at ?? new Date(event.timestamp).toISOString(),
    }
}

function ideaFromEvent(event: AttackTimelineEvent): IdeaRecord | undefined {
    const item = payloadObject(event)?.item
    if (!item || typeof item !== "object") return
    if (typeof (item as { id?: unknown }).id !== "string") return
    const value = item as Partial<IdeaRecord> & { id: string }
    return {
        id: value.id,
        content: value.content ?? "",
        normalized: value.normalized ?? String(value.content ?? "").toLowerCase(),
        status: value.status ?? "pending",
        result: value.result ?? "",
        created_at: value.created_at ?? new Date(event.timestamp).toISOString(),
        updated_at: value.updated_at ?? value.created_at ?? new Date(event.timestamp).toISOString(),
    }
}

function submissionFromEvent(event: AttackTimelineEvent) {
    const submission = payloadObject(event)?.submission
    if (!submission || typeof submission !== "object") return
    return submission as { correct?: boolean; flag?: string }
}

function promptNameFromEvent(event: AttackTimelineEvent) {
    const payload = payloadObject(event)
    const attempt = payload?.attempt
    if (attempt && typeof attempt === "object" && typeof (attempt as { prompt_name?: unknown }).prompt_name === "string") {
        return (attempt as { prompt_name: string }).prompt_name
    }
    const solverStat = payload?.solverStat
    if (solverStat && typeof solverStat === "object" && typeof (solverStat as { prompt_name?: unknown }).prompt_name === "string") {
        return (solverStat as { prompt_name: string }).prompt_name
    }
    return
}

interface SolverMeta {
    id: string
    promptName?: string
    firstSeen: number
    lastSeen: number
    eventCount: number
    observerEventCount: number
    latestTitle?: string
}

function solverMetasFromEvents(events: AttackTimelineEvent[]): SolverMeta[] {
    const metas = new Map<string, SolverMeta>()
    for (const event of events) {
        if (!event.solverId) continue
        const current = metas.get(event.solverId) ?? {
            id: event.solverId,
            firstSeen: event.timestamp,
            lastSeen: event.timestamp,
            eventCount: 0,
            observerEventCount: 0,
        }
        current.firstSeen = Math.min(current.firstSeen, event.timestamp)
        current.lastSeen = Math.max(current.lastSeen, event.timestamp)
        current.eventCount += 1
        if (event.lane === "observer") current.observerEventCount += 1
        current.latestTitle = event.title
        current.promptName ??= promptNameFromEvent(event)
        metas.set(event.solverId, current)
    }
    return [...metas.values()].sort((left, right) => left.firstSeen - right.firstSeen || left.id.localeCompare(right.id))
}

function eventIsoTime(event: AttackTimelineEvent) {
    return new Date(event.timestamp).toISOString()
}

function memoryKindLabel(kind: MemoryEntry["kind"]): string {
    switch (kind) {
        case "evidence":
            return "证据"
        case "credential":
            return "凭据"
        case "failure":
            return "失败边界"
        case "hint":
            return "提示"
        case "note":
            return "笔记"
        case "fact":
            return "发现"
        default:
            return "记忆"
    }
}

function nodeLabel(title: string, badge: string, summary: string, meta?: string[]) {
    function badgeGlyph(kind: string) {
        switch (kind) {
            case "task":
            case "goal":
                return <TargetIcon className="size-3.5" />
            case "solver":
                return <BotIcon className="size-3.5" />
            case "memory":
                return <DatabaseIcon className="size-3.5" />
            case "idea":
                return <LightbulbIcon className="size-3.5" />
            case "flag":
                return <FlagIcon className="size-3.5" />
            case "broadcast":
            case "observe":
                return <BellIcon className="size-3.5" />
            default:
                return <SendIcon className="size-3.5" />
        }
    }

    return (
        <div className="flex w-full min-w-0 max-w-full flex-col gap-1.5 overflow-hidden text-left">
            <div className="flex min-w-0 items-start gap-2">
                <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-700">{badgeGlyph(badge)}</span>
                <span className="min-w-0 break-words text-xs font-semibold tracking-wide text-slate-900">{clip(title, 72)}</span>
            </div>
            {summary ? (
                <div
                    className="min-w-0 break-words text-[11px] leading-snug text-slate-600"
                    style={{
                        display: "-webkit-box",
                        WebkitBoxOrient: "vertical",
                        WebkitLineClamp: 3,
                        overflow: "hidden",
                    }}
                >
                    {clip(summary, 220)}
                </div>
            ) : null}
            {meta && meta.length > 0 ? (
                <div className="flex min-w-0 flex-wrap gap-1 pt-0.5">
                    {meta.slice(0, 3).map((item) => (
                        <span key={item} className="max-w-full truncate rounded border border-current/15 bg-white/55 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                            {item}
                        </span>
                    ))}
                </div>
            ) : null}
        </div>
    )
}

function knowledgeNodeLabel(type: "TASK" | "MEMORY" | "IDEA", kind: string, title: string, body: string, meta: string[]) {
    const updates = meta.find((item) => item.endsWith("updates"))
    const TypeIcon = type === "MEMORY" ? DatabaseIcon : type === "IDEA" ? LightbulbIcon : TargetIcon
    return (
        <div className="flex w-full min-w-0 flex-col gap-1.5 overflow-hidden text-left">
            <div className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                <TypeIcon className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{kind}</span>
            </div>
            <div
                className="min-w-0 break-words text-xs font-semibold leading-snug text-slate-950"
                style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden" }}
            >
                {clip(title, 80)}
            </div>
            <div
                className="min-w-0 break-words text-[11px] leading-snug text-slate-600"
                style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden" }}
            >
                {clip(body, 140)}
            </div>
            {updates ? <div className="truncate text-[10px] font-medium text-slate-400">{updates}</div> : null}
        </div>
    )
}

function challengeNodeTitle(challenge?: ChallengeInfoRecord) {
    return challenge?.title ? clip(challenge.title, 72) : "任务"
}

function challengeNodeSummary(challenge: ChallengeInfoRecord | undefined, fallbackId: string) {
    if (!challenge) return clip(fallbackId, 96)
    return `${challenge.flag_got_count}/${challenge.flag_count} flags · ${clip(challenge.description, 150)}`
}

type CommunicationFlowItem = {
    id: string
    event: AttackTimelineEvent
    badge: string
    title: string
    summary: string
    edgeLabel: string
    className: string
}

function communicationFlowItemFromEvent(event: AttackTimelineEvent): CommunicationFlowItem | undefined {
    if (event.kind === "observer_reminder" && !event.solverId) {
        return {
            id: `flow:${event.id}`,
            event,
            badge: "broadcast",
            title: "广播至 Solver",
            summary: event.summary,
            edgeLabel: "broadcast",
            className: "border-purple-300 bg-purple-50 text-purple-950",
        }
    }

    if (event.kind === "solver_started") {
        return {
            id: `flow:${event.id}`,
            event,
            badge: "spawn",
            title: promptNameFromEvent(event) ?? "Solver 加入",
            summary: event.solverId ?? event.summary,
            edgeLabel: "assign",
            className: "border-emerald-300 bg-emerald-50 text-emerald-950",
        }
    }

    const memory = memoryFromEvent(event)
    if (memory) {
        return {
            id: `flow:${event.id}`,
            event,
            badge: "memory",
            title: memory.kind === "failure" ? "上传失败边界" : "上传证据",
            summary: memory.content,
            edgeLabel: "upload",
            className: memory.kind === "failure" ? "border-red-300 bg-red-50 text-red-950" : "border-blue-300 bg-blue-50 text-blue-950",
        }
    }

    const idea = ideaFromEvent(event)
    if (idea) {
        return {
            id: `flow:${event.id}`,
            event,
            badge: "idea",
            title: idea.status === "failed" ? "路线被拒绝" : "提出路线",
            summary: idea.content,
            edgeLabel: "upload",
            className: idea.status === "failed" ? "border-red-300 bg-red-50 text-red-950" : "border-amber-300 bg-amber-50 text-amber-950",
        }
    }

    const submission = submissionFromEvent(event)
    if (event.kind === "flag_submitted") {
        return {
            id: `flow:${event.id}`,
            event,
            badge: "flag",
            title: submission?.correct ? "Flag 已接受" : "Flag 尝试",
            summary: submission?.flag ?? event.summary,
            edgeLabel: "submit",
            className: submission?.correct ? "border-orange-300 bg-orange-50 text-orange-950" : "border-red-300 bg-red-50 text-red-950",
        }
    }

    if (event.kind === "tool_result" && event.title.startsWith("challenge_submit_flag")) {
        return {
            id: `flow:${event.id}`,
            event,
            badge: "result",
            title: "Flag 工具返回",
            summary: event.summary,
            edgeLabel: "result",
            className: "border-orange-300 bg-orange-50 text-orange-950",
        }
    }

    if (event.lane === "observer") {
        return {
            id: `flow:${event.id}`,
            event,
            badge: "observe",
            title: "观察者引导 Solver",
            summary: event.summary,
            edgeLabel: "observe",
            className: "border-purple-300 bg-purple-50 text-purple-950",
        }
    }

    return
}

type KnowledgeTreeItem = {
    nodeId: string
    rawId: string
    refs: string[]
    timestamp: number
    firstTimestamp: number
    lastTimestamp: number
    solverId?: string
    solverIds: string[]
    badge: string
    title: string
    summary: string
    detail?: string
    className: string
    lane: "idea" | "fact" | "failure" | "hint" | "flag"
    entity: "idea" | "memory" | "flag"
    status?: string
    statusTrail: string[]
    updateCount: number
}

function boardMutationEventItem(event: AttackTimelineEvent): KnowledgeTreeItem | undefined {
    const memory = memoryFromEvent(event)
    if (memory) {
        const lane = memory.kind === "failure" ? "failure" : memory.kind === "hint" ? "hint" : "fact"
        return {
            nodeId: `memory:${memory.id}`,
            rawId: memory.id,
            refs: memory.refs,
            timestamp: event.timestamp,
            firstTimestamp: event.timestamp,
            lastTimestamp: event.timestamp,
            solverId: event.solverId,
            solverIds: event.solverId ? [event.solverId] : [],
            badge: memory.kind,
            title: memory.content,
            summary: memoryKindLabel(memory.kind),
            detail: memory.source,
            className:
                lane === "failure"
                    ? "border-red-400 bg-red-50 text-red-950"
                    : lane === "hint"
                      ? "border-violet-400 bg-violet-50 text-violet-950"
                      : "border-emerald-400 bg-emerald-50 text-emerald-950",
            lane,
            entity: "memory",
            status: memory.kind,
            statusTrail: [memory.kind],
            updateCount: 1,
        }
    }

    const idea = ideaFromEvent(event)
    if (idea) {
        const lane = idea.status === "failed" || idea.status === "skipped" ? "failure" : "idea"
        return {
            nodeId: `idea:${idea.id}`,
            rawId: idea.id,
            refs: [],
            timestamp: event.timestamp,
            firstTimestamp: event.timestamp,
            lastTimestamp: event.timestamp,
            solverId: event.solverId,
            solverIds: event.solverId ? [event.solverId] : [],
            badge: idea.status,
            title: idea.content,
            summary:
                idea.status === "verified"
                    ? "已验证路线"
                    : idea.status === "failed"
                      ? "被拒绝路线"
                      : idea.status === "skipped"
                        ? "已跳过路线"
                        : idea.status === "testing"
                          ? "测试中路线"
                          : "提出路线",
            detail: idea.result,
            className:
                idea.status === "verified"
                    ? "border-emerald-400 bg-emerald-50 text-emerald-950"
                    : lane === "failure"
                      ? "border-red-400 bg-red-50 text-red-950"
                      : idea.status === "testing"
                        ? "border-amber-400 bg-amber-50 text-amber-950"
                        : "border-blue-400 bg-blue-50 text-blue-950",
            lane,
            entity: "idea",
            status: idea.status,
            statusTrail: [idea.status],
            updateCount: 1,
        }
    }

    return
}

function knowledgeEdgeStyle(item: KnowledgeTreeItem) {
    if (item.lane === "failure") return { stroke: "#ef4444" }
    if (item.lane === "idea") return { stroke: "#2563eb" }
    if (item.lane === "hint") return { stroke: "#9333ea" }
    if (item.lane === "flag") return { stroke: "#16a34a" }
    return { stroke: "#16a34a" }
}

function boardRelationshipLabel(from: KnowledgeTreeItem, to: KnowledgeTreeItem) {
    if (to.refs.includes(from.rawId)) {
        if (to.entity === "memory" && from.entity === "idea") return "提炼"
        if (to.entity === "memory" && from.entity === "memory") return "细化"
        return "引用"
    }
    if (to.entity === "idea") return "分支 idea"
    if (to.entity === "memory") return "存储 memory"
    return "看板"
}

function eventNodeId(item: KnowledgeTreeItem) {
    return `knowledge:${item.nodeId}`
}

function itemMeta(item: KnowledgeTreeItem) {
    const meta = [item.rawId]
    if (item.statusTrail.length > 1) meta.push(item.statusTrail.join(" -> "))
    else if (item.status) meta.push(item.status)
    if (item.updateCount > 1) meta.push(`${item.updateCount} 次更新`)
    if (item.solverIds.length > 0) meta.push(item.solverIds.slice(0, 2).join(", "))
    return meta
}

function knowledgeFocusNodeId(event?: AttackTimelineEvent) {
    if (!event) return
    const memory = memoryFromEvent(event)
    if (memory) return `knowledge:memory:${memory.id}`
    const idea = ideaFromEvent(event)
    if (idea && (idea.status === "pending" || idea.status === "testing")) return `knowledge:idea:${idea.id}`
    if (event.kind === "memory_added" || event.kind === "memory_updated") return "knowledge:memory-root"
    if (event.kind === "idea_added" || event.kind === "idea_updated") return "knowledge:ideas-root"
    return
}

function knowledgeGroupForItem(item: KnowledgeTreeItem): KnowledgeGroup {
    if (item.entity === "idea") return "idea-active"
    if (item.status === "failure") return "memory-failure"
    if (item.status === "evidence") return "memory-evidence"
    if (item.status === "hint") return "memory-hint"
    if (item.status === "note") return "memory-note"
    return "memory-fact"
}

function buildKnowledgeGraphFromBoard(
    memoryItems: MemoryEntry[],
    ideaItems: IdeaRecord[],
    events: AttackTimelineEvent[],
    currentTimestamp: number | undefined,
    challenge?: ChallengeInfoRecord,
): FlowGraph {
    if (currentTimestamp === undefined) return buildKnowledgeGraphFromItems([], challenge)
    const replayTimestamp = currentTimestamp

    const ideaEventsById = new Map<string, KnowledgeTreeItem[]>()
    const memoryEventsById = new Map<string, KnowledgeTreeItem[]>()
    for (const event of events) {
        if (event.timestamp > replayTimestamp) continue
        const item = boardMutationEventItem(event)
        if (!item) continue
        const target = item.entity === "idea" ? ideaEventsById : item.entity === "memory" ? memoryEventsById : undefined
        if (!target) continue
        const list = target.get(item.rawId) ?? []
        list.push(item)
        target.set(item.rawId, list)
    }

    function historyFor(id: string, status: string, source: Map<string, KnowledgeTreeItem[]>) {
        const history = (source.get(id) ?? []).sort((left, right) => left.timestamp - right.timestamp)
        const statusTrail = history.reduce<string[]>((trail, item) => {
            if (!item.status) return trail
            if (trail.at(-1) !== item.status) trail.push(item.status)
            return trail
        }, [])
        return {
            statusTrail: statusTrail.length > 0 ? statusTrail : [status],
            updateCount: Math.max(1, history.length),
            solverIds: [...new Set(history.flatMap((item) => item.solverIds))],
            firstTimestamp: history[0]?.timestamp,
        }
    }

    function latestIdeaAtTime(idea: IdeaRecord): IdeaRecord | undefined {
        if (Date.parse(idea.created_at) > replayTimestamp) return
        const history = (ideaEventsById.get(idea.id) ?? []).sort((left, right) => left.timestamp - right.timestamp)
        const latestEvent = history.at(-1)
        if (!latestEvent) return idea
        return {
            ...idea,
            status: (latestEvent.status as IdeaRecord["status"] | undefined) ?? idea.status,
            content: latestEvent.title || idea.content,
            result: latestEvent.detail ?? idea.result,
            updated_at: new Date(latestEvent.lastTimestamp).toISOString(),
        }
    }

    function latestMemoryAtTime(memory: MemoryEntry): MemoryEntry | undefined {
        if (Date.parse(memory.created_at) > replayTimestamp) return
        const history = (memoryEventsById.get(memory.id) ?? []).sort((left, right) => left.timestamp - right.timestamp)
        const latestEvent = history.at(-1)
        if (!latestEvent) return memory
        return {
            ...memory,
            kind: (latestEvent.status as MemoryEntry["kind"] | undefined) ?? memory.kind,
            content: latestEvent.title || memory.content,
            source: latestEvent.detail ?? memory.source,
            refs: latestEvent.refs.length > 0 ? latestEvent.refs : memory.refs,
            updated_at: new Date(latestEvent.lastTimestamp).toISOString(),
        }
    }

    const ideaNodes: KnowledgeTreeItem[] = ideaItems
        .map(latestIdeaAtTime)
        .filter((idea): idea is IdeaRecord => Boolean(idea))
        .filter((idea) => idea.status === "pending" || idea.status === "testing")
        .map((idea) => {
            const history = historyFor(idea.id, idea.status, ideaEventsById)
            const timestamp = Date.parse(idea.created_at)
            return {
                nodeId: `idea:${idea.id}`,
                rawId: idea.id,
                refs: [],
                timestamp: history.firstTimestamp ?? (Number.isFinite(timestamp) ? timestamp : 0),
                firstTimestamp: history.firstTimestamp ?? (Number.isFinite(timestamp) ? timestamp : 0),
                lastTimestamp: Date.parse(idea.updated_at) || history.firstTimestamp || timestamp || 0,
                solverIds: history.solverIds,
                badge: idea.status,
                title: idea.content,
                summary: idea.content,
                detail: idea.result,
                className:
                    idea.status === "testing"
                        ? "border-dashed border-amber-400 bg-amber-50/60 text-amber-950"
                        : "border-dashed border-blue-400 bg-blue-50/60 text-blue-950",
                lane: "idea",
                entity: "idea",
                status: idea.status,
                statusTrail: history.statusTrail,
                updateCount: history.updateCount,
            }
        })

    const memoryNodes: KnowledgeTreeItem[] = memoryItems.map(latestMemoryAtTime).filter((memory): memory is MemoryEntry => Boolean(memory)).map((memory) => {
        const history = historyFor(memory.id, memory.kind, memoryEventsById)
        const timestamp = Date.parse(memory.created_at)
        const lane = memory.kind === "failure" ? "failure" : memory.kind === "hint" ? "hint" : "fact"
        return {
            nodeId: `memory:${memory.id}`,
            rawId: memory.id,
            refs: memory.refs,
            timestamp: history.firstTimestamp ?? (Number.isFinite(timestamp) ? timestamp : 0),
            firstTimestamp: history.firstTimestamp ?? (Number.isFinite(timestamp) ? timestamp : 0),
            lastTimestamp: Date.parse(memory.updated_at) || history.firstTimestamp || timestamp || 0,
            solverIds: history.solverIds,
            badge: memory.kind,
            title: memory.content,
            summary: memoryKindLabel(memory.kind),
            detail: memory.source,
            className:
                lane === "failure"
                    ? "border-red-400 bg-red-50 text-red-950"
                    : lane === "hint"
                      ? "border-violet-400 bg-violet-50 text-violet-950"
                      : "border-emerald-400 bg-emerald-50 text-emerald-950",
            lane,
            entity: "memory",
            status: memory.kind,
            statusTrail: history.statusTrail,
            updateCount: history.updateCount,
        }
    })

    return buildKnowledgeGraphFromItems([...ideaNodes, ...memoryNodes], challenge)
}

function buildKnowledgeGraphFromItems(items: KnowledgeTreeItem[], challenge?: ChallengeInfoRecord): FlowGraph {
    const sorted = [...items].sort((left, right) => left.firstTimestamp - right.firstTimestamp || left.rawId.localeCompare(right.rawId))
    const itemMap = new Map(sorted.map((item) => [item.rawId, item]))
    const referencedIdeaIds = new Set(sorted.filter((item) => item.entity === "memory").flatMap((item) => item.refs).filter((ref) => itemMap.get(ref)?.entity === "idea"))
    const taskTitle = challengeNodeTitle(challenge)
    const taskSummary = challengeNodeSummary(challenge, "目标任务上下文")
    const nodes: FlowNode[] = [
        {
            id: "knowledge:task-core",
            position: { x: 0, y: 0 },
            width: CHALLENGE_NODE_WIDTH,
            height: CHALLENGE_NODE_HEIGHT,
            data: {
                label: nodeLabel(taskTitle, "goal", taskSummary),
                graphRole: "task",
                knowledgeGroup: "task",
            },
            className: "rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-950 shadow-[0_8px_24px_rgba(15,23,42,0.12)]",
        },
    ]
    const edges: Edge[] = []
    const layoutEdges: Edge[] = []

    for (const item of sorted) {
        const nodeId = eventNodeId(item)
        const knowledgeGroup = knowledgeGroupForItem(item)
        nodes.push({
            id: nodeId,
            position: { x: 0, y: 0 },
            data: {
                label: knowledgeNodeLabel(
                    item.entity === "idea" ? "IDEA" : "MEMORY",
                    item.status ?? item.badge,
                    item.entity === "idea" ? item.title : item.summary,
                    item.entity === "idea" ? (item.detail ?? "") : item.detail ? `${item.title}\n${item.detail}` : item.title,
                    itemMeta(item),
                ),
                graphRole: item.entity === "idea" ? "idea" : "memory",
                knowledgeGroup,
                rawId: item.rawId,
            },
            className: cn("rounded-lg border px-3 py-2 shadow-[0_8px_20px_rgba(15,23,42,0.08)]", item.className),
        })
        layoutEdges.push({
            id: `layout:knowledge:task-core->${nodeId}`,
            source: "knowledge:task-core",
            target: nodeId,
        })
        edges.push({
            id: `knowledge:task-core->${nodeId}`,
            source: "knowledge:task-core",
            target: nodeId,
            label: "",
            style: { stroke: item.entity === "idea" ? "#2563eb" : "#94a3b8", strokeWidth: item.entity === "idea" ? 1.8 : 1.2, strokeDasharray: item.entity === "idea" ? "6 5" : "4 6" },
        })

        const parents = item.refs.map((ref) => itemMap.get(ref)).filter((parent): parent is KnowledgeTreeItem => Boolean(parent))
        if (parents.length === 0) {
            continue
        }

        for (const parent of parents) {
            edges.push({
                id: `${parent.nodeId}->${item.nodeId}`,
                source: eventNodeId(parent),
                target: nodeId,
                label: boardRelationshipLabel(parent, item),
                style: { ...knowledgeEdgeStyle(item), strokeWidth: 2.2 },
            })
            layoutEdges.push({
                id: `layout:${parent.nodeId}->${item.nodeId}`,
                source: eventNodeId(parent),
                target: nodeId,
            })
        }
    }

    return { nodes, edges, layoutEdges }
}

function solverIdsFromEvents(events: AttackTimelineEvent[]): string[] {
    return solverMetasFromEvents(events).map((meta) => meta.id)
}

function buildCommunicationGraph(
    challengeId: string,
    events: AttackTimelineEvent[],
    currentEvent?: AttackTimelineEvent,
    challenge?: ChallengeInfoRecord,
    selectedSolverId?: string,
): { nodes: FlowNode[]; edges: Edge[] } {
    const item = currentEvent ? communicationFlowItemFromEvent(currentEvent) : undefined
    const nodes: FlowNode[] = []
    const edges: Edge[] = []

    function addNode(id: string, title: string, badge: string, summary: string, className: string, solverId?: string) {
        const widthScore = title.length * 4 + summary.length * 1.35
        const adaptiveWidth = id === "topology:task" ? CHALLENGE_NODE_WIDTH : Math.max(240, Math.min(520, Math.round(widthScore)))
        const summaryLines = summary ? Math.min(3, Math.max(1, Math.ceil(summary.length / 68))) : 0
        const adaptiveHeight = id === "topology:task" ? CHALLENGE_NODE_HEIGHT : 76 + summaryLines * 16
        nodes.push({
            id,
            position: { x: 0, y: 0 },
            width: adaptiveWidth,
            height: adaptiveHeight,
            data: { label: nodeLabel(title, badge, summary), solverId },
            className: cn(
                "rounded-xl border px-3 py-2 shadow-[0_8px_20px_rgba(15,23,42,0.08)] transition-all",
                className,
                solverId && solverId === selectedSolverId ? "ring-2 ring-sky-400/70 shadow-[0_0_0_4px_rgba(56,189,248,0.14)]" : "",
            ),
        })
    }

    function addEdge(id: string, source: string, target: string, label = "", stroke = "#94a3b8", active = false, dashed = false, direction: "forward" | "reverse" = "forward") {
        edges.push({
            id,
            source,
            target,
            label,
            animated: false,
            type: "event-flow",
            data: { particleColor: stroke, active, direction },
            labelStyle: { fontSize: 10, fill: "#334155", fontWeight: 600 },
            style: { stroke, strokeWidth: active ? 2.2 : 1.3, strokeOpacity: active ? 0.95 : 0.55, strokeDasharray: dashed ? "6 5" : undefined },
        })
    }

    const taskTitle = challengeNodeTitle(challenge)
    const taskSummary = challengeNodeSummary(challenge, challengeId)
    addNode("topology:task", taskTitle, "goal", taskSummary, "border-slate-300 bg-white text-slate-950")

    const solverMetas = solverMetasFromEvents(events)
    for (const meta of solverMetas) {
        const solverNodeId = `topology:solver:${meta.id}`
        const runtimeSummary = `runtime ${formatCompactDuration(meta.firstSeen, meta.lastSeen)} · ${meta.eventCount} events`
        addNode(
            solverNodeId,
            meta.promptName ?? "Solver",
            "solver",
            runtimeSummary,
            "border-slate-200 bg-white text-slate-900 hover:border-sky-300",
            meta.id,
        )
        addEdge(`base:${meta.id}`, "topology:task", solverNodeId, "", "#94a3b8", false, true)
    }

    if (!item || !currentEvent) return { nodes, edges }

    const solverNodeId = currentEvent.solverId ? `topology:solver:${currentEvent.solverId}` : undefined

    function activateEdges(ids: string[], label: string, color: string, direction: "forward" | "reverse") {
        ids.forEach((id, index) => {
            const edge = edges.find((item) => item.id === id)
            if (!edge) return
            edge.label = index === 0 ? label : ""
            edge.style = { ...(edge.style ?? {}), stroke: color, strokeWidth: 2.2, strokeOpacity: 0.95 }
            edge.data = { ...(edge.data ?? {}), particleColor: color, active: true, direction }
        })
    }

    if (item.badge === "broadcast") {
        activateEdges(solverMetas.map((meta) => `base:${meta.id}`), flowEventLabel(item), "#9333ea", "forward")
        return { nodes, edges }
    }

    if (item.edgeLabel === "upload") {
        if (!solverNodeId) return { nodes, edges }
        const stroke = item.badge === "idea" ? "#f59e0b" : "#16a34a"
        activateEdges([`base:${currentEvent.solverId}`], flowEventLabel(item), stroke, "reverse")
        return { nodes, edges }
    }

    if (item.badge === "spawn") {
        if (!solverNodeId) return { nodes, edges }
        activateEdges([`base:${currentEvent.solverId}`], flowEventLabel(item), "#10b981", "forward")
        return { nodes, edges }
    }

    if (item.badge === "flag" || item.badge === "result") {
        if (!solverNodeId) return { nodes, edges }
        activateEdges([`base:${currentEvent.solverId}`], flowEventLabel(item), "#f97316", "reverse")
        return { nodes, edges }
    }

    if (item.badge === "observe") {
        if (!solverNodeId) return { nodes, edges }
        activateEdges([`base:${currentEvent.solverId}`], flowEventLabel(item), "#9333ea", "forward")
        return { nodes, edges }
    }

    if (!solverNodeId) return { nodes, edges }
    activateEdges([`base:${currentEvent.solverId}`], flowEventLabel(item), "#2563eb", "reverse")

    return { nodes, edges }
}

function FitViewOnGraphChange(props: { version: number }) {
    const { version } = props
    const { fitView } = useReactFlow()

    useEffect(() => {
        const frame = window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                void fitView({ padding: 0.12, duration: 120 })
            })
        })
        return () => window.cancelAnimationFrame(frame)
    }, [fitView, version])

    return null
}

function FocusFlowNode(props: { nodeId?: string; version: number }) {
    const { nodeId, version } = props
    const { getNode, setCenter } = useReactFlow()

    useEffect(() => {
        if (!nodeId) return
        const frame = window.requestAnimationFrame(() => {
            const node = getNode(nodeId)
            if (!node) return
            const width = node.width ?? 220
            const height = node.height ?? 96
            const centerX = node.position.x + width / 2
            const centerY = node.position.y + height / 2
            void setCenter(centerX, centerY, { duration: 180, zoom: 1.03 })
        })
        return () => window.cancelAnimationFrame(frame)
    }, [getNode, nodeId, setCenter, version])

    return null
}

function FlowCanvas(props: {
    nodes: FlowNode[]
    edges: Edge[]
    layoutEdges?: Edge[]
    layoutMode?: FlowLayoutMode
    empty: string
    suspended?: boolean
    direction?: ElkDirection
    nodeWidth?: number
    nodeHeight?: number
    spacing?: number
    layerSpacing?: number
    onNodeClick?: NodeMouseHandler<FlowNode>
    focusNodeId?: string
}) {
    const { nodes, edges, layoutEdges, layoutMode = "elk", empty, suspended = false, direction = "DOWN", nodeWidth = 260, nodeHeight = 112, spacing = 72, layerSpacing = 112, onNodeClick, focusNodeId } = props
    const [layouted, setLayouted] = useState<{ nodes: FlowNode[]; edges: Edge[] }>({ nodes, edges })
    const [layoutVersion, setLayoutVersion] = useState(0)

    useEffect(() => {
        if (suspended) return
        if (layoutMode === "mindmap") {
            const visibleNodes = nodes.filter((node) => !node.hidden)
            const taskNode = visibleNodes.find((node) => node.data.graphRole === "task") ?? visibleNodes[0]
            const children = visibleNodes.filter((node) => node.id !== taskNode?.id)
            const groups: Record<KnowledgeGroup, FlowNode[]> = {
                task: [],
                "memory-failure": [],
                "memory-evidence": [],
                "memory-fact": [],
                "memory-hint": [],
                "memory-note": [],
                "idea-active": [],
            }
            for (const node of children) {
                groups[node.data.knowledgeGroup ?? "memory-fact"].push(node)
            }

            function placeColumn(items: FlowNode[], x: number, yCenter: number, side: "left" | "right") {
                const yStep = Math.max(190, nodeHeight + 84)
                return items.map((node, index) => {
                    const y = yCenter + (index - (items.length - 1) / 2) * yStep
                    return {
                    ...node,
                        position: { x, y },
                        sourcePosition: side === "right" ? Position.Right : Position.Left,
                        targetPosition: side === "right" ? Position.Left : Position.Right,
                    }
                })
            }

            const positioned = new Map<string, FlowNode>()
            if (taskNode) {
                positioned.set(taskNode.id, {
                    ...taskNode,
                    position: { x: 0, y: 0 },
                    sourcePosition: Position.Right,
                    targetPosition: Position.Left,
                })
            }
            for (const node of placeColumn(groups["memory-failure"], -540, -130, "left")) positioned.set(node.id, node)
            for (const node of placeColumn(groups["memory-hint"].concat(groups["memory-note"]), -540, 220, "left")) positioned.set(node.id, node)
            for (const node of placeColumn(groups["memory-evidence"], 540, -180, "right")) positioned.set(node.id, node)
            for (const node of placeColumn(groups["memory-fact"], 540, 180, "right")) positioned.set(node.id, node)
            for (const node of placeColumn(groups["idea-active"], 820, 0, "right")) positioned.set(node.id, node)

            setLayouted({
                nodes: nodes.map((node) => positioned.get(node.id) ?? { ...node, position: { x: 0, y: 0 } }),
                edges,
            })
            setLayoutVersion((current) => current + 1)
            return
        }
        let active = true
        void layoutFlowElements(nodes, layoutEdges ?? edges, { direction, nodeWidth, nodeHeight, spacing, layerSpacing }).then((next) => {
            if (!active) return
            const positioned = new Map(next.nodes.map((node) => [node.id, node]))
            setLayouted({
                nodes: nodes.map((node) => {
                    const placed = positioned.get(node.id)
                    if (!placed) return node
                    return { ...node, position: placed.position, sourcePosition: placed.sourcePosition, targetPosition: placed.targetPosition }
                }),
                edges,
            })
            setLayoutVersion((current) => current + 1)
        })
        return () => {
            active = false
        }
    }, [direction, edges, layoutEdges, layerSpacing, layoutMode, nodeHeight, nodeWidth, nodes, spacing, suspended])

    if (suspended) return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">松开以重绘图表</div>
    if (nodes.length === 0) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{empty}</div>
    return (
        <ReactFlow
            nodes={layouted.nodes}
            edges={layouted.edges}
            edgeTypes={EDGE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            className="bg-[radial-gradient(circle_at_12%_12%,rgba(148,163,184,0.10),transparent_42%),radial-gradient(circle_at_88%_18%,rgba(56,189,248,0.10),transparent_40%),#f8fafc]"
            defaultEdgeOptions={{
                type: "bezier",
                markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "#64748b" },
                style: { strokeWidth: 1.8, stroke: "#64748b" },
            }}
            nodesDraggable={false}
            nodesConnectable={false}
            minZoom={0.2}
            maxZoom={1.5}
            panOnScroll
            zoomOnScroll={false}
            onNodeClick={onNodeClick}
            proOptions={{ hideAttribution: true }}
        >
            {focusNodeId ? <FocusFlowNode nodeId={focusNodeId} version={layoutVersion} /> : <FitViewOnGraphChange version={layoutVersion} />}
            <Controls position="bottom-right" showInteractive={false} className="rounded-md border border-slate-200 bg-white/95 shadow-sm" />
            <Background color="rgba(100, 116, 139, 0.18)" gap={24} />
        </ReactFlow>
    )
}

function AttackRuntimeMessageList(props: { thread: RuntimeThreadView; subagentThreadsByToolCallId?: Record<string, RuntimeThreadView[]> }) {
    const { thread, subagentThreadsByToolCallId } = props
    const ref = useRef<RuntimeOfficialMessageListElement | null>(null)
    const [elementReady, setElementReady] = useState(false)

    useEffect(() => {
        let active = true
        void import("../runtime/official/message-list-element").then(() => {
            if (active) setElementReady(true)
        })
        return () => {
            active = false
        }
    }, [])

    useEffect(() => {
        if (!elementReady) return
        if (!ref.current) return
        ref.current.messages = thread.messages
        ref.current.tools = []
        ref.current.pendingToolCalls = undefined
        ref.current.isStreaming = false
        ref.current.subagentThreadsByToolCallId = subagentThreadsByToolCallId
    }, [elementReady, subagentThreadsByToolCallId, thread.messages])

    return createElement("runtime-official-message-list", { ref, className: "runtime-official-message-list-host" })
}

function getUserMessageText(message: Record<string, unknown>) {
    if (message.role !== "user") return ""
    const content = message.content
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    return content
        .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part) && typeof part === "object")
        .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
}

function trimThreadTaskMessage(thread: RuntimeThreadView) {
    if (!thread.task) return thread
    const task = thread.task.trim()
    const firstIndex = thread.messages.findIndex((message) => {
        const text = getUserMessageText(message)
        return text && text.trim() === task
    })
    if (firstIndex < 0) return thread
    return {
        ...thread,
        messages: thread.messages.filter((_, index) => index !== firstIndex),
    }
}

function threadAnchorTime(thread: RuntimeThreadView): number | undefined {
    if (typeof thread.createdAt === "number") return thread.createdAt
    return thread.messages.find((message) => typeof message.timestamp === "number")?.timestamp as number | undefined
}

function messagesUntil(thread: RuntimeThreadView, timestamp?: number) {
    if (timestamp === undefined) return []
    return thread.messages.filter((message) => typeof message.timestamp === "number" && message.timestamp <= timestamp)
}

function buildRuntimeTimeline(details: RuntimeDetailsView | null, timestamp?: number) {
    const mainThread = details?.threads.find((thread) => thread.kind === "main")
    const mainVisibleThread = mainThread
        ? trimThreadTaskMessage({
              ...mainThread,
              messages: messagesUntil(mainThread, timestamp),
          })
        : undefined
    const visibleMainThread = mainVisibleThread && mainVisibleThread.messages.length > 0 ? mainVisibleThread : undefined
    const visibleSubagentThreads = (details?.threads ?? [])
        .filter((thread) => thread.kind === "subagent")
        .map((thread) =>
            trimThreadTaskMessage({
                ...thread,
                messages: messagesUntil(thread, timestamp),
            }),
        )
        .filter((thread) => thread.messages.length > 0)
        .sort((left, right) => (threadAnchorTime(left) ?? Number.MAX_SAFE_INTEGER) - (threadAnchorTime(right) ?? Number.MAX_SAFE_INTEGER))
    const visibleObserverThreads = (details?.threads ?? [])
        .filter((thread) => thread.kind === "observer")
        .map((thread) => ({
            ...thread,
            messages: messagesUntil(thread, timestamp),
        }))
        .filter((thread) => thread.messages.length > 0)
        .sort((left, right) => (threadAnchorTime(left) ?? Number.MAX_SAFE_INTEGER) - (threadAnchorTime(right) ?? Number.MAX_SAFE_INTEGER))
    const subagentThreadsByToolCallId: Record<string, RuntimeThreadView[]> = {}

    for (const thread of visibleSubagentThreads) {
        if (!thread.parentToolCallId) continue
        if (!subagentThreadsByToolCallId[thread.parentToolCallId]) subagentThreadsByToolCallId[thread.parentToolCallId] = []
        subagentThreadsByToolCallId[thread.parentToolCallId].push(thread)
    }
    for (const key of Object.keys(subagentThreadsByToolCallId)) {
        subagentThreadsByToolCallId[key].sort((left, right) => (threadAnchorTime(left) ?? Number.MAX_SAFE_INTEGER) - (threadAnchorTime(right) ?? Number.MAX_SAFE_INTEGER))
    }

    const blocks: Array<{ type: "main"; thread: RuntimeThreadView } | { type: "observer"; thread: RuntimeThreadView }> = []
    const mainMessages = visibleMainThread?.messages ?? []
    let cursor = 0

    for (const observerThread of visibleObserverThreads) {
        const observerTime = threadAnchorTime(observerThread) ?? Number.MAX_SAFE_INTEGER
        let splitIndex = cursor
        while (splitIndex < mainMessages.length) {
            const messageTimestamp = typeof mainMessages[splitIndex]?.timestamp === "number" ? (mainMessages[splitIndex].timestamp as number) : Number.MAX_SAFE_INTEGER
            if (messageTimestamp > observerTime) break
            splitIndex += 1
        }

        const segmentMessages = mainMessages.slice(cursor, splitIndex)
        if (segmentMessages.length > 0 && visibleMainThread) {
            blocks.push({
                type: "main",
                thread: { ...visibleMainThread, id: `${visibleMainThread.id}:segment:${blocks.length}`, messages: segmentMessages },
            })
        }
        blocks.push({ type: "observer", thread: observerThread })
        cursor = splitIndex
    }

    const trailingMessages = mainMessages.slice(cursor)
    if (trailingMessages.length > 0 && visibleMainThread) {
        blocks.push({
            type: "main",
            thread: { ...visibleMainThread, id: `${visibleMainThread.id}:segment:${blocks.length}`, messages: trailingMessages },
        })
    }

    return { blocks, subagentThreadsByToolCallId }
}

function ObserverMarkerBlock(props: { thread: RuntimeThreadView }) {
    const { thread } = props
    return (
        <section className="min-w-0">
            <div className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left">
                <div className="h-px flex-1 bg-border" />
                <div className="shrink-0 text-xs font-medium text-muted-foreground">
                    {thread.label}
                    {thread.createdAt ? ` · ${formatTimelineTime(thread.createdAt)}` : ""}
                </div>
                <div className="h-px flex-1 bg-border" />
            </div>
        </section>
    )
}

function SolverRuntimeTimeline(props: { solverId: string; timestamp?: number }) {
    const { solverId, timestamp } = props
    const [details, setDetails] = useState<RuntimeDetailsView | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState("")
    const [challengeInfo, setChallengeInfo] = useState<ChallengeInfoRecord | undefined>()

    useEffect(() => {
        let active = true
        setLoading(true)
        setError("")
        void runtime
            .get(solverId)
            .then((next) => {
                if (active) setDetails(next as unknown as RuntimeDetailsView)
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
    }, [solverId])

    const timeline = useMemo(() => buildRuntimeTimeline(details, timestamp), [details, timestamp])

    if (loading && !details) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">加载运行时时间线…</div>
    if (error) return <div className="rounded-lg border p-3 text-sm text-red-500">{error}</div>
    if (timeline.blocks.length === 0) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">当前时刻无运行时消息。</div>

    return (
        <div className="runtime-detail-content h-full overflow-y-auto overflow-x-hidden px-2 py-3">
            <div className="space-y-4">
                {timeline.blocks.map((block) =>
                    block.type === "main" ? (
                        <section key={block.thread.id} className="min-w-0 overflow-x-hidden">
                            <AttackRuntimeMessageList thread={block.thread} subagentThreadsByToolCallId={timeline.subagentThreadsByToolCallId} />
                        </section>
                    ) : (
                        <ObserverMarkerBlock key={block.thread.id} thread={block.thread} />
                    ),
                )}
            </div>
        </div>
    )
}

function keyTimelineEvents(events: AttackTimelineEvent[]) {
    return events
        .filter((event) => {
            if (event.kind === "message" || event.kind === "tool_call") return false
            if (event.kind === "tool_result" && !event.title.startsWith("challenge_submit_flag")) return false
            if ((event.kind === "memory_updated" || event.kind === "idea_updated") && event.summary.trim().startsWith("|")) return false
            if ((event.kind === "memory_updated" || event.kind === "idea_updated") && event.summary.length < 24) return false
            if ((event.kind === "memory_added" || event.kind === "memory_updated" || event.kind === "idea_added" || event.kind === "idea_updated") && event.summary.startsWith("Validation failed for tool")) return false
            if ((event.kind === "memory_updated" || event.kind === "idea_updated") && /^(memory|idea) ".+" not found/.test(event.summary)) return false
            return true
        })
}

function timelineAccent(event: AttackTimelineEvent) {
    if (event.kind === "flag_submitted") return "border-orange-200 bg-orange-50 text-orange-950"
    if (event.kind === "memory_added" || event.kind === "memory_updated") return "border-blue-200 bg-blue-50 text-blue-950"
    if (event.kind === "idea_added" || event.kind === "idea_updated") return "border-amber-200 bg-amber-50 text-amber-950"
    if (event.lane === "observer" || event.kind === "observer_reminder") return "border-purple-200 bg-purple-50 text-purple-950"
    if (event.kind === "solver_started" || event.kind === "solver_ended") return "border-emerald-200 bg-emerald-50 text-emerald-950"
    return "border-slate-200 bg-slate-50 text-slate-950"
}

function timelineDot(event: AttackTimelineEvent) {
    if (event.kind === "flag_submitted") return "bg-orange-500"
    if (event.kind === "memory_added" || event.kind === "memory_updated") return "bg-blue-500"
    if (event.kind === "idea_added" || event.kind === "idea_updated") return "bg-amber-500"
    if (event.lane === "observer" || event.kind === "observer_reminder") return "bg-purple-500"
    if (event.kind === "solver_started" || event.kind === "solver_ended") return "bg-emerald-500"
    return "bg-slate-400"
}

function timelineLaneId(event: AttackTimelineEvent) {
    return event.solverId ?? "hub"
}

function isBroadcastEvent(event: AttackTimelineEvent) {
    return !event.solverId && event.kind === "observer_reminder"
}

function shortTime(value: number) {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function isBoardUpdateEvent(event: AttackTimelineEvent) {
    return event.kind === "memory_added" || event.kind === "memory_updated" || event.kind === "idea_added" || event.kind === "idea_updated"
}

function boardUpdateBadge(event: AttackTimelineEvent) {
    if (event.kind === "memory_added" || event.kind === "memory_updated") return "memory"
    if (event.kind === "idea_added" || event.kind === "idea_updated") return "idea"
    return ""
}

function flowEventLabel(item: CommunicationFlowItem) {
    if (item.badge === "broadcast") return clip(item.summary, 46)
    if (item.badge === "observe") return clip(item.summary, 42)
    if (item.badge === "memory" || item.badge === "idea") return clip(item.summary, 42)
    if (item.badge === "flag" || item.badge === "result") return clip(item.summary, 36)
    if (item.badge === "spawn") return clip(item.summary, 32)
    return clip(item.summary, 40)
}

function TimelinePanel(props: { events: AttackTimelineEvent[]; selectedSolverId?: string; onSelectSolver: (solverId: string) => void; onSelectEvent: (event: AttackTimelineEvent) => void; activeEventId?: string; autoFollow: boolean }) {
    const { events, selectedSolverId, onSelectSolver, onSelectEvent, activeEventId, autoFollow } = props
    const items = keyTimelineEvents(events)
    const solverMetas = solverMetasFromEvents(events)
    const showHubLane = items.some((event) => timelineLaneId(event) === "hub")
    const hubLanes: Array<{ id: string; label: string; description?: string; className: string }> = showHubLane ? [{ id: "hub", label: "中枢", className: "border-violet-300 bg-violet-50 text-violet-950" }] : []
    const lanes: Array<{ id: string; label: string; description?: string; className: string }> = hubLanes.concat(
        solverMetas.map((meta, index) => {
            const styles = [
                "border-blue-300 bg-blue-50 text-blue-950",
                "border-emerald-300 bg-emerald-50 text-emerald-950",
                "border-amber-300 bg-amber-50 text-amber-950",
                "border-rose-300 bg-rose-50 text-rose-950",
                "border-purple-300 bg-purple-50 text-purple-950",
            ]
            return { id: meta.id, label: meta.promptName ?? meta.id, description: meta.id, className: styles[index % styles.length] ?? styles[0] }
        }),
    )
    const gridTemplateColumns = `${TIMELINE_TIME_COLUMN_WIDTH}px repeat(${lanes.length}, ${TIMELINE_LANE_WIDTH}px)`
    const timelineWidth = TIMELINE_TIME_COLUMN_WIDTH + lanes.length * TIMELINE_LANE_WIDTH + lanes.length * TIMELINE_COLUMN_GAP
    const laneStartOffset = TIMELINE_TIME_COLUMN_WIDTH + TIMELINE_COLUMN_GAP
    const scrollRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
        if (!autoFollow) return
        if (!activeEventId) return
        const container = scrollRef.current
        if (!container) return
        const target = container.querySelector<HTMLElement>(`[data-timeline-event-id="${activeEventId}"]`)
        if (!target) return
        target.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" })
    }, [activeEventId, autoFollow])

    if (items.length === 0) {
        return (
            <div className="h-full min-h-0 min-w-0 overflow-hidden border border-blue-100 bg-[radial-gradient(circle_at_12%_12%,rgba(148,163,184,0.10),transparent_42%),#f8fafc]">
                <div className="flex h-full min-h-0 items-center justify-center p-6 text-center">
                    <div className="max-w-[260px] rounded-lg border border-dashed border-slate-200 bg-white/70 px-4 py-3 text-xs leading-relaxed text-muted-foreground shadow-sm">
                        开始回放以填充时间线。
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="h-full min-h-0 min-w-0 overflow-hidden border border-blue-100 bg-gradient-to-br from-white to-blue-50/40">
            <div ref={scrollRef} className="h-full min-h-0 overflow-auto p-2">
                <div style={{ width: timelineWidth }}>
                    <div className="sticky top-0 z-10 grid gap-2 bg-gradient-to-br from-white to-blue-50/80 pb-2" style={{ gridTemplateColumns }}>
                        <div className="flex items-center gap-1 px-1 text-[10px] font-medium text-muted-foreground">
                            <RouteIcon className="size-3 shrink-0 text-blue-600" />
                            时间
                        </div>
                        {lanes.map((lane) => (
                            <button
                                type="button"
                                key={lane.id}
                                onClick={() => lane.id !== "hub" && onSelectSolver(lane.id)}
                                className={cn(
                                    "min-w-0 rounded-lg border px-1.5 py-1 text-left text-[10px] font-semibold shadow-sm transition hover:shadow-md",
                                    lane.className,
                                    lane.id === selectedSolverId ? "ring-2 ring-primary/40" : "",
                                    lane.id === "hub" ? "cursor-default" : "cursor-pointer",
                                )}
                            >
                                <div className="truncate">{lane.label}</div>
                                {"description" in lane ? <div className="mt-0.5 truncate text-[10px] font-normal opacity-70">{lane.description}</div> : null}
                            </button>
                        ))}
                    </div>
                    <div className="flex flex-col gap-1.5">
                        {items.map((event) => {
                            const eventLaneId = timelineLaneId(event)
                            return (
                                <div key={event.id} data-timeline-event-id={event.id} className="relative grid min-h-8 gap-2" style={{ gridTemplateColumns }}>
                                    {isBroadcastEvent(event) ? <div className="pointer-events-none absolute right-2 top-1/2 border-t border-dashed border-purple-400" style={{ left: laneStartOffset }} /> : null}
                                    <div className="flex items-start gap-1 px-1 pt-2 text-[10px] font-medium text-muted-foreground">
                                        <span className={cn("mt-1 size-2 rounded-full", timelineDot(event))} />
                                        {shortTime(event.timestamp)}
                                    </div>
                                    {lanes.map((lane) => (
                                        <div key={lane.id} className="relative min-w-0 border-l border-dashed border-border/70 pl-1">
                                            {lane.id === eventLaneId ? (
                                                <button
                                                    type="button"
                                                    onClick={() => (isBoardUpdateEvent(event) ? onSelectEvent(event) : event.solverId ? onSelectSolver(event.solverId) : onSelectEvent(event))}
                                                    className={cn(
                                                        "relative z-[1] flex w-full min-w-0 flex-col gap-0.5 rounded-md border px-1.5 py-1 text-left text-[10px] shadow-sm transition hover:shadow-md",
                                                        timelineAccent(event),
                                                        "cursor-pointer",
                                                    )}
                                                >
                                                    <div className="flex min-w-0 items-center justify-between gap-1">
                                                        <span className="truncate font-semibold">{event.title}</span>
                                                        {isBroadcastEvent(event) ? <Badge variant="outline">broadcast</Badge> : null}
                                                        {isBoardUpdateEvent(event) ? <Badge variant="outline">{boardUpdateBadge(event)}</Badge> : null}
                                                    </div>
                                                    <div className="truncate opacity-75">{clip(event.summary, 36)}</div>
                                                    <div className="flex min-w-0 flex-wrap gap-1 pt-0.5 empty:hidden">
                                                        {event.kind === "flag_submitted" || event.kind === "tool_result" ? <Badge variant="outline">{event.kind}</Badge> : null}
                                                    </div>
                                                </button>
                                            ) : null}
                                        </div>
                                    ))}
                                </div>
                            )
                        })}
                    </div>
                </div>
            </div>
        </div>
    )
}

function PanelResizeHandle(props: { onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void; onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void; onReset: () => void }) {
    const { onPointerDown, onKeyDown, onReset } = props
    return (
        <button
            type="button"
            aria-label="调整时间线与图表面板大小"
            title="拖拽调整面板宽度，双击重置"
            className="group hidden cursor-col-resize items-stretch justify-center px-1 outline-none xl:flex"
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
            onDoubleClick={onReset}
        >
            <span className="my-1 w-1 rounded-full bg-border transition-colors group-hover:bg-primary/40 group-focus-visible:bg-primary/50" />
        </button>
    )
}

function StackResizeHandle(props: { onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void; onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void; onReset: () => void }) {
    const { onPointerDown, onKeyDown, onReset } = props
    return (
        <button
            type="button"
            aria-label="调整知识图谱与拓扑面板大小"
            title="拖拽调整图表高度，双击重置"
            className="group hidden cursor-row-resize items-center justify-stretch py-1 outline-none xl:flex"
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
            onDoubleClick={onReset}
        >
            <span className="mx-1 h-1 flex-1 rounded-full bg-border transition-colors group-hover:bg-primary/40 group-focus-visible:bg-primary/50" />
        </button>
    )
}

function TimelineEventDetailDialog(props: { event?: AttackTimelineEvent; onOpenChange: (open: boolean) => void }) {
    const { event, onOpenChange } = props
    const memory = event ? memoryFromEvent(event) : undefined
    const idea = event ? ideaFromEvent(event) : undefined
    const hasStructuredDetail = Boolean(memory || idea)

    return (
        <Dialog open={Boolean(event)} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[82vh] max-w-2xl overflow-y-auto overflow-x-hidden">
                {event ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>{event.title}</DialogTitle>
                            <DialogDescription>
                                {event.kind} · {shortTime(event.timestamp)}{event.solverId ? ` · ${event.solverId}` : ""}
                            </DialogDescription>
                        </DialogHeader>
                        <div className="min-w-0 space-y-4 text-sm">
                            {!hasStructuredDetail ? (
                                <section className="space-y-1">
                                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">摘要</div>
                                    <div className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3">{event.summary || "无摘要。"}</div>
                                </section>
                            ) : null}
                            {memory ? (
                                <section className="space-y-1">
                                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">记忆</div>
                                    <div className="min-w-0 rounded-lg border bg-blue-50/60 p-3 text-blue-950">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Badge variant="outline">{memory.kind}</Badge>
                                            <span className="text-xs opacity-70">{memory.source}</span>
                                        </div>
                                        <div className="mt-3 whitespace-pre-wrap break-words text-base leading-relaxed">{memory.content}</div>
                                        {memory.refs.length > 0 ? <div className="mt-3 break-words text-xs opacity-70">refs: {memory.refs.join(", ")}</div> : null}
                                        <div className="mt-3 grid gap-1 text-xs opacity-70 sm:grid-cols-2">
                                            <div>创建：{memory.created_at}</div>
                                            <div>更新：{memory.updated_at}</div>
                                        </div>
                                    </div>
                                </section>
                            ) : null}
                            {idea ? (
                                <section className="space-y-1">
                                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">思路</div>
                                    <div className="min-w-0 rounded-lg border bg-amber-50/70 p-3 text-amber-950">
                                        <Badge variant="outline">{idea.status}</Badge>
                                        <div className="mt-3 whitespace-pre-wrap break-words text-base leading-relaxed">{idea.content}</div>
                                        {idea.result ? (
                                            <div className="mt-3 rounded-md border border-amber-200 bg-white/60 p-3">
                                                <div className="mb-1 text-xs font-medium uppercase tracking-wide opacity-70">结果</div>
                                                <div className="whitespace-pre-wrap break-words leading-relaxed">{idea.result}</div>
                                            </div>
                                        ) : null}
                                        <div className="mt-3 grid gap-1 text-xs opacity-70 sm:grid-cols-2">
                                            <div>创建：{idea.created_at}</div>
                                            <div>更新：{idea.updated_at}</div>
                                        </div>
                                    </div>
                                </section>
                            ) : null}
                        </div>
                    </>
                ) : null}
            </DialogContent>
        </Dialog>
    )
}

type KnowledgeDetail =
    | { kind: "task"; challenge?: ChallengeInfoRecord; memoryCount: number; ideaCount: number }
    | { kind: "memory"; item: MemoryEntry }
    | { kind: "idea"; item: IdeaRecord }

function KnowledgeDetailDialog(props: { detail?: KnowledgeDetail; onOpenChange: (open: boolean) => void }) {
    const { detail, onOpenChange } = props
    return (
        <Dialog open={Boolean(detail)} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[82vh] max-w-2xl overflow-y-auto overflow-x-hidden">
                {detail ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>
                                {detail.kind === "task" ? detail.challenge?.title ?? "任务" : detail.kind === "memory" ? "记忆" : "思路"}
                            </DialogTitle>
                            <DialogDescription>
                                {detail.kind === "task"
                                    ? `${detail.memoryCount} 条记忆 · ${detail.ideaCount} 条活跃思路`
                                    : detail.kind === "memory"
                                      ? `${detail.item.id} · ${detail.item.kind}`
                                      : `${detail.item.id} · ${detail.item.status}`}
                            </DialogDescription>
                        </DialogHeader>
                        {detail.kind === "task" ? (
                            <div className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 text-sm leading-relaxed">
                                {detail.challenge?.description || "无任务描述。"}
                            </div>
                        ) : detail.kind === "memory" ? (
                            <div className="space-y-3 text-sm">
                                <div className="flex flex-wrap gap-2">
                                    <Badge variant="outline">{detail.item.kind}</Badge>
                                    <Badge variant="outline">{detail.item.source}</Badge>
                                </div>
                                <div className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 leading-relaxed">{detail.item.content}</div>
                                {detail.item.refs.length > 0 ? <div className="break-words text-xs text-muted-foreground">refs: {detail.item.refs.join(", ")}</div> : null}
                                <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                                    <div>创建：{detail.item.created_at}</div>
                                    <div>更新：{detail.item.updated_at}</div>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-3 text-sm">
                                <Badge variant="outline">{detail.item.status}</Badge>
                                <div className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 leading-relaxed">{detail.item.content}</div>
                                {detail.item.result ? (
                                    <div className="rounded-lg border bg-amber-50/50 p-3">
                                        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">结果</div>
                                        <div className="whitespace-pre-wrap break-words leading-relaxed">{detail.item.result}</div>
                                    </div>
                                ) : null}
                                <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                                    <div>创建：{detail.item.created_at}</div>
                                    <div>更新：{detail.item.updated_at}</div>
                                </div>
                            </div>
                        )}
                    </>
                ) : null}
            </DialogContent>
        </Dialog>
    )
}

export function AttackFlow({ challengeId }: AttackFlowProps) {
    const [snapshot, setSnapshot] = useState<AttackTimelineSnapshot | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState("")
    const [challengeInfo, setChallengeInfo] = useState<ChallengeInfoRecord | undefined>()
    const [boardMemory, setBoardMemory] = useState<MemoryEntry[]>([])
    const [boardIdeas, setBoardIdeas] = useState<IdeaRecord[]>([])
    const [cursorIndex, setCursorIndex] = useState(0)
    const [isPlaying, setIsPlaying] = useState(false)
    const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>("1")
    const [selectedSolverId, setSelectedSolverId] = useState<string | undefined>()
    const [selectedEvent, setSelectedEvent] = useState<AttackTimelineEvent | undefined>()
    const [selectedKnowledge, setSelectedKnowledge] = useState<KnowledgeDetail | undefined>()
    const [panelWidths, setPanelWidths] = useState(DEFAULT_PANEL_WIDTHS)
    const [graphHeights, setGraphHeights] = useState(DEFAULT_GRAPH_HEIGHTS)
    const [isResizingLayout, setIsResizingLayout] = useState(false)
    const panelGridRef = useRef<HTMLDivElement | null>(null)
    const graphGridRef = useRef<HTMLDivElement | null>(null)

    const events = snapshot?.events ?? []
    const visibleEvents = events.slice(0, cursorIndex)
    const currentEvent = cursorIndex > 0 ? events[Math.min(cursorIndex - 1, events.length - 1)] : undefined
    const solverIds = solverIdsFromEvents(visibleEvents)

    useEffect(() => {
        let active = true
        setLoading(true)
        setError("")
        void Promise.all([challenges.attackTimeline(challengeId), challenges.get(challengeId)])
            .then(([next, details]) => {
                if (!active) return
                setSnapshot(next)
                setChallengeInfo(details.challenge)
                setBoardMemory(details.memory)
                setBoardIdeas(details.ideas)
                setCursorIndex(0)
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
        const source = new EventSource(`/api/challenges/${encodeURIComponent(challengeId)}/attack-timeline/stream`)
        source.addEventListener("snapshot", (event) => {
            let next: AttackTimelineSnapshot
            try {
                next = JSON.parse((event as MessageEvent).data) as AttackTimelineSnapshot
            } catch {
                return // 忽略畸形 SSE 帧
            }
            startTransition(() => {
                setSnapshot(next)
                setCursorIndex((current) => Math.min(current, next.events.length))
            })
            void challenges.get(challengeId).then((details) => {
                startTransition(() => {
                    setChallengeInfo(details.challenge)
                    setBoardMemory(details.memory)
                    setBoardIdeas(details.ideas)
                })
            }).catch(() => {
                // The stream snapshot remains usable if a board refresh races a write.
            })
        })
        // 不在 onerror 里主动 close：之前断线即 close 会永久断流（网络一抖就再也不更新）。
        // 交给浏览器 EventSource 默认的自动重连，重连成功会重新收到 snapshot 刷新。
        return () => source.close()
    }, [challengeId])

    useEffect(() => {
        if (!isPlaying) return
        if (cursorIndex >= events.length) {
            setIsPlaying(false)
            return
        }
        const timer = window.setTimeout(() => {
            setCursorIndex((current) => Math.min(current + 1, events.length))
        }, Math.max(40, REPLAY_STEP_MS / Number(playbackSpeed)))
        return () => window.clearTimeout(timer)
    }, [cursorIndex, events.length, isPlaying, playbackSpeed])

    useEffect(() => {
        if (selectedSolverId && solverIds.includes(selectedSolverId)) return
        if (selectedSolverId) setSelectedSolverId(undefined)
    }, [selectedSolverId, solverIds])

    const knowledgeGraph = useMemo(
        () => buildKnowledgeGraphFromBoard(boardMemory, boardIdeas, events, currentEvent?.timestamp, challengeInfo),
        [boardIdeas, boardMemory, challengeInfo, currentEvent?.timestamp, events],
    )
    const currentProcessEvent = useMemo(() => keyTimelineEvents(visibleEvents).at(-1), [visibleEvents])
    const communicationGraph = useMemo(
        () => buildCommunicationGraph(challengeId, visibleEvents, currentProcessEvent, challengeInfo, selectedSolverId),
        [challengeId, challengeInfo, currentProcessEvent, selectedSolverId, visibleEvents],
    )
    const knowledgeFocusNodeIdValue = knowledgeFocusNodeId(currentProcessEvent)
    const communicationFocusNodeId = currentProcessEvent?.solverId ? `topology:solver:${currentProcessEvent.solverId}` : currentProcessEvent ? "topology:task" : undefined

    function handleNodeClick(_event: React.MouseEvent, node: FlowNode) {
        if (node.data.graphRole === "task") {
            setSelectedKnowledge({ kind: "task", challenge: challengeInfo, memoryCount: boardMemory.length, ideaCount: boardIdeas.filter((idea) => idea.status === "pending" || idea.status === "testing").length })
            return
        }
        if (node.data.graphRole === "memory" && node.data.rawId) {
            const item = boardMemory.find((memory) => memory.id === node.data.rawId)
            if (item) setSelectedKnowledge({ kind: "memory", item })
            return
        }
        if (node.data.graphRole === "idea" && node.data.rawId) {
            const item = boardIdeas.find((idea) => idea.id === node.data.rawId)
            if (item) setSelectedKnowledge({ kind: "idea", item })
            return
        }
        const solverId = node.data.solverId
        if (!solverId) return
        setSelectedSolverId(solverId)
    }

    function handlePanelResizeStart(event: ReactPointerEvent<HTMLButtonElement>) {
        const grid = panelGridRef.current
        if (!grid) return
        const resizeGrid = grid
        const width = grid.getBoundingClientRect().width
        if (width <= 0) return

        event.preventDefault()
        const startX = event.clientX
        const startWidths = [...panelWidths]
        let nextWidths = startWidths
        let animationFrame = 0
        const originalCursor = document.body.style.cursor
        const originalUserSelect = document.body.style.userSelect
        document.body.style.cursor = "col-resize"
        document.body.style.userSelect = "none"
        setIsResizingLayout(true)

        function handlePointerMove(moveEvent: PointerEvent) {
            const deltaPercent = ((moveEvent.clientX - startX) / width) * 100
            nextWidths = resizePanelWidths(startWidths, deltaPercent)
            if (animationFrame) return
            animationFrame = window.requestAnimationFrame(() => {
                animationFrame = 0
                resizeGrid.style.setProperty("--attack-flow-panels", `minmax(300px, ${nextWidths[0]}fr) 12px minmax(360px, ${nextWidths[1]}fr)`)
            })
        }

        function handlePointerUp() {
            if (animationFrame) window.cancelAnimationFrame(animationFrame)
            resizeGrid.style.setProperty("--attack-flow-panels", `minmax(300px, ${nextWidths[0]}fr) 12px minmax(360px, ${nextWidths[1]}fr)`)
            setPanelWidths(nextWidths)
            document.body.style.cursor = originalCursor
            document.body.style.userSelect = originalUserSelect
            window.removeEventListener("pointermove", handlePointerMove)
            window.removeEventListener("pointerup", handlePointerUp)
            window.requestAnimationFrame(() => setIsResizingLayout(false))
        }

        window.addEventListener("pointermove", handlePointerMove)
        window.addEventListener("pointerup", handlePointerUp, { once: true })
    }

    function handlePanelResizeKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
        event.preventDefault()
        const delta = event.key === "ArrowRight" ? PANEL_KEYBOARD_STEP : -PANEL_KEYBOARD_STEP
        setPanelWidths((current) => resizePanelWidths(current, delta))
    }

    function handleResetPanelWidths() {
        setPanelWidths(DEFAULT_PANEL_WIDTHS)
    }

    function handleGraphResizeStart(event: ReactPointerEvent<HTMLButtonElement>) {
        const grid = graphGridRef.current
        if (!grid) return
        const resizeGrid = grid
        const height = grid.getBoundingClientRect().height
        if (height <= 0) return

        event.preventDefault()
        const startY = event.clientY
        const startHeights = [...graphHeights]
        let nextHeights = startHeights
        let animationFrame = 0
        const originalCursor = document.body.style.cursor
        const originalUserSelect = document.body.style.userSelect
        document.body.style.cursor = "row-resize"
        document.body.style.userSelect = "none"
        setIsResizingLayout(true)

        function handlePointerMove(moveEvent: PointerEvent) {
            const deltaPercent = ((moveEvent.clientY - startY) / height) * 100
            nextHeights = resizeGraphHeights(startHeights, deltaPercent)
            if (animationFrame) return
            animationFrame = window.requestAnimationFrame(() => {
                animationFrame = 0
                resizeGrid.style.setProperty("--attack-flow-graphs", `minmax(0, ${nextHeights[0]}fr) 12px minmax(0, ${nextHeights[1]}fr)`)
            })
        }

        function handlePointerUp() {
            if (animationFrame) window.cancelAnimationFrame(animationFrame)
            resizeGrid.style.setProperty("--attack-flow-graphs", `minmax(0, ${nextHeights[0]}fr) 12px minmax(0, ${nextHeights[1]}fr)`)
            setGraphHeights(nextHeights)
            document.body.style.cursor = originalCursor
            document.body.style.userSelect = originalUserSelect
            window.removeEventListener("pointermove", handlePointerMove)
            window.removeEventListener("pointerup", handlePointerUp)
            window.requestAnimationFrame(() => setIsResizingLayout(false))
        }

        window.addEventListener("pointermove", handlePointerMove)
        window.addEventListener("pointerup", handlePointerUp, { once: true })
    }

    function handleGraphResizeKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
        event.preventDefault()
        const delta = event.key === "ArrowDown" ? GRAPH_KEYBOARD_STEP : -GRAPH_KEYBOARD_STEP
        setGraphHeights((current) => resizeGraphHeights(current, delta))
    }

    function handleResetGraphHeights() {
        setGraphHeights(DEFAULT_GRAPH_HEIGHTS)
    }

    const panelGridStyle = {
        "--attack-flow-panels": `minmax(300px, ${panelWidths[0]}fr) 12px minmax(360px, ${panelWidths[1]}fr)`,
        "--attack-flow-graphs": `minmax(0, ${graphHeights[0]}fr) 12px minmax(0, ${graphHeights[1]}fr)`,
    } as CSSProperties

    if (loading && !snapshot) return <Card><CardContent className="p-6 text-sm text-muted-foreground">加载攻击时间线…</CardContent></Card>
    if (error) return <Card><CardContent className="p-6 text-sm text-red-500">{error}</CardContent></Card>

    return (
        <div className="h-full min-h-0 min-w-0 overflow-hidden">
            <div ref={panelGridRef} className="grid h-full min-h-0 min-w-0 grid-cols-1 gap-3 overflow-hidden xl:grid-cols-[var(--attack-flow-panels)] xl:gap-0" style={panelGridStyle}>
                <TimelinePanel
                    events={visibleEvents}
                    selectedSolverId={selectedSolverId}
                    onSelectSolver={setSelectedSolverId}
                    onSelectEvent={setSelectedEvent}
                    activeEventId={currentProcessEvent?.id}
                    autoFollow={Boolean(currentProcessEvent)}
                />

                <PanelResizeHandle onPointerDown={handlePanelResizeStart} onKeyDown={handlePanelResizeKeyDown} onReset={handleResetPanelWidths} />

                <div ref={graphGridRef} className="grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-3 overflow-hidden xl:grid-rows-[var(--attack-flow-graphs)] xl:gap-0">
                    <div className="h-full min-h-0 min-w-0 overflow-hidden border border-violet-100 bg-gradient-to-br from-white to-violet-50/40">
                        <div className="h-full min-h-0 overflow-hidden">
                            <FlowCanvas
                                nodes={knowledgeGraph.nodes}
                                edges={knowledgeGraph.edges}
                                layoutEdges={knowledgeGraph.layoutEdges}
                                layoutMode="elk"
                                empty="当前时刻无记忆或思路。"
                                suspended={isResizingLayout}
                                direction="DOWN"
                                nodeWidth={240}
                                nodeHeight={92}
                                spacing={54}
                                layerSpacing={96}
                                focusNodeId={knowledgeFocusNodeIdValue}
                                onNodeClick={handleNodeClick}
                            />
                        </div>
                    </div>

                    <StackResizeHandle onPointerDown={handleGraphResizeStart} onKeyDown={handleGraphResizeKeyDown} onReset={handleResetGraphHeights} />

                    <div className="h-full min-h-0 min-w-0 overflow-hidden border border-blue-100 bg-gradient-to-br from-white to-sky-50/40">
                        <div className="h-full min-h-0 overflow-hidden">
                            <FlowCanvas
                                nodes={communicationGraph.nodes}
                                edges={communicationGraph.edges}
                                layoutEdges={communicationGraph.edges.filter((edge) => edge.id.startsWith("base:"))}
                                empty="当前时刻无运行时事件。"
                                suspended={isResizingLayout}
                                direction="DOWN"
                                nodeWidth={224}
                                nodeHeight={104}
                                spacing={44}
                                layerSpacing={112}
                                onNodeClick={handleNodeClick}
                                focusNodeId={communicationFocusNodeId}
                            />
                        </div>
                    </div>
                </div>
            </div>

            <Dialog open={Boolean(selectedSolverId)} onOpenChange={(open) => !open && setSelectedSolverId(undefined)}>
                <DialogContent className="max-h-[82vh] max-w-5xl overflow-hidden p-0">
                    {selectedSolverId ? (
                        <div className="flex max-h-[82vh] min-h-0 flex-col">
                            <DialogHeader className="border-b p-4 pr-12">
                                <DialogTitle>Solver 时间线</DialogTitle>
                                <DialogDescription>运行时消息流 · {selectedSolverId}</DialogDescription>
                            </DialogHeader>
                            <div className="h-[62vh] min-h-0 overflow-hidden">
                                <SolverRuntimeTimeline solverId={selectedSolverId} timestamp={currentEvent?.timestamp} />
                            </div>
                        </div>
                    ) : null}
                </DialogContent>
            </Dialog>

            <TimelineEventDetailDialog event={selectedEvent} onOpenChange={(open) => !open && setSelectedEvent(undefined)} />
            <KnowledgeDetailDialog detail={selectedKnowledge} onOpenChange={(open) => !open && setSelectedKnowledge(undefined)} />

            <div className="fixed right-0 bottom-0 left-0 z-20 border-t bg-background/96 shadow-lg backdrop-blur md:left-[var(--sidebar-width)]">
                <div className="flex flex-wrap items-center gap-3 px-4 py-2 md:px-6">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            if (isPlaying) {
                                setIsPlaying(false)
                                return
                            }
                            if (cursorIndex >= events.length) setCursorIndex(0)
                            setIsPlaying(true)
                        }}
                        disabled={events.length === 0}
                    >
                        {isPlaying ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
                        {isPlaying ? "暂停" : "回放"}
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                            setIsPlaying(false)
                            setCursorIndex(0)
                        }}
                        disabled={events.length === 0}
                    >
                        <RotateCcwIcon className="size-4" />
                        重置
                    </Button>
                    <Select value={playbackSpeed} onValueChange={(value) => setPlaybackSpeed((value as PlaybackSpeed | undefined) ?? "1")}>
                        <SelectTrigger size="sm" className="w-20">
                            <SelectValue>{playbackSpeed}x</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {PLAYBACK_SPEED_OPTIONS.map((speed) => (
                                <SelectItem key={speed} value={speed}>
                                    {speed}x
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Slider
                        className="min-w-0 flex-1 basis-64"
                        value={[Math.min(cursorIndex, events.length)]}
                        min={0}
                        max={Math.max(events.length, 1)}
                        step={1}
                        onValueChange={(value) => {
                            setIsPlaying(false)
                            setCursorIndex(Array.isArray(value) ? (value[0] ?? 0) : value)
                        }}
                    />
                    <span className="shrink-0 text-xs text-muted-foreground">
                        {cursorIndex} / {events.length}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatTimelineTime(currentEvent?.timestamp)}</span>
                </div>
            </div>
        </div>
    )
}

export function AttackFlowPage({ challengeId }: AttackFlowProps) {
    return (
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden p-4 pb-16">
            <div className="flex shrink-0 items-center justify-between gap-3">
                <div className="min-w-0">
                    <div className="text-xl font-semibold">攻击流</div>
                    <div className="truncate text-xs text-muted-foreground">{challengeId}</div>
                </div>
                <Button variant="outline" size="sm" onClick={() => (location.hash = `#/challenge/${encodeURIComponent(challengeId)}`)}>
                    返回目标
                </Button>
            </div>
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                <AttackFlow challengeId={challengeId} />
            </div>
        </div>
    )
}
