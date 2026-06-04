# tch-agent

Multi-agent collaboration platform for authorized penetration testing: Commander / Planner / Solver / Observer architecture, built on the pi-coding-agent SDK.

## Quick Reference

- **Runtime**: Bun (not Node.js)
- **Package manager**: bun install / bun run
- **Development**: `bun run dev` (Web HMR)
- **Tests**: `bun test` (packages/core)
- **Type checking**: `bun run typecheck`

## Repository Structure

```
packages/
  core/       → @tch/core        Config management, provider/model/tool/skill/prompt registration
  ui-web/     → @tch/ui-web      Web UI + REST API (Bun.serve)
  ui-tui/     → @tch/ui-tui      Terminal UI (Ink)
apps/
  cli/        → @tch/cli         CLI entry (Commander → web/tui mode)
```

## Key Documentation

| Document | Location | Content |
| -------- | ---------------------------------- | ------------------------ |
| Architecture overview | [ARCHITECTURE.md](ARCHITECTURE.md) | Layered architecture, multi-agent collaboration, data flow, deployment references |

## Architecture Layers

```
Types → Config → Service → Runtime → UI
```

Dependencies flow strictly in one direction: UI depends on Runtime → Service → Config → Types. Reverse dependencies are forbidden.

## Config Paths

User configuration is stored in `~/.tch-agent/config/`, including:

- `api-keys.json` — API keys
- `provider-prefs.json` — Provider preferences
- `model-prefs.json` — Model preferences
- `models.json` — SDK model registry (synced from model-prefs)
- `mcp.json` — MCP server configuration
- `prompts/` — Prompt files (YAML frontmatter + Markdown)
- `skills/` — Skill directories

## SDK Dependencies

- `@mariozechner/pi-coding-agent` — Agent session, tool definitions, resource loading
- `@mariozechner/pi-ai` — Model/Api types, provider registry
- `pi-mcp-adapter` — MCP configuration loading

## Bun Preferences

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

### APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$\`ls\` instead of execa.

### Testing

Use `bun test` to run tests.

```ts
import { test, expect } from "bun:test"

test("hello world", () => {
    expect(1).toBe(1)
})
```

### Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Code Style

All code must follow the project conventions below. Non-conforming code must be corrected.

### File Naming

- Files/directories: kebab-case (`api-keys.tsx`, `use-fetch.ts`, `sidebar-data.ts`)
- React component files also use kebab-case (not PascalCase filenames)

### Import Conventions

```ts
// 1. Use `import type` for types, `import` for values — do not mix
import type { ModelConfigEntry, ProviderPrefEntry } from "./providers"
import { ConfigManager } from "./config"

// 2. Use namespace imports for module aggregation
import * as prompts from "./prompts"
import * as mcp from "./mcp"

// 3. Re-export SDK types with `export type`
export type { Skill, ToolDefinition } from "@mariozechner/pi-coding-agent"
```

### Function Style

```ts
// React components: export function declarations (not arrow + export default)
export function ModelsPage() { ... }

// In-component event handlers: async function declarations
async function handleSave() { ... }

// Utility methods/hooks: export function
export function useFetch<T>(fetcher: () => Promise<T>) { ... }

// Do not use export default (components and modules use named exports)
```

### State Management

```ts
// Line-level useState, no state management library
const [name, setName] = useState("")
const [loading, setLoading] = useState(false)

// Data fetching uses the useFetch hook uniformly
const { data: list, loading, reload } = useFetch(models.list)

// Derived state uses const, not additional state
const filtered = list?.filter(...)
```

### Error Handling

- HTTP layer: `if (!res.ok) throw new Error(await res.text())`
- File operations: `try-catch` + null fallback
- Do not add defensive code for impossible scenarios

### TypeScript

- `strict: true`, do not use `any` (except at SDK boundaries)
- Interfaces/types: PascalCase (`ModelConfigEntry`)
- Constants: UPPER_SNAKE_CASE (`DEFAULT_CONFIG_DIR`)
- Variables/functions: camelCase

### UI Components

- Base components under `components/ui/`, CVA variants + Tailwind
- Business components under `components/config/`, one file per config domain
- Styling: Tailwind utility classes, `cn()` for conditional class names
- No inline styles, no CSS modules

### Config File Formats

- JSON: read with `Bun.file().json()`, write with `Bun.write(path, JSON.stringify(data, null, 2))`
- YAML (Prompt frontmatter): parsed with the `yaml` package
- Do not use node:fs readFile/writeFile; use Bun.file
