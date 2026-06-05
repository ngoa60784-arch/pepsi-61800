import { Component, useEffect, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import {
    BotIcon,
    ChevronRightIcon,
    XIcon,
    SettingsIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupLabel,
    SidebarGroupContent,
    SidebarHeader,
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
import { RuntimeShell } from "./components/runtime/shell"
import { Input } from "./components/ui/input"
import { Button } from "./components/ui/button"
import { auth, planner } from "./lib/api"
import type { PlannerHealth } from "./lib/api"
import { Badge } from "./components/ui/badge"
import { configTabs, mainNavItems } from "./data/app-nav"

function IosNavIcon({ icon: Icon }: { icon: LucideIcon }) {
    return (
        <span className="ios-nav-icon">
            <Icon className="size-4" strokeWidth={2.25} />
        </span>
    )
}

function useHash() {
    const [hash, setHash] = useState(location.hash || "#/")
    useEffect(() => {
        const onHash = () => setHash(location.hash || "#/")
        window.addEventListener("hashchange", onHash)
        return () => window.removeEventListener("hashchange", onHash)
    }, [])
    return hash
}

function usePlannerHealthPoll() {
    const [health, setHealth] = useState<PlannerHealth | null>(null)

    useEffect(() => {
        let cancelled = false

        async function loadPlannerHealth() {
            try {
                const next = await planner.health()
                if (!cancelled) setHealth(next)
            } catch {
                if (!cancelled) setHealth(null)
            }
        }

        void loadPlannerHealth()
        const timer = setInterval(() => void loadPlannerHealth(), 15_000)
        return () => {
            cancelled = true
            clearInterval(timer)
        }
    }, [])

    return health
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
    const challengeMatch = hash.match(/^#\/challenge\/([^/]+)$/)

    useEffect(() => {
        const legacy = hash.match(/^#\/challenge\/([^/]+)\/attack-flow$/)
        if (legacy) location.replace(`#/challenge/${legacy[1]}`)
    }, [hash])

    if (hash === "#/runtime" || hash.startsWith("#/runtime/")) return <RuntimeShell />
    if (hash === "#/commander") return <CommanderPage />
    if (hash.match(/^#\/challenge\/[^/]+\/attack-flow$/)) return null
    if (challengeMatch) return <ChallengePage challengeId={decodeURIComponent(challengeMatch[1])} />
    if (hash.startsWith("#/config/")) {
        const tab = hash.replace("#/config/", "")
        return <ConfigPage activeTab={tab} />
    }
    if (hash === "#/config") return <ConfigPage activeTab="providers" />
    return <ChallengePage />
}

function getPageTitle(hash: string): string {
    if (hash === "#/commander") return "指挥官"
    if (hash === "#/" || hash === "#/challenge") return "目标"
    if (hash.startsWith("#/challenge/")) return "目标"
    if (hash === "#/runtime") return "运行时"
    if (hash.startsWith("#/runtime/")) return "运行时 · Solver"
    if (hash.startsWith("#/config")) {
        const tab = hash.replace("#/config/", "")
        const found = configTabs.find((t) => t.value === tab)
        return found ? `配置 · ${found.label}` : "配置"
    }
    return "目标"
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
        <div className="flex h-screen items-center justify-center bg-background p-6">
            <form
                onSubmit={handleSubmit}
                className="w-full max-w-sm space-y-4 rounded-2xl bg-card p-6 ring-1 ring-border/60"
            >
                <div className="space-y-1">
                    <div className="flex items-center gap-2 text-base font-semibold">
                        <BotIcon className="size-5 text-primary" />
                        tch-agent
                    </div>
                    <div className="text-sm text-muted-foreground">请输入访问令牌（TCH_AUTH_TOKEN）</div>
                </div>
                <Input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="访问令牌" autoFocus />
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
    const isOnConfigRoute = hash.startsWith("#/config")
    const [configMenuExpanded, setConfigMenuExpanded] = useState(isOnConfigRoute)
    const { error, clearError } = useGlobalUiError()
    const [authState, markAuthed] = useAuthGate()
    const plannerHealth = usePlannerHealthPoll()

    useEffect(() => {
        if (isOnConfigRoute) setConfigMenuExpanded(true)
    }, [isOnConfigRoute])

    function handleConfigMenuClick() {
        if (configMenuExpanded) {
            setConfigMenuExpanded(false)
            return
        }
        setConfigMenuExpanded(true)
        if (!isOnConfigRoute) location.hash = "#/config/providers"
    }

    if (authState === "loading") {
        return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">加载中…</div>
    }
    if (authState === "need-login") {
        return <LoginScreen onSuccess={markAuthed} />
    }

    return (
        <SidebarProvider className="bg-background">
            {error && (
                <div className="fixed top-4 left-1/2 z-50 flex w-[min(720px,calc(100vw-2rem))] -translate-x-1/2 items-start justify-between gap-3 rounded-2xl bg-card/95 px-4 py-3 text-sm text-destructive ring-1 ring-border/80 backdrop-blur-xl backdrop-saturate-150">
                    <span className="min-w-0 flex-1 break-words">{error}</span>
                    <button type="button" onClick={clearError} className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
                        <XIcon className="size-4" />
                    </button>
                </div>
            )}
            <Sidebar className="ios-sidebar">
                <SidebarHeader className="border-b border-border/50 px-4 py-4">
                    <div className="flex items-center gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-[0.7rem] bg-gradient-to-b from-primary to-primary/80 text-primary-foreground shadow-sm">
                            <BotIcon className="size-5" strokeWidth={2.25} />
                        </div>
                        <div className="min-w-0">
                            <p className="text-[0.8125rem] font-semibold leading-snug break-words" title="Fuck-the-White-House.">
                                Fuck-the-White-House.
                            </p>
                            <p className="text-[0.8125rem] text-muted-foreground">渗透指挥台</p>
                        </div>
                    </div>
                </SidebarHeader>
                <SidebarContent className="gap-5 px-3 py-4">
                    <SidebarGroup className="p-0">
                        <SidebarGroupLabel className="mb-1.5 px-3 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
                            功能
                        </SidebarGroupLabel>
                        <div className="ios-sidebar-inset">
                            <SidebarGroupContent className="p-0">
                                <SidebarMenu className="gap-0">
                                    {mainNavItems.map((item) => (
                                        <SidebarMenuItem key={item.hash}>
                                            <SidebarMenuButton
                                                className="ios-sidebar-row"
                                                render={<a href={item.hash} />}
                                                isActive={hash === item.hash}
                                            >
                                                <IosNavIcon icon={item.icon} />
                                                <span className="font-medium">{item.title}</span>
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                    ))}
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </div>
                    </SidebarGroup>

                    <SidebarGroup className="p-0">
                        <SidebarGroupLabel className="mb-1.5 px-3 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
                            设置
                        </SidebarGroupLabel>
                        <div className="ios-sidebar-inset">
                            <SidebarGroupContent className="p-0">
                                <SidebarMenu className="gap-0">
                                    <SidebarMenuItem>
                                        <SidebarMenuButton
                                            type="button"
                                            className="ios-sidebar-row"
                                            onClick={handleConfigMenuClick}
                                            isActive={isOnConfigRoute && !configMenuExpanded}
                                        >
                                            <IosNavIcon icon={SettingsIcon} />
                                            <span className="font-medium">配置</span>
                                            <ChevronRightIcon
                                                className={`ml-auto size-4 text-muted-foreground transition-transform duration-200 ${configMenuExpanded ? "rotate-90" : ""}`}
                                            />
                                        </SidebarMenuButton>
                                        {configMenuExpanded && (
                                            <SidebarMenuSub className="ios-sidebar-sub">
                                                {configTabs.map((tab) => (
                                                    <SidebarMenuSubItem key={tab.value}>
                                                        <SidebarMenuSubButton
                                                            className="ios-sidebar-sub-row"
                                                            render={<a href={`#/config/${tab.value}`} />}
                                                            isActive={hash === `#/config/${tab.value}`}
                                                        >
                                                            <tab.icon className="size-4 text-muted-foreground" strokeWidth={2} />
                                                            <span>{tab.label}</span>
                                                        </SidebarMenuSubButton>
                                                    </SidebarMenuSubItem>
                                                ))}
                                            </SidebarMenuSub>
                                        )}
                                    </SidebarMenuItem>
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </div>
                    </SidebarGroup>
                </SidebarContent>
            </Sidebar>
            <SidebarInset className="h-screen min-h-0 min-w-0 overflow-hidden bg-background">
                <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 backdrop-blur-xl backdrop-saturate-150 supports-[backdrop-filter]:bg-background/72">
                    <SidebarTrigger className="rounded-lg" />
                    <Separator orientation="vertical" className="h-4 opacity-60" />
                    <span className="text-[1.0625rem] font-semibold tracking-tight">{getPageTitle(hash)}</span>
                    {plannerHealth?.alerting ? (
                        <Badge variant="destructive" className="ml-auto shrink-0">
                            调度器异常
                        </Badge>
                    ) : null}
                </header>
                <div className="min-h-0 min-w-0 flex-1 overflow-auto">
                    <AppErrorBoundary>
                        <Router />
                    </AppErrorBoundary>
                </div>
            </SidebarInset>
        </SidebarProvider>
    )
}
