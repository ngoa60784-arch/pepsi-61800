import { useEffect, useRef, useState } from "react"
import {
    ArrowUpIcon,
    ChevronDownIcon,
    ChevronUpIcon,
    FileTextIcon,
    HistoryIcon,
    PlusIcon,
    PaperclipIcon,
    Trash2Icon,
    XIcon,
} from "lucide-react"
import { commander, type CommanderSessionItem } from "../../lib/api"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "../ui/sheet"
import { Textarea } from "../ui/textarea"

interface ChatMessage {
    role: "user" | "assistant"
    text: string
    tools: string[]
}

interface CommanderEvent {
    type: "text_delta" | "message_end" | "tool_start" | "tool_end" | "error" | "rolled_back"
    text?: string
    toolName?: string
    isError?: boolean
}

interface RollbackPoint {
    entryId: string
    text: string
}

interface PendingDoc {
    name: string
    content: string
}

const MAX_DOC_CHARS = 500_000

function formatDocSize(chars: number): string {
    if (chars < 1024) return `${chars} 字`
    if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`
    return `${(chars / (1024 * 1024)).toFixed(1)} MB`
}

function toolChipClass(label: string): string {
    if (label.startsWith("✓")) return "commander-tool-chip commander-tool-chip-ok"
    if (label.startsWith("✗")) return "commander-tool-chip commander-tool-chip-err"
    if (label.startsWith("▶")) return "commander-tool-chip commander-tool-chip-run"
    return "commander-tool-chip"
}

function userBubbleText(note: string, doc: PendingDoc | null): string {
    if (!doc) return note
    const line = note.trim() || "请处理上传的渗透记录文档。"
    return `${line}\n\n📎 ${doc.name}`
}

export function CommanderPage() {
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [input, setInput] = useState("")
    const [pendingDoc, setPendingDoc] = useState<PendingDoc | null>(null)
    const [docPreviewOpen, setDocPreviewOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")
    const [rollbackPoints, setRollbackPoints] = useState<RollbackPoint[]>([])
    const [sessions, setSessions] = useState<CommanderSessionItem[]>([])
    const [sessionsOpen, setSessionsOpen] = useState(false)
    const [sessionsLoading, setSessionsLoading] = useState(false)
    const streamingRef = useRef(false)
    const scrollRef = useRef<HTMLDivElement>(null)
    const fileRef = useRef<HTMLInputElement>(null)

    const canSend = Boolean(input.trim() || pendingDoc)

    async function handleUploadDoc(event: React.ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0]
        if (!file) return
        try {
            const text = await file.text()
            const trimmed = text.trim()
            if (!trimmed) {
                setError("文档为空")
                return
            }
            if (trimmed.length > MAX_DOC_CHARS) {
                setError(`文档过大（${formatDocSize(trimmed.length)}），上限 ${formatDocSize(MAX_DOC_CHARS)}`)
                return
            }
            setPendingDoc({ name: file.name, content: trimmed })
            setDocPreviewOpen(false)
            setError("")
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            if (fileRef.current) fileRef.current.value = ""
        }
    }

    function clearPendingDoc() {
        setPendingDoc(null)
        setDocPreviewOpen(false)
    }

    async function loadRollbackPoints() {
        try {
            const res = await commander.rollbackPoints()
            setRollbackPoints(res.points)
        } catch {
            // ignore
        }
    }

    // 切换版块会卸载组件、清空本地 messages，但后端 session 是持久的——
    // 挂载时从后端恢复完整对话，避免"切回来对话没了"。
    async function restoreConversation() {
        try {
            const res = await commander.messages()
            setMessages(res.messages.map((m) => ({ role: m.role, text: m.text, tools: [] })))
        } catch {
            // ignore
        }
    }

    async function loadSessions() {
        setSessionsLoading(true)
        try {
            const res = await commander.sessions()
            setSessions(res.sessions)
        } catch (err) {
            setSessions([])
            const message = err instanceof Error ? err.message : String(err)
            if (message.includes("404") || message.toLowerCase().includes("not found")) {
                setError("对话列表接口不可用：请重启 Web 服务（bun run web）以加载最新代码。")
            } else {
                setError(`加载对话列表失败：${message}`)
            }
        } finally {
            setSessionsLoading(false)
        }
    }

    useEffect(() => {
        void restoreConversation()
        void loadRollbackPoints()
        void loadSessions()
        const source = new EventSource("/api/commander/stream")
        source.addEventListener("commander", (event) => {
            try {
                handleEvent(JSON.parse((event as MessageEvent).data) as CommanderEvent)
            } catch {
                // 忽略畸形 SSE 帧，避免一帧坏数据让监听器抛错中断
            }
        })
        return () => source.close()
    }, [])

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    }, [messages])

    // busy 看门狗：正常情况下 busy 由 SSE 的 message_end/error 解除；但若 SSE 断线、
    // 这两个事件丢失，UI 会永久卡在 busy（无法再发消息）。这里在 busy 期间轮询服务端的
    // busy 真相源，一旦服务端已不忙就解除本地 busy 并补取最终对话，避免假死。
    useEffect(() => {
        if (!busy) return
        const timer = setInterval(() => {
            void (async () => {
                try {
                    const { busy: serverBusy } = await commander.status()
                    if (!serverBusy) {
                        streamingRef.current = false
                        setBusy(false)
                        void restoreConversation()
                        void loadRollbackPoints()
                    }
                } catch {
                    // 瞬时网络错误：下个周期再校正
                }
            })()
        }, 4000)
        return () => clearInterval(timer)
    }, [busy])

    function appendAssistantDelta(delta: string) {
        setMessages((prev) => {
            const next = [...prev]
            const last = next[next.length - 1]
            if (streamingRef.current && last?.role === "assistant") {
                next[next.length - 1] = { ...last, text: last.text + delta }
            } else {
                next.push({ role: "assistant", text: delta, tools: [] })
                streamingRef.current = true
            }
            return next
        })
    }

    function appendToolBadge(label: string) {
        setMessages((prev) => {
            const next = [...prev]
            const last = next[next.length - 1]
            if (streamingRef.current && last?.role === "assistant") {
                next[next.length - 1] = { ...last, tools: [...last.tools, label] }
            } else {
                next.push({ role: "assistant", text: "", tools: [label] })
                streamingRef.current = true
            }
            return next
        })
    }

    function handleEvent(event: CommanderEvent) {
        if (event.type === "text_delta" && event.text) {
            appendAssistantDelta(event.text)
        } else if (event.type === "tool_start" && event.toolName) {
            appendToolBadge(`▶ ${event.toolName}`)
        } else if (event.type === "tool_end" && event.toolName) {
            appendToolBadge(event.isError ? `✗ ${event.toolName}` : `✓ ${event.toolName}`)
        } else if (event.type === "message_end") {
            streamingRef.current = false
            setBusy(false)
            void loadRollbackPoints()
        } else if (event.type === "rolled_back") {
            void restoreConversation()
            void loadRollbackPoints()
            void loadSessions()
        } else if (event.type === "error") {
            setError(event.text ?? "指挥官错误")
            streamingRef.current = false
            setBusy(false)
        }
    }

    async function handleSend() {
        if (!canSend || busy) return
        const doc = pendingDoc
        const bubbleText = userBubbleText(input, doc)
        setError("")
        setInput("")
        clearPendingDoc()
        setMessages((prev) => [...prev, { role: "user", text: bubbleText, tools: [] }])
        streamingRef.current = false
        setBusy(true)
        try {
            await commander.send(
                input,
                doc ? { name: doc.name, content: doc.content } : undefined,
            )
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
            setBusy(false)
        }
    }

    // 开一轮全新的干净对话（不影响已派出的 solver）。
    async function handleNewSession() {
        if (busy) return
        if (!confirm("开始新对话？当前界面会清空；旧对话仍保留在对话列表中，可随时切换回来（已派出的 solver 不受影响）。")) return
        setError("")
        try {
            await commander.newSession()
            setMessages([])
            setRollbackPoints([])
            setInput("")
            clearPendingDoc()
            void loadSessions()
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }

    async function handleSwitchSession(item: CommanderSessionItem) {
        if (busy || item.active) return
        setError("")
        try {
            const res = await commander.switchSession(item.path)
            setMessages(res.messages.map((m) => ({ role: m.role, text: m.text, tools: [] })))
            setRollbackPoints([])
            setInput("")
            clearPendingDoc()
            void loadRollbackPoints()
            void loadSessions()
            setSessionsOpen(false)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }

    async function handleDeleteSession(item: CommanderSessionItem, event: React.MouseEvent) {
        event.stopPropagation()
        if (busy) return
        if (!confirm(`删除这条对话？\n\n${item.preview}\n\n删除后无法恢复。`)) return
        setError("")
        try {
            const res = await commander.deleteSession(item.path)
            setMessages(res.messages.map((m) => ({ role: m.role, text: m.text, tools: [] })))
            setSessions(res.sessions)
            void loadRollbackPoints()
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }

    function formatSessionTime(iso: string): string {
        const date = new Date(iso)
        if (Number.isNaN(date.getTime())) return iso
        return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    }

    // 回退到某条操作员消息之前的状态：丢弃该轮及之后的对话，把该消息文本放回输入框以便重发/修改。
    async function handleRollback(point: RollbackPoint, _messageIndex: number) {
        if (busy) return
        setError("")
        try {
            // 直接用后端回退后返回的当前分支消息覆盖，避免乐观截断与 SSE 刷新竞态。
            const res = await commander.rollback(point.entryId)
            setMessages(res.messages.map((m) => ({ role: m.role, text: m.text, tools: [] })))
            setInput(point.text)
            void loadRollbackPoints()
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }

    // 第 n 条 user 消息对应第 n 个 rollback point（按出现顺序一一对应）。
    function rollbackPointForUserMessage(messageIndex: number): RollbackPoint | undefined {
        let userSeen = -1
        for (let i = 0; i <= messageIndex && i < messages.length; i += 1) {
            if (messages[i].role === "user") userSeen += 1
        }
        return rollbackPoints[userSeen]
    }

    return (
        <div className="commander-page flex h-full min-h-0 flex-col">
            <div className="commander-toolbar flex shrink-0 items-center justify-end gap-2 border-b border-border/75 px-3 py-2">
                <Sheet
                    open={sessionsOpen}
                    onOpenChange={(open) => {
                        setSessionsOpen(open)
                        if (open) void loadSessions()
                    }}
                >
                    <SheetTrigger render={<Button variant="ghost" size="sm" className="h-8 gap-1.5 rounded-lg px-2.5" disabled={busy} />}>
                        <HistoryIcon className="size-4" />
                        <span className="text-[0.8125rem] font-medium">历史</span>
                    </SheetTrigger>
                    <SheetContent side="left" className="w-full border-border/75 bg-background sm:max-w-md">
                        <SheetHeader className="border-b border-border/75 pb-4">
                            <SheetTitle className="text-[1.25rem] font-bold">对话</SheetTitle>
                            <SheetDescription className="text-[0.875rem]">切换或删除历史记录，不影响已派出的 solver。</SheetDescription>
                        </SheetHeader>
                        <div className="flex-1 overflow-y-auto px-4 py-4">
                            {sessionsLoading && sessions.length === 0 && (
                                <p className="py-8 text-center text-[0.875rem] text-muted-foreground">加载中…</p>
                            )}
                            {!sessionsLoading && sessions.length === 0 && (
                                <p className="py-8 text-center text-[0.875rem] text-muted-foreground">暂无已保存的对话</p>
                            )}
                            <ul className="space-y-2">
                                {sessions.map((item) => (
                                    <li key={item.path}>
                                        <div
                                            className={cn(
                                                "commander-session-row group flex w-full items-start justify-between gap-2 text-left",
                                                item.active && "commander-session-row-active",
                                                busy && "opacity-50",
                                            )}
                                        >
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() => void handleSwitchSession(item)}
                                                className="min-w-0 flex-1 text-left"
                                            >
                                                <p className="line-clamp-2 text-[0.9375rem] font-medium leading-snug">{item.preview}</p>
                                                <p className="mt-1 text-[0.75rem] text-muted-foreground">
                                                    {formatSessionTime(item.modified)} · {item.messageCount} 条
                                                    {item.active ? " · 当前" : ""}
                                                </p>
                                            </button>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon-sm"
                                                className="shrink-0 rounded-lg opacity-0 group-hover:opacity-100"
                                                disabled={busy}
                                                title="删除此对话"
                                                onClick={(event) => void handleDeleteSession(item, event)}
                                            >
                                                <Trash2Icon className="size-4 text-destructive" />
                                            </Button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </SheetContent>
                </Sheet>
                <Button variant="ghost" size="sm" className="h-8 gap-1.5 rounded-lg px-2.5" onClick={() => void handleNewSession()} disabled={busy}>
                    <PlusIcon className="size-4" />
                    <span className="text-[0.8125rem] font-medium">新对话</span>
                </Button>
            </div>

            <div ref={scrollRef} className="commander-messages min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
                {messages.length === 0 && (
                    <div className="commander-empty mx-auto max-w-md rounded-2xl bg-card px-4 py-5 text-center ring-1 ring-border/65">
                        <p className="text-[0.9375rem] font-medium text-foreground">下达渗透目标</p>
                        <p className="mt-2 text-[0.8125rem] leading-relaxed text-muted-foreground">
                            例如：「测一下 example.com，重点看上传和 SSRF」。可上传半途中断的渗透记录，指挥官会导入并派出 solver。
                        </p>
                    </div>
                )}
                <div className="flex w-full flex-col gap-3">
                    {messages.map((msg, index) => {
                        const point = msg.role === "user" ? rollbackPointForUserMessage(index) : undefined
                        const isUser = msg.role === "user"
                        return (
                            <div
                                key={index}
                                className={cn("group flex w-full", isUser ? "justify-end" : "justify-start")}
                            >
                                <div className={cn("flex min-w-0 max-w-[85%] flex-col gap-1", isUser ? "items-end" : "items-start")}>
                                    {msg.tools.length > 0 && (
                                        <div className="flex flex-wrap gap-1 px-1">
                                            {msg.tools.map((tool, i) => (
                                                <span key={i} className={toolChipClass(tool)}>
                                                    {tool}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                    <div className={cn("commander-bubble", isUser ? "commander-bubble-user" : "commander-bubble-assistant")}>
                                        {msg.text}
                                    </div>
                                    {point && (
                                        <button
                                            type="button"
                                            onClick={() => void handleRollback(point, index)}
                                            disabled={busy}
                                            title="回退到此处"
                                            className="px-1 text-[0.75rem] font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-30"
                                        >
                                            撤回
                                        </button>
                                    )}
                                </div>
                            </div>
                        )
                    })}
                    {busy && (
                        <div className="flex w-full justify-start">
                            <div className="commander-bubble commander-bubble-assistant commander-typing px-4 py-3">
                                <span className="commander-typing-dot" />
                                <span className="commander-typing-dot" />
                                <span className="commander-typing-dot" />
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {error && (
                <div className="commander-error shrink-0 px-4 py-2 text-center text-[0.8125rem] font-medium text-destructive">{error}</div>
            )}

            <div className="commander-composer shrink-0 border-t border-border/75">
                {pendingDoc && (
                    <div className="space-y-2 border-b border-border/65 px-3 py-2.5">
                        <div className="flex items-center gap-2 rounded-xl bg-muted/60 px-3 py-2.5 ring-1 ring-border/55">
                            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                                <FileTextIcon className="size-4" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-[0.875rem] font-semibold">{pendingDoc.name}</p>
                                <p className="text-[0.75rem] text-muted-foreground">{formatDocSize(pendingDoc.content.length)} · 待发</p>
                            </div>
                            <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 text-[0.75rem]" onClick={() => setDocPreviewOpen((open) => !open)}>
                                {docPreviewOpen ? <ChevronUpIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
                                预览
                            </Button>
                            <Button type="button" variant="ghost" size="icon-sm" className="shrink-0 rounded-lg" disabled={busy} onClick={clearPendingDoc}>
                                <XIcon className="size-4" />
                            </Button>
                        </div>
                        {docPreviewOpen && (
                            <pre className="max-h-36 overflow-auto rounded-xl bg-muted/40 p-3 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
                                {pendingDoc.content.length > 8000
                                    ? `${pendingDoc.content.slice(0, 8000)}\n\n…（预览截断，发送含全文）`
                                    : pendingDoc.content}
                            </pre>
                        )}
                    </div>
                )}
                <div className="flex items-end gap-2 px-3 py-3">
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".md,.txt,.json,.log,.markdown,text/plain"
                        className="hidden"
                        onChange={(event) => void handleUploadDoc(event)}
                    />
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="commander-attach-btn size-9 shrink-0 rounded-full"
                        disabled={busy}
                        onClick={() => fileRef.current?.click()}
                        title="上传渗透记录"
                    >
                        <PaperclipIcon className="size-5" strokeWidth={2} />
                    </Button>
                    <div className="commander-input-wrap flex min-h-9 min-w-0 flex-1 items-end rounded-[1.25rem] bg-muted px-3 py-1.5 ring-1 ring-border/55">
                        <Textarea
                            value={input}
                            onChange={(event) => setInput(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && !event.shiftKey) {
                                    event.preventDefault()
                                    void handleSend()
                                }
                            }}
                            placeholder={
                                pendingDoc ? "补充说明（可选）" : "输入目标或追问…"
                            }
                            rows={1}
                            className="max-h-28 min-h-6 flex-1 resize-none border-0 bg-transparent px-0 py-1 text-[0.9375rem] shadow-none focus-visible:ring-0 dark:bg-transparent"
                        />
                    </div>
                    <Button
                        type="button"
                        size="icon"
                        className={cn(
                            "size-9 shrink-0 rounded-full transition-all",
                            canSend && !busy ? "bg-primary text-primary-foreground shadow-sm" : "bg-muted text-muted-foreground",
                        )}
                        disabled={busy || !canSend}
                        onClick={() => void handleSend()}
                        title={pendingDoc ? "发送含文档" : "发送"}
                    >
                        <ArrowUpIcon className="size-5" strokeWidth={2.5} />
                    </Button>
                </div>
            </div>
        </div>
    )
}
