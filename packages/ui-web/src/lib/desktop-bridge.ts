const DESKTOP_CLOSE_EVENT = "tch-desktop-close-requested"
const DESKTOP_LISTEN_HOSTS = new Set(["127.0.0.1:38472", "localhost:38472"])

type TauriGlobal = {
    core?: { invoke?: (command: string) => Promise<unknown> }
    event?: { listen?: (event: string, handler: () => void) => Promise<() => void> }
}

function getTauriGlobal(): TauriGlobal | undefined {
    if (typeof window === "undefined") return undefined
    const candidate = (window as Window & { __TAURI__?: TauriGlobal }).__TAURI__
    return candidate
}

export function isDesktopRuntime(): boolean {
    if (typeof window === "undefined") return false
    if ((window as Window & { __TCH_DESKTOP_RUNTIME__?: boolean }).__TCH_DESKTOP_RUNTIME__) return true
    if (DESKTOP_LISTEN_HOSTS.has(window.location.host)) return true
    return Boolean(getTauriGlobal())
}

export async function confirmDesktopExit(): Promise<void> {
    const invoke = getTauriGlobal()?.core?.invoke
    if (invoke) {
        await invoke("desktop_confirm_exit")
        return
    }

    const fallback = (window as Window & { __TCH_DESKTOP__?: { confirmExit?: () => Promise<unknown> } }).__TCH_DESKTOP__
        ?.confirmExit
    if (fallback) {
        await fallback()
        return
    }

    throw new Error("桌面壳未连接，无法退出应用")
}

export function listenDesktopCloseRequest(handler: () => void): () => void {
    const onClose = () => handler()

    window.addEventListener(DESKTOP_CLOSE_EVENT, onClose)

    let tauriUnlisten = () => {}
    const tauriListen = getTauriGlobal()?.event?.listen
    if (tauriListen) {
        void tauriListen("desktop-close-requested", onClose).then((dispose) => {
            tauriUnlisten = dispose
        })
    }

    return () => {
        window.removeEventListener(DESKTOP_CLOSE_EVENT, onClose)
        tauriUnlisten()
    }
}
