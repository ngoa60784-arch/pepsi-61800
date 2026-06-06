import { useEffect, useState } from "react"
import { confirmDesktopExit, listenDesktopCloseRequest } from "../lib/desktop-bridge"
import { Button } from "./ui/button"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "./ui/dialog"

export function DesktopExitDialog() {
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")

    useEffect(() => {
        return listenDesktopCloseRequest(() => {
            setError("")
            setOpen(true)
        })
    }, [])

    async function handleConfirm() {
        setBusy(true)
        setError("")
        try {
            await confirmDesktopExit()
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent showCloseButton={false} className="max-w-md rounded-2xl p-0 ring-border/75">
                <DialogHeader className="gap-2 px-5 pt-5">
                    <DialogTitle className="text-base font-semibold">退出 BreachWeave</DialogTitle>
                    <DialogDescription className="text-[0.875rem] leading-relaxed">
                        确定要结束所有 BreachWeave 进程并退出吗？将停止本机 sidecar 服务与指挥台。
                    </DialogDescription>
                </DialogHeader>
                {error ? <p className="px-5 text-sm text-destructive">{error}</p> : null}
                <DialogFooter className="gap-2 border-t border-border/75 bg-muted/30 px-5 py-4 sm:justify-end">
                    <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
                        取消
                    </Button>
                    <Button type="button" variant="destructive" disabled={busy} onClick={() => void handleConfirm()}>
                        {busy ? "退出中…" : "退出"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
