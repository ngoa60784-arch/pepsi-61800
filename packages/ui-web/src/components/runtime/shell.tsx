import { RuntimeDetailPage } from "./detail-page"
import { RuntimeListPage } from "./list-page"

export function RuntimeShell() {
    const hash = location.hash || "#/runtime"
    const match = hash.match(/^#\/runtime\/([^/]+)$/)
    if (match?.[1]) return <RuntimeDetailPage solverId={decodeURIComponent(match[1])} />
    return <RuntimeListPage />
}
