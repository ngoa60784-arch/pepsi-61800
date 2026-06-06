import { MoonIcon, SunIcon } from "lucide-react"
import type { ThemeAppearance } from "../lib/theme"
import { cn } from "../lib/utils"
import { Button } from "./ui/button"

export function ThemeAppearanceButton({
    appearance,
    onToggle,
    variant = "sidebar",
    className,
}: {
    appearance: ThemeAppearance
    onToggle: () => void
    variant?: "sidebar" | "header"
    className?: string
}) {
    const isDark = appearance === "dark"
    const label = isDark ? "切换为浅色模式" : "切换为深色模式"

    if (variant === "header") {
        return (
            <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title={label}
                aria-label={label}
                onClick={onToggle}
                className={cn("size-8 rounded-lg", className)}
            >
                {isDark ? <SunIcon className="size-4" strokeWidth={2} /> : <MoonIcon className="size-4" strokeWidth={2} />}
            </Button>
        )
    }

    return (
        <button
            type="button"
            title={label}
            aria-label={label}
            onClick={onToggle}
            className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-xl text-foreground/90 transition-colors hover:bg-sidebar-accent",
                className,
            )}
        >
            {isDark ? <SunIcon className="size-[1.125rem]" strokeWidth={2} /> : <MoonIcon className="size-[1.125rem]" strokeWidth={2} />}
        </button>
    )
}
