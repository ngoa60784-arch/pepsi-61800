export type ThemePalette = "ocean" | "forest" | "violet" | "amber" | "rose" | "slate" | "snow"
export type ThemeAppearance = "light" | "dark"

export const THEME_PALETTE_STORAGE_KEY = "tch-ui-theme-palette"
export const THEME_APPEARANCE_STORAGE_KEY = "tch-ui-appearance"

export const themePalettes: { id: ThemePalette; label: string; swatch: string }[] = [
    { id: "ocean", label: "海蓝", swatch: "oklch(0.56 0.19 254)" },
    { id: "forest", label: "森绿", swatch: "oklch(0.56 0.19 145)" },
    { id: "violet", label: "紫罗兰", swatch: "oklch(0.58 0.2 300)" },
    { id: "amber", label: "琥珀", swatch: "oklch(0.68 0.16 75)" },
    { id: "rose", label: "玫红", swatch: "oklch(0.6 0.2 15)" },
    { id: "slate", label: "石墨", swatch: "oklch(0.52 0.02 264)" },
    { id: "snow", label: "雪白", swatch: "oklch(0.99 0.002 264)" },
]

const paletteIds = new Set(themePalettes.map((item) => item.id))

function readStoredPalette(): ThemePalette {
    const stored = localStorage.getItem(THEME_PALETTE_STORAGE_KEY)
    if (stored && paletteIds.has(stored as ThemePalette)) return stored as ThemePalette
    return "ocean"
}

function readStoredAppearance(): ThemeAppearance {
    const stored = localStorage.getItem(THEME_APPEARANCE_STORAGE_KEY)
    if (stored === "light" || stored === "dark") return stored
    return "dark"
}

const themeColorMeta: Record<ThemePalette, { light: string; dark: string }> = {
    ocean: { light: "#eef2fb", dark: "#0a0f1a" },
    forest: { light: "#edf5ef", dark: "#0a140e" },
    violet: { light: "#f3eef8", dark: "#120a18" },
    amber: { light: "#faf5e8", dark: "#16120a" },
    rose: { light: "#faf0f0", dark: "#160a0c" },
    slate: { light: "#f2f2f4", dark: "#101012" },
    snow: { light: "#ffffff", dark: "#141416" },
}

export function applyTheme(palette: ThemePalette, appearance: ThemeAppearance) {
    const root = document.documentElement
    root.dataset.theme = palette
    root.classList.toggle("dark", appearance === "dark")

    const themeColor = themeColorMeta[palette][appearance]
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor)
}

export function initThemeFromStorage() {
    applyTheme(readStoredPalette(), readStoredAppearance())
}

export function persistTheme(palette: ThemePalette, appearance: ThemeAppearance) {
    localStorage.setItem(THEME_PALETTE_STORAGE_KEY, palette)
    localStorage.setItem(THEME_APPEARANCE_STORAGE_KEY, appearance)
    applyTheme(palette, appearance)
}

export function getPaletteMeta(palette: ThemePalette) {
    return themePalettes.find((item) => item.id === palette) ?? themePalettes[0]
}

export function nextPalette(palette: ThemePalette): ThemePalette {
    const index = themePalettes.findIndex((item) => item.id === palette)
    const nextIndex = index < 0 ? 0 : (index + 1) % themePalettes.length
    return themePalettes[nextIndex].id
}
