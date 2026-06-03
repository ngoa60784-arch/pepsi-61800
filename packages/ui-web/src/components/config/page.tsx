import { ProvidersPage } from "./providers"
import { ModelsPage } from "./models"
import { ToolsPage } from "./tools"
import { SkillsPage } from "./skills"
import { PromptsPage } from "./prompts"
import { McpPage } from "./mcp"
import { HostPage, PlannerPage } from "./host"

const configPages: Record<string, { title: string; component: () => React.JSX.Element }> = {
    host: { title: "目标", component: HostPage },
    planner: { title: "调度器", component: PlannerPage },
    providers: { title: "提供商", component: ProvidersPage },
    models: { title: "模型", component: ModelsPage },
    tools: { title: "工具", component: ToolsPage },
    mcp: { title: "MCP 服务", component: McpPage },
    skills: { title: "技能", component: SkillsPage },
    prompts: { title: "提示词", component: PromptsPage },
}

export function ConfigPage({ activeTab }: { activeTab: string }) {
    const page = configPages[activeTab]
    if (!page) return null
    const Page = page.component
    return (
        <div className="flex flex-1 flex-col gap-4 p-6">
            <h1 className="text-2xl font-bold tracking-tight">{page.title}</h1>
            <Page />
        </div>
    )
}
