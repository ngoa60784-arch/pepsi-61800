import { useEffect, useState } from "react"
import type { ThemeAppearance, ThemePalette } from "../lib/theme"
import { nextPalette, persistTheme, themePalettes } from "../lib/theme"

function readPalette(): ThemePalette {
    const stored = localStorage.getItem("tch-ui-theme-palette")
    if (stored && themePalettes.some((item) => item.id === stored)) return stored as ThemePalette
    return document.documentElement.dataset.theme === "ocean" || !document.documentElement.dataset.theme
        ? "ocean"
        : (document.documentElement.dataset.theme as ThemePalette)
}

function readAppearance(): ThemeAppearance {
    const stored = localStorage.getItem("tch-ui-appearance")
    if (stored === "light" || stored === "dark") return stored
    return document.documentElement.classList.contains("dark") ? "dark" : "light"
}

export function useTheme() {
    const [palette, setPalette] = useState<ThemePalette>(readPalette)
    const [appearance, setAppearance] = useState<ThemeAppearance>(readAppearance)

    useEffect(() => {
        persistTheme(palette, appearance)
    }, [palette, appearance])

    function selectPalette(next: ThemePalette) {
        setPalette(next)
    }

    function selectAppearance(next: ThemeAppearance) {
        setAppearance(next)
    }

    function cyclePalette() {
        setPalette((current) => nextPalette(current))
    }

    function toggleAppearance() {
        setAppearance((current) => (current === "dark" ? "light" : "dark"))
    }

    return { palette, appearance, selectPalette, selectAppearance, cyclePalette, toggleAppearance }
}
