import { PaletteIcon } from "lucide-react"
import { getPaletteMeta } from "../lib/theme"
import type { ThemePalette } from "../lib/theme"
import { cn } from "../lib/utils"
import { Button } from "./ui/button"

export function ThemeCycleButton({
    palette,
    onCycle,
    variant = "sidebar",
    className,
}: {
    palette: ThemePalette
    onCycle: () => void
    variant?: "sidebar" | "header"
    className?: string
}) {
    const meta = getPaletteMeta(palette)

    if (variant === "header") {
        return (
            <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title={`主题：${meta.label}（点击切换）`}
                aria-label={`切换主题，当前 ${meta.label}`}
                onClick={onCycle}
                className={cn("relative size-8 rounded-lg", className)}
            >
                <span
                    className="size-4 rounded-full ring-1 ring-border/75"
                    style={{ background: meta.swatch }}
                />
            </Button>
        )
    }

    return (
        <button
            type="button"
            title={`主题：${meta.label}（点击切换）`}
            aria-label={`切换主题，当前 ${meta.label}`}
            onClick={onCycle}
            className={cn(
                "flex w-full shrink-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-sidebar-accent",
                className,
            )}
        >
            <span
                className="size-5 shrink-0 rounded-full ring-1 ring-border/75"
                style={{ background: meta.swatch }}
            />
            <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-foreground/90">{meta.label}</span>
            <PaletteIcon className="size-4 shrink-0 text-muted-foreground" strokeWidth={2} />
        </button>
    )
}
