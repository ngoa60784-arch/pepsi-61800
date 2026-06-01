import { Component, useEffect, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import {
    BotIcon,
    ChevronRightIcon,
    XIcon,
    SettingsIcon,
} from "lucide-react"
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupLabel,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuItem,
    SidebarMenuButton,
    SidebarMenuSub,
    SidebarMenuSubItem,
    SidebarMenuSubButton,
    SidebarProvider,
    SidebarInset,
    SidebarTrigger,
} from "./components/ui/sidebar"
import { Separator } from "./components/ui/separator"
import { ConfigPage } from "./components/config/page"
import { ChallengePage } from "./components/challenge/page"
import { CommanderPage } from "./components/commander/page"
import { AttackFlowPage } from "./components/challenge/attack-flow"
import { RuntimeShell } from "./components/runtime/shell"
import { Input } from "./components/ui/input"
import { Button } from "./components/ui/button"
import { auth } from "./lib/api"
import { configTabs, mainNavItems } from "./data/app-nav"

function useHash() {
    const [hash, setHash] = useState(location.hash || "#/")
    useEffect(() => {
        const onHash = () => setHash(location.hash || "#/")
        window.addEventListener("hashchange", onHash)
        return () => window.removeEventListener("hashchange", onHash)
    }, [])
    return hash
}

function getErrorMessage(error: unknown) {
    if (error instanceof Error) return error.message
    return String(error)
}

function isIgnoredGlobalUiError(error: unknown) {
    const message = getErrorMessage(error)
    return message.includes("ResizeObserver loop completed with undelivered notifications") || message.includes("ResizeObserver loop limit exceeded")
}

function useGlobalUiError() {
    const [error, setError] = useState("")

    useEffect(() => {
        function handleRejection(event: PromiseRejectionEvent) {
            if (isIgnoredGlobalUiError(event.reason)) {
                event.preventDefault()
                return
            }
            event.preventDefault()
            setError(getErrorMessage(event.reason))
        }

        function handleError(event: ErrorEvent) {
            if (isIgnoredGlobalUiError(event.error ?? event.message)) {
                event.preventDefault()
                event.stopImmediatePropagation()
                return
            }
            event.preventDefault()
            setError(event.error ? getErrorMessage(event.error) : event.message)
        }

        window.addEventListener("unhandledrejection", handleRejection, true)
        window.addEventListener("error", handleError, true)
        return () => {
            window.removeEventListener("unhandledrejection", handleRejection, true)
            window.removeEventListener("error", handleError, true)
        }
    }, [])

    return { error, clearError: () => setError("") }
}

interface AppErrorBoundaryProps {
    children: ReactNode
}

interface AppErrorBoundaryState {
    error: string
}

class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
    state: AppErrorBoundaryState = { error: "" }

    static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
        return { error: getErrorMessage(error) }
    }

    render() {
        if (this.state.error) {
            return (
                <div className="flex flex-1 items-start justify-center p-6">
                    <div className="w-full max-w-2xl rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-500">
                        {this.state.error}
                    </div>
                </div>
            )
        }
        return this.props.children
    }
}

