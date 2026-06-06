use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use url::Url;

use tauri::{
    async_runtime::Receiver, AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_shell::process::{Command, CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DESKTOP_LISTEN: &str = "127.0.0.1:38472";
const LOOPBACK_PROXY_BYPASS: &str = "127.0.0.1,localhost,::1";
const SERVER_WAIT_TIMEOUT: Duration = Duration::from_secs(120);
const DESKTOP_CLOSE_EVENT_JS: &str =
    "window.dispatchEvent(new CustomEvent('tch-desktop-close-requested'));";
const DESKTOP_RUNTIME_BRIDGE_JS: &str = "window.__TCH_DESKTOP_RUNTIME__ = true;";

struct SidecarState {
    child: Mutex<Option<CommandChild>>,
}

struct ClosePromptState {
    last_prompt_at: Mutex<Option<Instant>>,
}

/// WebKit / system HTTP proxy (Clash 等) 会把 127.0.0.1 走代理 → 502，页面只剩主题底色（用户称「蓝屏」）。
fn ensure_loopback_no_proxy() {
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        std::env::remove_var(key);
    }
    for key in ["NO_PROXY", "no_proxy"] {
        match std::env::var(key) {
            Ok(existing) => {
                let needs_bypass = !existing
                    .split(',')
                    .any(|host| matches!(host.trim(), "127.0.0.1" | "localhost" | "::1"));
                if needs_bypass {
                    std::env::set_var(key, format!("{LOOPBACK_PROXY_BYPASS},{existing}"));
                }
            }
            Err(_) => std::env::set_var(key, LOOPBACK_PROXY_BYPASS),
        }
    }
}

fn window_hosts_sidecar(window: &tauri::WebviewWindow) -> bool {
    let Ok(url) = window.url() else {
        return false;
    };
    hosts_sidecar_url(&url)
}

fn hosts_sidecar_url(url: &Url) -> bool {
    matches!(url.host_str(), Some("127.0.0.1") | Some("localhost")) && url.port() == Some(38472)
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn resolve_bun_executable() -> PathBuf {
    if let Ok(path) = std::env::var("BUN_EXECUTABLE") {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return candidate;
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        let candidate = PathBuf::from(&home).join(".bun/bin/bun");
        if candidate.is_file() {
            return candidate;
        }
    }

    PathBuf::from("bun")
}

fn shell_path_with_bun(bun: &Path) -> String {
    let bun_dir = bun
        .parent()
        .map(|dir| dir.display().to_string())
        .unwrap_or_else(|| "/usr/local/bin".to_string());
    format!("{bun_dir}:/usr/local/bin:/usr/bin:/bin")
}

fn spawn_bun_sidecar(
    shell: &tauri_plugin_shell::Shell<tauri::Wry>,
) -> Result<(Receiver<CommandEvent>, CommandChild), String> {
    let bun = resolve_bun_executable();
    let root = project_root();
    let path = shell_path_with_bun(&bun);

    shell
        .command("bun")
        .args([
            "run",
            "apps/cli/src/main.ts",
            "web",
            "-l",
            DESKTOP_LISTEN,
        ])
        .current_dir(root)
        .env("PATH", path)
        .env("TCH_DESKTOP", "1")
        .env("NO_PROXY", "127.0.0.1,localhost")
        .env("no_proxy", "127.0.0.1,localhost")
        .spawn()
        .map_err(|error| format!("failed to spawn bun dev sidecar: {error}"))
}

fn apply_desktop_env(command: Command) -> Command {
    command
        .env("TCH_DESKTOP", "1")
        .env("NO_PROXY", "127.0.0.1,localhost")
        .env("no_proxy", "127.0.0.1,localhost")
}

fn free_desktop_listen_port() {
    let _ = std::process::Command::new("/usr/bin/pkill")
        .args(["-f", "tch-agent web -l 127.0.0.1:38472"])
        .status();
    std::thread::sleep(Duration::from_millis(400));
}

fn spawn_sidecar(app: &AppHandle) -> Result<(Receiver<CommandEvent>, CommandChild), String> {
    free_desktop_listen_port();
    let shell = app.shell();
    let args = ["web", "-l", DESKTOP_LISTEN];
    #[cfg(not(debug_assertions))]
    let try_compiled = true;
    #[cfg(debug_assertions)]
    let try_compiled = std::env::var("TCH_DESKTOP_SIDECAR").as_deref() == Ok("compiled");

    if try_compiled {
        if let Ok(command) = shell.sidecar("tch-agent") {
            if let Ok(pair) = apply_desktop_env(command.args(args)).spawn() {
                return Ok(pair);
            }
        }
    }

    spawn_bun_sidecar(shell)
}

fn drain_sidecar_events(mut rx: Receiver<CommandEvent>) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    eprintln!("[sidecar] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[sidecar:err] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Error(message) => {
                    eprintln!("[sidecar:error] {message}");
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!(
                        "[sidecar] exited code={:?} signal={:?}",
                        payload.code, payload.signal
                    );
                }
                _ => {}
            }
        }
    });
}

