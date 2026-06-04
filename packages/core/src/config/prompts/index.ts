import { resolve, basename } from "path"
import { readdir, mkdir, unlink } from "fs/promises"
import { existsSync } from "fs"
import { parseFrontmatter, stripFrontmatter, createSyntheticSourceInfo } from "@mariozechner/pi-coding-agent"
import type { PromptTemplate } from "@mariozechner/pi-coding-agent"
import { BUILTIN_PROMPTS } from "../builtin-assets.generated"

export const CHALLENGE_PLANNER_PROMPT_NAME = "CHALLENGE_PLANNER"
export const OBJECTIVE_VERIFIER_PROMPT_NAME = "OBJECTIVE_VERIFIER"
export const KALI_PROVISIONER_PROMPT_NAME = "KALI_PROVISIONER"

export interface PromptMeta {
    description?: string
    model?: string // model-pref short ID
    observerEnabled?: boolean
    observerModel?: string // observer-specific model-pref short ID
    disabled?: boolean
    mcps?: string[] // list of enabled mcp server names; whitelist mode, empty means all disabled
    tools?: string[] // list of enabled tool names
    skills?: string[] // list of enabled skill names
    subagents?: string[] // list of subagent prompt names allowed to be invoked
    isSubagent?: boolean // whether this is a subagent-only prompt
    [key: string]: unknown
}

export interface PromptFile {
    name: string
    meta: PromptMeta
    /** Markdown body = system prompt */
    content: string
    builtin?: boolean
    deleted?: boolean // for deleted builtins
}

function normalizePromptMetaModelId(value: unknown): string | undefined {
    if (typeof value === "string") {
        const text = value.trim()
        return text || undefined
    }
    if (typeof value === "number" || typeof value === "bigint") {
        return String(value)
    }
    return undefined
}

function formatYamlScalar(value: unknown): string {
    if (typeof value === "string") return JSON.stringify(value)
    if (typeof value === "number" || typeof value === "bigint") return String(value)
    return JSON.stringify(String(value))
}

function normalizePromptMeta(meta: PromptMeta): PromptMeta {
    const tools = meta.tools ?? []
    const skills = meta.skills ?? []
    const nextTools = skills.length > 0 && !tools.includes("read") ? ["read", ...tools] : tools
    const model = normalizePromptMetaModelId(meta.model)
    const observerModel = normalizePromptMetaModelId(meta.observerModel)

    return {
        ...meta,
        ...(model ? { model } : { model: undefined }),
        ...(observerModel ? { observerModel } : { observerModel: undefined }),
        ...(nextTools.length > 0 ? { tools: nextTools } : { tools: undefined }),
    }
}

// ── paths ──

function promptsDir(configDir: string) {
    return resolve(configDir, "prompts")
}

function promptPath(configDir: string, name: string) {
    return resolve(promptsDir(configDir), `${name}.md`)
}

// ── Builtin release ──

/** Record file of deleted built-in prompts */
function deletedBuiltinsPath(configDir: string) {
    return resolve(promptsDir(configDir), ".deleted-builtins.json")
}

async function loadDeletedBuiltins(configDir: string): Promise<Set<string>> {
    const file = Bun.file(deletedBuiltinsPath(configDir))
    if (!(await file.exists())) return new Set()
    try {
        const arr = await file.json()
        return new Set(Array.isArray(arr) ? arr : [])
    } catch {
        return new Set()
    }
}

async function saveDeletedBuiltins(configDir: string, deleted: Set<string>): Promise<void> {
    await Bun.write(deletedBuiltinsPath(configDir), JSON.stringify([...deleted], null, 2))
}

/** Overwrite one built-in prompt from repo (used so KALI_PROVISIONER stays in sync after upgrades). */
export async function refreshBuiltinPrompt(configDir: string, name: string): Promise<void> {
    const entry = `${name}.md`
    const builtinPrompts = BUILTIN_PROMPTS as unknown as Record<string, string>
    const sourcePath = builtinPrompts[entry]
    if (!sourcePath) return
    const deleted = await loadDeletedBuiltins(configDir)
    if (deleted.has(name)) return
    await mkdir(promptsDir(configDir), { recursive: true })
    await Bun.write(promptPath(configDir, name), Bun.file(sourcePath))
}

/** Release the built-in prompts into the user's config directory (skipping ones the user has deleted) */
export async function initBuiltinPrompts(configDir: string) {
    const destDir = promptsDir(configDir)
    await mkdir(destDir, { recursive: true })

    const deleted = await loadDeletedBuiltins(configDir)
    const builtinPrompts = BUILTIN_PROMPTS as unknown as Record<string, string>

    for (const [entry, sourcePath] of Object.entries(builtinPrompts)) {
        const name = basename(entry, ".md")
        if (deleted.has(name)) continue
        const dest = resolve(destDir, entry)
        if (existsSync(dest)) continue
        await Bun.write(dest, Bun.file(sourcePath))
    }
}

