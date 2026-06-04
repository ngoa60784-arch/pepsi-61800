import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import {
    bashTool,
    readTool,
    editTool,
    writeTool,
    grepTool,
    findTool,
    lsTool,
    bashToolDefinition,
    readToolDefinition,
    editToolDefinition,
    writeToolDefinition,
    grepToolDefinition,
    findToolDefinition,
    lsToolDefinition,
} from "@mariozechner/pi-coding-agent"
import { allEngagementTools } from "./engagement-tools"
import { securityKimiSearchTool } from "./security-kimi-search"

// ── Custom tools ──

/** All custom tool definitions */
export const customTools: ToolDefinition[] = [securityKimiSearchTool, ...allEngagementTools]

// ── SDK built-in tools ──

/** All built-in tool definitions (used to register into registeredTools) */
export const builtinToolDefinitions: Array<ToolDefinition<any, any, any>> = [
    bashToolDefinition,
    readToolDefinition,
    editToolDefinition,
    writeToolDefinition,
    grepToolDefinition,
    findToolDefinition,
    lsToolDefinition,
]

/** Built-in tool runtime instances (used for CreateAgentSessionOptions.tools) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const builtinToolMap: Record<string, any> = {
    read: readTool,
    bash: bashTool,
    edit: editTool,
    write: writeTool,
    grep: grepTool,
    find: findTool,
    ls: lsTool,
}

/** Tool summary for UI display */
export interface ToolEntry {
    name: string
    label: string
    description: string
    source: string
    parameters?: Record<string, unknown>
    /** Name of the server this MCP tool belongs to */
    server?: string
    /** Whether the MCP tool is registered in direct mode (false = proxy) */
    direct?: boolean
}
