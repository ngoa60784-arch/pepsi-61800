use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{
    async_runtime::Receiver, AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_shell::process::{Command, CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DESKTOP_LISTEN: &str = "127.0.0.1:38472";
const SERVER_WAIT_TIMEOUT: Duration = Duration::from_secs(120);

struct SidecarState {
    child: Mutex<Option<CommandChild>>,
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

fn spawn_sidecar(app: &AppHandle) -> Result<(Receiver<CommandEvent>, CommandChild), String> {
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

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.show();
    }
}

fn create_main_window(app: &AppHandle) -> Result<(), String> {
    let url = WebviewUrl::External(
        url::Url::parse(&format!("http://{DESKTOP_LISTEN}"))
            .map_err(|error| format!("invalid desktop listen url: {error}"))?,
    );

    WebviewWindowBuilder::new(app, "main", url)
        .title("BreachWeave")
        .inner_size(1280.0, 800.0)
        .resizable(true)
        .decorations(true)
        .build()
        .map_err(|error| format!("failed to create main window: {error}"))?;

    Ok(())
}

async fn bootstrap(app: AppHandle) {
    eprintln!("[desktop] waiting for sidecar at http://{DESKTOP_LISTEN} ...");
    if !wait_for_server(DESKTOP_LISTEN, SERVER_WAIT_TIMEOUT) {
        eprintln!(
            "[desktop] sidecar did not become ready within {:?}",
            SERVER_WAIT_TIMEOUT
        );
        return;
    }

    if let Err(error) = create_main_window(&app) {
        eprintln!("[desktop] window error: {error}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main_window(app);
        }))
        .setup(|app| {
            let (rx, child) = spawn_sidecar(app.handle())?;
            drain_sidecar_events(rx);
            app.manage(SidecarState {
                child: Mutex::new(Some(child)),
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
                if let Some(state) = app.try_state::<SidecarState>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
