import { useState } from "react"
import { Button } from "./button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./dialog"
import { Textarea } from "./textarea"

export function JsonEditorDialog({ label, value, onSave }: { label: string; value: unknown; onSave: (v: unknown) => void }) {
    const [open, setOpen] = useState(false)
    const [text, setText] = useState("")
    const [error, setError] = useState("")

    const hasValue = value != null && Object.keys(value as Record<string, unknown>).length > 0

    function handleOpen() {
        setText(value ? JSON.stringify(value, null, 2) : "{\n  \n}")
        setError("")
        setOpen(true)
    }

    function handleSave() {
        const trimmed = text.trim()
        if (!trimmed || trimmed === "{}" || trimmed === "{\n  \n}") {
            onSave(undefined)
            setOpen(false)
            return
        }
        try {
            const parsed = JSON.parse(trimmed)
            if (label === "headers") {
                for (const [k, v] of Object.entries(parsed)) {
                    if (typeof v !== "string") {
                        setError(`"${k}" 的值必须是字符串`)
                        return
                    }
                }
            }
            onSave(parsed)
            setOpen(false)
        } catch {
            setError("JSON 无效")
        }
    }

    return (
        <>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={handleOpen}>
                {label}
                {hasValue && <span className="ml-1 text-[10px] opacity-60">已设</span>}
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>编辑 {label}</DialogTitle>
                    </DialogHeader>
                    <Textarea className="font-mono text-xs" rows={8} value={text} onChange={(e) => { setText(e.target.value); setError("") }} />
                    {error && <p className="text-xs text-destructive">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => setOpen(false)}>取消</Button>
                        <Button size="sm" onClick={handleSave}>保存</Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    )
}
