import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app"
import { initThemeFromStorage } from "./lib/theme"
import "./app.css"

initThemeFromStorage()

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>,
)
