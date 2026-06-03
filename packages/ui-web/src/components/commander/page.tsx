import { useEffect, useRef, useState } from "react"
import { commander } from "../../lib/api"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
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

export function CommanderPage() {
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [input, setInput] = useState("")
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")
    const [rollbackPoints, setRollbackPoints] = useState<RollbackPoint[]>([])
    const streamingRef = useRef(false)
    const scrollRef = useRef<HTMLDivElement>(null)
    const fileRef = useRef<HTMLInputElement>(null)

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
            // 把文档内容塞进输入框，并加一句指令让 Commander 走 import_findings 接力流程。
            // 不直接发送：留给操作员补充目标/侧重点后再点发送。
            const directive = `这是一个渗透到一半的目标的记录文档。请用 import_findings 把其中的已得凭据/已确认事实/已死路线/待测假设导入共享态，然后派 solver 接着测（如果文档里有目标地址就用它 create_target，没有就先问我目标地址）。\n\n--- 渗透记录文档（${file.name}）---\n${trimmed}`
            setInput((prev) => (prev.trim() ? `${prev.trim()}\n\n${directive}` : directive))
            setError("")
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            if (fileRef.current) fileRef.current.value = ""
        }
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

    useEffect(() => {
        void restoreConversation()
        void loadRollbackPoints()
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
        } else if (event.type === "error") {
            setError(event.text ?? "指挥官错误")
            streamingRef.current = false
            setBusy(false)
        }
    }

    async function handleSend() {
        const text = input.trim()
        if (!text || busy) return
        setError("")
        setInput("")
        setMessages((prev) => [...prev, { role: "user", text, tools: [] }])
        streamingRef.current = false
        setBusy(true)
        try {
            await commander.send(text)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
            setBusy(false)
        }
    }

    // 开一轮全新的干净对话（不影响已派出的 solver）。
    async function handleNewSession() {
        if (busy) return
        if (!confirm("开始新对话？当前指挥官对话会清空（已派出的 solver 不受影响）。")) return
        setError("")
        try {
            await commander.newSession()
            setMessages([])
            setRollbackPoints([])
            setInput("")
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
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

    // PLACEHOLDER_RENDER
    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b px-4 py-2">
                <span className="text-sm font-medium">指挥官</span>
                <Button variant="outline" size="sm" onClick={() => void handleNewSession()} disabled={busy}>
                    新建对话
                </Button>
            </div>
            <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
                {messages.length === 0 && (
                    <div className="text-sm text-muted-foreground">
                        用自然语言下达渗透目标，例如：「测一下 example.com，重点看上传和 SSRF」。指挥官会自动建立目标并派出 solver。
                    </div>
                )}
                {messages.map((msg, index) => {
                    const point = msg.role === "user" ? rollbackPointForUserMessage(index) : undefined
                    return (
                        <div key={index} className={cn("group flex items-center gap-2", msg.role === "user" ? "justify-end" : "justify-start")}>
                            {point && (
                                <button
                                    type="button"
                                    onClick={() => void handleRollback(point, index)}
                                    disabled={busy}
                                    title="回退到此处（丢弃这条及之后的对话，文本放回输入框）"
                                    className="opacity-0 transition-opacity group-hover:opacity-100 text-xs text-muted-foreground hover:text-foreground disabled:opacity-30"
                                >
                                    ↩ 回退
                                </button>
                            )}
                            <div
                                className={cn(
                                    "max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words",
                                    msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted",
                                )}
                            >
                                {msg.tools.length > 0 && (
                                    <div className="mb-1 flex flex-wrap gap-1">
                                        {msg.tools.map((tool, i) => (
                                            <span key={i} className="rounded bg-background/60 px-1.5 py-0.5 font-mono text-xs">
                                                {tool}
                                            </span>
                                        ))}
                                    </div>
                                )}
                                {msg.text}
                            </div>
                        </div>
                    )
                })}
                {busy && <div className="text-xs text-muted-foreground">指挥官处理中…</div>}
            </div>
            {error && <div className="px-4 py-2 text-sm text-destructive">{error}</div>}
            <div className="flex items-end gap-2 border-t p-4">
                <input
                    ref={fileRef}
                    type="file"
                    accept=".md,.txt,.json,.log,.markdown,text/plain"
                    className="hidden"
                    onChange={(event) => void handleUploadDoc(event)}
                />
                <Button variant="outline" disabled={busy} onClick={() => fileRef.current?.click()} title="上传渗透记录文档，载入后接着测">
                    上传文档
                </Button>
                <Textarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault()
                            void handleSend()
                        }
                    }}
                    placeholder="下达目标或追问进展…（Enter 发送，Shift+Enter 换行；或点『上传文档』载入渗透记录接着测）"
                    rows={2}
                    className="flex-1 resize-none"
                />
                <Button onClick={() => void handleSend()} disabled={busy || !input.trim()}>
                    发送
                </Button>
            </div>
        </div>
    )
}