/** Check whether a prompt is built-in */
function isBuiltin(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(BUILTIN_PROMPTS, `${name}.md`)
}

// ── CRUD ──

export async function loadPrompt(configDir: string, name: string): Promise<PromptFile | undefined> {
    const file = Bun.file(promptPath(configDir, name))
    if (!(await file.exists())) return undefined
    const raw = await file.text()
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(raw)
    const meta = normalizePromptMeta((frontmatter ?? {}) as PromptMeta)
    const content = stripFrontmatter(raw).trim()
    return { name, meta, content, builtin: isBuiltin(name) }
}

export async function savePrompt(configDir: string, prompt: PromptFile): Promise<void> {
    const dir = promptsDir(configDir)
    await mkdir(dir, { recursive: true })
    const meta: PromptMeta = normalizePromptMeta(
        prompt.meta.isSubagent === true
            ? {
                  ...prompt.meta,
                  subagents: undefined,
              }
            : prompt.meta,
    )

    const yamlLines: string[] = []
    for (const [k, v] of Object.entries(meta)) {
        if (v === undefined) continue
        if (k === "mcps" || k === "tools" || k === "skills" || k === "subagents") {
            // YAML array format
            const arr = v as string[]
            if (arr.length > 0) {
                yamlLines.push(`${k}:`)
                for (const item of arr) yamlLines.push(`  - ${formatYamlScalar(item)}`)
            } else if (k === "mcps") {
                yamlLines.push("mcps: []")
            }
        } else if (typeof v === "boolean") {
            yamlLines.push(`${k}: ${v ? "true" : "false"}`)
        } else {
            yamlLines.push(`${k}: ${formatYamlScalar(v)}`)
        }
    }
    const output = `---\n${yamlLines.join("\n")}\n---\n\n${prompt.content}\n`
    await Bun.write(promptPath(configDir, prompt.name), output)
}

export async function removePrompt(configDir: string, name: string): Promise<void> {
    const path = promptPath(configDir, name)
    if (existsSync(path)) await unlink(path)
    // If it's a built-in prompt, record the deletion to prevent it from being restored after restart
    if (isBuiltin(name)) {
        const deleted = await loadDeletedBuiltins(configDir)
        deleted.add(name)
        await saveDeletedBuiltins(configDir, deleted)
    }
}

export async function listPrompts(configDir: string): Promise<PromptFile[]> {
    const dir = promptsDir(configDir)
    let results: PromptFile[] = []
    try {
        const entries = await readdir(dir)
        const mdFiles = entries.filter((f) => f.endsWith(".md"))
        for (const file of mdFiles) {
            const name = basename(file, ".md")
            const prompt = await loadPrompt(configDir, name)
            if (prompt && prompt.name !== CHALLENGE_PLANNER_PROMPT_NAME && prompt.name !== OBJECTIVE_VERIFIER_PROMPT_NAME) results.push(prompt)
        }
    } catch {}

    // Add deleted builtins for restore UX
    const deleted = await loadDeletedBuiltins(configDir)
    for (const name of deleted) {
        // Only if not present in results (not restored yet)
        if (name !== CHALLENGE_PLANNER_PROMPT_NAME && name !== OBJECTIVE_VERIFIER_PROMPT_NAME && !results.some((p) => p.name === name)) {
            results.push({
                name,
                meta: {},
                content: "",
                builtin: true,
                deleted: true,
            })
        }
    }
    return results
}

export async function listAgentPrompts(configDir: string): Promise<PromptFile[]> {
    const prompts = await listPrompts(configDir)
    return prompts.filter((prompt) => prompt.meta.isSubagent !== true)
}

export async function listSubagentPrompts(configDir: string): Promise<PromptFile[]> {
    const prompts = await listPrompts(configDir)
    return prompts.filter((prompt) => prompt.meta.isSubagent === true)
}

// ── SDK conversion ──

/** Convert to an SDK PromptTemplate (used by createAgentSession) */
export function toPromptTemplate(prompt: PromptFile): PromptTemplate {
    return {
        name: prompt.name,
        description: prompt.meta.description ?? prompt.name,
        content: prompt.content,
        filePath: `/prompts/${prompt.name}.md`,
        sourceInfo: createSyntheticSourceInfo(`/prompts/${prompt.name}.md`, { source: "tch-agent" }),
    }
}
