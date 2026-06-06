import { createContext, useCallback, useRef, useState, type ReactNode } from "react"
import { Button } from "./ui/button"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "./ui/dialog"

export type ConfirmOptions = {
    title: string
    description: ReactNode
    confirmLabel?: string
    cancelLabel?: string
    variant?: "default" | "destructive"
}

type PendingConfirm = {
    options: ConfirmOptions
    resolve: (confirmed: boolean) => void
}

export const ConfirmDialogContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null)

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
    const [pending, setPending] = useState<PendingConfirm | null>(null)
    const pendingRef = useRef<PendingConfirm | null>(null)

    const confirm = useCallback((options: ConfirmOptions) => {
        return new Promise<boolean>((resolve) => {
            const next: PendingConfirm = { options, resolve }
            pendingRef.current = next
            setPending(next)
        })
    }, [])

    function settle(result: boolean) {
        const current = pendingRef.current
        if (!current) return
        pendingRef.current = null
        setPending(null)
        current.resolve(result)
    }

    function handleOpenChange(open: boolean) {
        if (!open) settle(false)
    }

    const options = pending?.options
    const confirmLabel = options?.confirmLabel ?? "确认"
    const cancelLabel = options?.cancelLabel ?? "取消"
    const destructive = options?.variant === "destructive"

    return (
        <ConfirmDialogContext.Provider value={confirm}>
            {children}
            <Dialog open={pending !== null} onOpenChange={handleOpenChange}>
                <DialogContent showCloseButton={false} className="max-w-md rounded-2xl p-0 ring-border/75">
                    <DialogHeader className="gap-2 px-5 pt-5">
                        <DialogTitle className="text-base font-semibold">{options?.title}</DialogTitle>
                        <DialogDescription className="text-[0.875rem] leading-relaxed whitespace-pre-wrap">
                            {options?.description}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2 border-t border-border/75 bg-muted/30 px-5 py-4 sm:justify-end">
                        <Button type="button" variant="outline" onClick={() => settle(false)}>
                            {cancelLabel}
                        </Button>
                        <Button
                            type="button"
                            variant={destructive ? "destructive" : "default"}
                            onClick={() => settle(true)}
                        >
                            {confirmLabel}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </ConfirmDialogContext.Provider>
    )
}
