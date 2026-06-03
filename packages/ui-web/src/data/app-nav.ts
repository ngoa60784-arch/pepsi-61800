import {
    LayoutDashboardIcon,
    ContainerIcon,
    GlobeIcon,
    ServerIcon,
    CpuIcon,
    WrenchIcon,
    PlugIcon,
    BrainIcon,
    FileTextIcon,
    MessageSquareIcon,
    type LucideIcon,
} from "lucide-react"

export type AppIcon = LucideIcon

export interface NavItem {
    title: string
    hash: string
    icon: AppIcon
}

export interface ConfigTab {
    value: string
    label: string
    icon: AppIcon
}

export const mainNavItems: NavItem[] = [
    { title: "指挥官", hash: "#/commander", icon: MessageSquareIcon },
    { title: "目标", hash: "#/", icon: LayoutDashboardIcon },
    { title: "运行时", hash: "#/runtime", icon: ContainerIcon },
]

export const configTabs: ConfigTab[] = [
    { value: "host", label: "目标", icon: GlobeIcon },
    { value: "planner", label: "调度器", icon: BrainIcon },
    { value: "providers", label: "提供商", icon: ServerIcon },
    { value: "models", label: "模型", icon: CpuIcon },
    { value: "tools", label: "工具", icon: WrenchIcon },
    { value: "mcp", label: "MCP", icon: PlugIcon },
    { value: "skills", label: "技能", icon: BrainIcon },
    { value: "prompts", label: "提示词", icon: FileTextIcon },
]