function Router() {
    const hash = useHash()
    const attackFlowMatch = hash.match(/^#\/challenge\/([^/]+)\/attack-flow$/)
    const challengeMatch = hash.match(/^#\/challenge\/([^/]+)$/)
    if (hash === "#/runtime" || hash.startsWith("#/runtime/")) return <RuntimeShell />
    if (hash === "#/commander") return <CommanderPage />
    if (attackFlowMatch) return <AttackFlowPage challengeId={decodeURIComponent(attackFlowMatch[1])} />
    if (challengeMatch) return <ChallengePage challengeId={decodeURIComponent(challengeMatch[1])} />
    if (hash.startsWith("#/config/")) {
        const tab = hash.replace("#/config/", "")
        return <ConfigPage activeTab={tab} />
    }
    if (hash === "#/config") return <ConfigPage activeTab="providers" />
    return <ChallengePage />
}

function getPageTitle(hash: string): string {
    if (hash === "#/commander") return "Commander"
    if (hash === "#/" || hash === "#/challenge") return "Challenge"
    if (hash.startsWith("#/challenge/") && hash.endsWith("/attack-flow")) return "Challenge · Attack Flow"
    if (hash.startsWith("#/challenge/")) return "Challenge"
    if (hash === "#/runtime") return "Runtime"
    if (hash.startsWith("#/runtime/")) return "Runtime · Solver"
    if (hash.startsWith("#/config")) {
        const tab = hash.replace("#/config/", "")
        const found = configTabs.find((t) => t.value === tab)
        return found ? `Config · ${found.label}` : "Configuration"
    }
    return "Challenge"
}

type AuthState = "loading" | "need-login" | "ok"

function useAuthGate(): [AuthState, () => void] {
    const [state, setState] = useState<AuthState>("loading")
    useEffect(() => {
        auth.status()
            .then((s) => setState(!s.authRequired || s.authed ? "ok" : "need-login"))
            // status 端点本身不鉴权；查询失败时放行，避免把人锁在门外。
            .catch(() => setState("ok"))
    }, [])
    return [state, () => setState("ok")]
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
    const [token, setToken] = useState("")
    const [error, setError] = useState("")
    const [busy, setBusy] = useState(false)

    async function handleSubmit(event: FormEvent) {
        event.preventDefault()
        setBusy(true)
        setError("")
        try {
            await auth.login(token.trim())
            onSuccess()
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="flex h-screen items-center justify-center p-6">
            <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 rounded-lg border p-6 shadow-sm">
                <div className="space-y-1">
                    <div className="flex items-center gap-2 text-base font-semibold">
                        <BotIcon className="size-5" />
                        tch-agent
                    </div>
                    <div className="text-sm text-muted-foreground">请输入访问令牌（TCH_AUTH_TOKEN）</div>
                </div>
                <Input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="access token" autoFocus />
                {error && <div className="text-sm text-red-500">{error}</div>}
                <Button type="submit" className="w-full" disabled={busy || !token.trim()}>
                    {busy ? "验证中…" : "登录"}
                </Button>
            </form>
        </div>
    )
}

export function App() {
    const hash = useHash()
    const isConfigOpen = hash.startsWith("#/config")
    const isAttackFlowRoute = /^#\/challenge\/[^/]+\/attack-flow$/.test(hash)
    const { error, clearError } = useGlobalUiError()
    const [authState, markAuthed] = useAuthGate()

    if (authState === "loading") {
        return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">加载中…</div>
    }
    if (authState === "need-login") {
        return <LoginScreen onSuccess={markAuthed} />
    }

    return (
        <SidebarProvider>
            {error && (
                <div className="fixed top-4 left-1/2 z-50 flex w-[min(720px,calc(100vw-2rem))] -translate-x-1/2 items-start justify-between gap-3 rounded-lg border border-red-500/30 bg-background/95 px-4 py-3 text-sm text-red-500 shadow-lg backdrop-blur">
                    <span className="min-w-0 flex-1 break-words">{error}</span>
                    <button type="button" onClick={clearError} className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
                        <XIcon className="size-4" />
                    </button>
                </div>
            )}
            <Sidebar>
                <SidebarContent>
                    <SidebarGroup>
                        <SidebarGroupLabel className="gap-2">
                            <BotIcon className="size-4" />
                            tch-agent
                        </SidebarGroupLabel>
                        <SidebarGroupContent>
                            <SidebarMenu>
                                {/* Main nav items */}
                                {mainNavItems.map((item) => (
                                    <SidebarMenuItem key={item.hash}>
                                        <SidebarMenuButton render={<a href={item.hash} />} isActive={hash === item.hash}>
                                            <item.icon className="size-4" />
                                            <span>{item.title}</span>
                                        </SidebarMenuButton>
                                    </SidebarMenuItem>
                                ))}

                                {/* Config section with sub-items */}
                                <SidebarMenuItem>
                                    <SidebarMenuButton render={<a href="#/config/providers" />} isActive={isConfigOpen}>
                                        <SettingsIcon className="size-4" />
                                        <span>Config</span>
                                        <ChevronRightIcon className={`ml-auto size-4 transition-transform ${isConfigOpen ? "rotate-90" : ""}`} />
                                    </SidebarMenuButton>
                                    {isConfigOpen && (
                                        <SidebarMenuSub>
                                            {configTabs.map((tab) => (
                                                <SidebarMenuSubItem key={tab.value}>
                                                    <SidebarMenuSubButton render={<a href={`#/config/${tab.value}`} />} isActive={hash === `#/config/${tab.value}`}>
                                                        <tab.icon className="size-3.5" />
                                                        <span>{tab.label}</span>
                                                    </SidebarMenuSubButton>
                                                </SidebarMenuSubItem>
                                            ))}
                                        </SidebarMenuSub>
                                    )}
                                </SidebarMenuItem>
                            </SidebarMenu>
                        </SidebarGroupContent>
                    </SidebarGroup>
                </SidebarContent>
            </Sidebar>
            <SidebarInset className="h-screen min-h-0 min-w-0 overflow-hidden">
                <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
                    <SidebarTrigger />
                    <Separator orientation="vertical" className="h-4" />
                    <span className="text-sm font-medium">{getPageTitle(hash)}</span>
                </header>
                <div className={isAttackFlowRoute ? "min-h-0 min-w-0 flex-1 overflow-hidden" : "min-h-0 min-w-0 flex-1 overflow-auto"}>
                    <AppErrorBoundary>
                        <Router />
                    </AppErrorBoundary>
                </div>
            </SidebarInset>
        </SidebarProvider>
    )
}