fn wait_for_server(addr: &str, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if std::net::TcpStream::connect(addr).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

fn probe_sidecar_http(addr: &str) -> bool {
    let mut stream = match std::net::TcpStream::connect(addr) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    if stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .is_err()
    {
        return false;
    }
    if stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .is_err()
    {
        return false;
    }

    let request = format!("GET / HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut buf = [0u8; 16];
    match stream.read(&mut buf) {
        Ok(0) => false,
        Ok(_) => buf.starts_with(b"HTTP/1.1 2") || buf.starts_with(b"HTTP/1.0 2"),
        Err(_) => false,
    }
}

fn show_loading_error(app: &AppHandle, message: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let escaped = message
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', "\\n");
    let script = format!(
        "(() => {{ const main = document.querySelector('main'); if (!main) return; main.innerHTML = '<p style=\"color:#f87171;line-height:1.6\">{escaped}</p><button type=\"button\" id=\"exit-btn\">退出应用</button>'; const btn = document.getElementById('exit-btn'); const invoke = window.__TAURI__?.core?.invoke; if (btn && invoke) btn.onclick = () => invoke('desktop_confirm_exit').catch(() => {{}}); }})();"
    );
    if let Err(error) = window.eval(&script) {
        eprintln!("[desktop] failed to show loading error: {error}");
    }
}

fn kill_sidecar(app: &AppHandle) {
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut guard) = state.child.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.show();
    }
}

fn create_loading_window(app: &AppHandle) -> Result<(), String> {
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("BreachWeave")
        .inner_size(1280.0, 800.0)
        .resizable(true)
        .decorations(true)
        .build()
        .map_err(|error| format!("failed to create loading window: {error}"))?;

    Ok(())
}

fn inject_desktop_runtime(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Err(error) = window.eval(DESKTOP_RUNTIME_BRIDGE_JS) {
        eprintln!("[desktop] failed to inject runtime bridge: {error}");
    }
}

fn force_exit(app: &AppHandle) {
    kill_sidecar(app);
    app.exit(0);
}

fn prompt_close_dialog(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        force_exit(app);
        return;
    };

    if !window_hosts_sidecar(&window) {
        force_exit(app);
        return;
    }

    let now = Instant::now();
    let mut should_force = false;
    if let Some(state) = app.try_state::<ClosePromptState>() {
        if let Ok(mut guard) = state.last_prompt_at.lock() {
            if let Some(last) = *guard {
                should_force = now.duration_since(last) < Duration::from_secs(2);
            }
            *guard = Some(now);
        }
    }

    if should_force {
        eprintln!("[desktop] repeated close request — forcing exit");
        force_exit(app);
        return;
    }

    if let Err(error) = window.eval(DESKTOP_CLOSE_EVENT_JS) {
        eprintln!("[desktop] failed to open in-app close dialog: {error}");
        force_exit(app);
        return;
    }
    let _ = window.emit("desktop-close-requested", ());
}

fn ensure_loading_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }
    create_loading_window(app)
}

/// v0.0.8 起用 navigate() + 严格 CSP 会在 WebKit 里只剩主题底色；改回直接以外部 URL 建窗（d671e8e 行为）。
fn create_main_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        if window_hosts_sidecar(&window) {
            return Ok(());
        }
        let _ = window.destroy();
    }

    let cache_bust = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let url = WebviewUrl::External(
        Url::parse(&format!(
            "http://{DESKTOP_LISTEN}/?_tch_desktop=1&_t={cache_bust}"
        ))
        .map_err(|error| format!("invalid desktop listen url: {error}"))?,
    );

    WebviewWindowBuilder::new(app, "main", url)
        .title("BreachWeave")
        .inner_size(1280.0, 800.0)
        .resizable(true)
        .decorations(true)
        .build()
        .map_err(|error| format!("failed to create main window: {error}"))?;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(250));
            inject_desktop_runtime(&handle);
        }
    });

    Ok(())
}

async fn bootstrap(app: AppHandle) {
    eprintln!("[desktop] waiting for sidecar at http://{DESKTOP_LISTEN} ...");
    if !wait_for_server(DESKTOP_LISTEN, SERVER_WAIT_TIMEOUT) {
        eprintln!(
            "[desktop] sidecar did not become ready within {:?}",
            SERVER_WAIT_TIMEOUT
        );
        if ensure_loading_window(&app).is_ok() {
            show_loading_error(
                &app,
                "本地服务未在 2 分钟内就绪。请检查 /usr/bin/tch-agent 是否正常，或查看终端日志。",
            );
        }
        return;
    }

    if !probe_sidecar_http(DESKTOP_LISTEN) {
        eprintln!("[desktop] sidecar HTTP probe failed for http://{DESKTOP_LISTEN}");
        if ensure_loading_window(&app).is_ok() {
            show_loading_error(
                &app,
                "指挥台页面无法加载（HTTP 异常）。若系统开启了 HTTP 代理（Clash/V2Ray），请把 127.0.0.1 与 localhost 加入绕过列表，或暂时关闭全局代理后重试。",
            );
        }
        return;
    }

    if let Err(error) = create_main_window(&app) {
        eprintln!("[desktop] window error: {error}");
        if ensure_loading_window(&app).is_ok() {
            show_loading_error(&app, &format!("无法打开指挥台窗口：{error}"));
        }
    }
}

#[tauri::command]
fn desktop_confirm_exit(app: AppHandle) {
    kill_sidecar(&app);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ensure_loopback_no_proxy();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main_window(app);
        }))
        .invoke_handler(tauri::generate_handler![desktop_confirm_exit])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                prompt_close_dialog(window.app_handle());
            }
        })
        .setup(|app| {
            let (rx, child) = spawn_sidecar(app.handle()).map_err(|error| {
                eprintln!("[desktop] sidecar spawn error: {error}");
                error
            })?;
            drain_sidecar_events(rx);
            app.manage(SidecarState {
                child: Mutex::new(Some(child)),
            });
            app.manage(ClosePromptState {
                last_prompt_at: Mutex::new(None),
            });

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                bootstrap(handle).await;
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build BreachWeave desktop app")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                kill_sidecar(app);
            }
        });
}
