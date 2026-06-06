import index from "./index.html"

export async function buildUiRoutes(): Promise<Record<string, unknown>> {
    return { "/": index }
}
