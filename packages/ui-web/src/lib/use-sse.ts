import { useEffect, useRef, useState } from "react"

export type SseConnectionStatus = "connecting" | "open" | "reconnecting" | "closed"

export interface UseSseOptions {
    /** SSE event name (e.g. `digest`). */
    event: string
    onMessage: (data: string) => void
    enabled?: boolean
}

export interface UseSseResult {
    status: SseConnectionStatus
    lastEventAt: number | null
}

/**
 * EventSource wrapper: relies on browser auto-reconnect; surfaces connection + freshness for UI.
 */
export function useSse(url: string, options: UseSseOptions): UseSseResult {
    const { event, onMessage, enabled = true } = options
    const [status, setStatus] = useState<SseConnectionStatus>(enabled ? "connecting" : "closed")
    const [lastEventAt, setLastEventAt] = useState<number | null>(null)
    const onMessageRef = useRef(onMessage)
    onMessageRef.current = onMessage

    useEffect(() => {
        if (!enabled) {
            setStatus("closed")
            return
        }

        let receivedEvent = false
        const source = new EventSource(url)

        function handleOpen() {
            setStatus(receivedEvent ? "open" : "connecting")
        }

        function handleError() {
            setStatus(receivedEvent ? "reconnecting" : "connecting")
        }

        source.addEventListener("open", handleOpen)
        source.addEventListener("error", handleError)
        source.addEventListener(event, (raw) => {
            receivedEvent = true
            setLastEventAt(Date.now())
            setStatus("open")
            onMessageRef.current((raw as MessageEvent).data as string)
        })

        return () => {
            source.removeEventListener("open", handleOpen)
            source.removeEventListener("error", handleError)
            source.close()
            setStatus("closed")
        }
    }, [url, event, enabled])

    return { status, lastEventAt }
}

export function formatFreshness(lastEventAt: number | null, updatedAt?: string): string {
    const reference = lastEventAt ?? (updatedAt ? Date.parse(updatedAt) : null)
    if (!reference || Number.isNaN(reference)) return "尚无更新"
    const sec = Math.max(0, Math.floor((Date.now() - reference) / 1000))
    if (sec < 5) return "刚刚"
    if (sec < 60) return `${sec} 秒前`
    if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`
    return new Date(reference).toLocaleString()
}

export function isDataStale(lastEventAt: number | null, updatedAt?: string, thresholdSec = 60): boolean {
    const reference = lastEventAt ?? (updatedAt ? Date.parse(updatedAt) : null)
    if (!reference || Number.isNaN(reference)) return false
    return Date.now() - reference > thresholdSec * 1000
}
