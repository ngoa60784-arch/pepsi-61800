import { ProvidersPage } from "./providers"
import { ModelsPage } from "./models"
import { ToolsPage } from "./tools"
import { SkillsPage } from "./skills"
import { PromptsPage } from "./prompts"
import { McpPage } from "./mcp"
import { PlannerPage } from "./host"

const configPages: Record<string, { title: string; component: () => React.JSX.Element }> = {
    planner: { title: "调度器", component: PlannerPage },
    providers: { title: "提供商", component: ProvidersPage },
    models: { title: "模型", component: ModelsPage },
    tools: { title: "工具", component: ToolsPage },
    mcp: { title: "MCP 服务", component: McpPage },
    skills: { title: "技能", component: SkillsPage },
    prompts: { title: "提示词", component: PromptsPage },
}

export function ConfigPage({ activeTab }: { activeTab: string }) {
    const page = configPages[activeTab] ?? configPages.providers
    const Page = page.component
    return (
        <div className="page-shell">
            <h1 className="page-title">{page.title}</h1>
            <Page />
        </div>
    )
}
