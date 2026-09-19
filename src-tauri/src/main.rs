#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Desktop shell for Roundstorm.
//!
//! The daemon is the product; this is a window around it. Everything durable —
//! rooms, transcripts, the ledger, memory, logs — lives in the daemon's SQLite
//! store, so the shell stays deliberately thin and replaceable. If Tauri turns
//! out to be the wrong choice, only this file is lost.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

/// Holds the daemon child so it can be killed when the window closes. Without
/// this, quitting the app leaves an orphaned daemon holding the port and the
/// next launch silently talks to a stale build.
struct Daemon(Mutex<Option<Child>>);

const PORT: &str = "8787";

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Daemon(Mutex::new(None)))
        .setup(|app| {
            // In dev the daemon is already running under `npm run dev`; starting
            // a second one would just fight over the port.
            if cfg!(debug_assertions) {
                return Ok(());
            }

            let entry = app
                .path()
                .resolve("dist-server/index.mjs", tauri::path::BaseDirectory::Resource)?;

            // Where to look when the window comes up empty. A GUI app has no
            // terminal, so discarding the daemon's output means a failure to
            // start is completely invisible — which is exactly how this went
            // wrong the first time.
            let log_path = app
                .path()
                .app_log_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("roundstorm-daemon.log");
            if let Some(dir) = log_path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }

            // The daemon refuses requests from origins it does not recognise, and
            // the packaged page's origin is Tauri's business, not ours: it is
            // `tauri://localhost` on macOS and Linux but `http(s)://tauri.localhost`
            // on Windows. Reading it off the real window means the allowlist is
            // right by construction instead of right by a table in a comment —
            // and getting it wrong ships a blank window.
            let origin = window_origin(app);

            match spawn_daemon(&entry, &log_path, origin.as_deref()) {
                Ok(child) => {
                    app.state::<Daemon>().0.lock().unwrap().replace(child);
                }
                Err(err) => {
                    let _ = std::fs::write(
                        &log_path,
                        format!("Roundstorm could not start its daemon: {err}\n"),
                    );
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Roundstorm")
        .run(|app, event| {
            // Closing the window is not the only way out — Cmd-Q and a Dock quit
            // both bypass WindowEvent::Destroyed. Exit is the one signal that
            // covers every ordinary quit, and leaving the daemon alive means the
            // next launch silently talks to a stale build on a held port.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Daemon>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        });
}

/// The origin the webview will actually send, read off the main window.
///
/// Built from scheme + host + port by hand on purpose. `Url::origin()` follows
/// the URL spec, which calls a non-special scheme like `tauri:` opaque and
/// serialises it as the literal string "null" — the one value the daemon must
/// never allowlist, since any sandboxed iframe can produce it.
fn window_origin(app: &tauri::App) -> Option<String> {
    let url = app.get_webview_window("main")?.url().ok()?;
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{}://{}:{}", url.scheme(), host, port),
        None => format!("{}://{}", url.scheme(), host),
    })
}

fn spawn_daemon(
    entry: &std::path::Path,
    log_path: &std::path::Path,
    origin: Option<&str>,
) -> std::io::Result<Child> {
    // A GUI app launched from Finder does not inherit a login shell's PATH, so
    // the usual install locations have to be probed explicitly.
    let node = which_node().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("No Node {MIN_NODE_MAJOR}+ found. Roundstorm needs Node {MIN_NODE_MAJOR} or newer; \
                     set ROUNDSTORM_NODE to point at one."),
        )
    })?;

    let log = std::fs::File::create(log_path)?;
    let errlog = log.try_clone()?;

    Command::new(&node)
        // node:sqlite is still flagged experimental and prints a warning on every
        // launch. It is expected, so it should not look like a fault in the log.
        .arg("--disable-warning=ExperimentalWarning")
        .arg(entry)
        .env("PORT", PORT)
        // The daemon exits on its own if this process dies without cleaning up
        // — a crash or a force-quit, which no exit handler can catch.
        .env("ROUNDSTORM_PARENT_PID", std::process::id().to_string())
        .env("ROUNDSTORM_ALLOWED_ORIGINS", origin.unwrap_or_default())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(errlog))
        .spawn()
}

/// Minimum Node that can run the daemon.
///
/// 22 because storage is `node:sqlite`, which landed in 22.5 — an older Node
/// parses the bundle fine and then dies on the import, which is a much more
/// confusing failure than "no suitable Node found". This has to stay in step with
/// the `engines` field in package.json.
const MIN_NODE_MAJOR: u32 = 22;

/// Find a Node that can actually run the daemon.
///
/// Existence is not enough. This machine had nvm versions 8.0.0, 8.6.0, 20 and
/// 22 side by side, and picking whichever the directory listing returned first
/// got Node 8 — which cannot parse ESM, so the daemon died instantly and the app
/// sat there with no window content and no explanation.
///
/// So: gather every candidate, ask each its version, and take the newest that is
/// new enough.
fn which_node() -> Option<std::path::PathBuf> {
    if let Ok(explicit) = std::env::var("ROUNDSTORM_NODE") {
        let p = std::path::PathBuf::from(explicit);
        if p.exists() {
            return Some(p);
        }
    }

    let mut best: Option<(u32, std::path::PathBuf)> = None;
    for candidate in node_candidates() {
        if let Some(major) = node_major(&candidate) {
            if major >= MIN_NODE_MAJOR && best.as_ref().is_none_or(|(m, _)| major > *m) {
                best = Some((major, candidate));
            }
        }
    }
    best.map(|(_, p)| p)
}

fn node_candidates() -> Vec<std::path::PathBuf> {
    let mut out: Vec<std::path::PathBuf> = vec![
        "/opt/homebrew/bin/node".into(),
        "/usr/local/bin/node".into(),
        "/usr/bin/node".into(),
    ];
    // A GUI app launched from Finder does not inherit a login shell's PATH, but
    // check it anyway for the case where it was launched from a terminal.
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            out.push(std::path::Path::new(dir).join("node"));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        for base in [".nvm/versions/node", ".volta/tools/image/node", ".fnm/node-versions"] {
            if let Ok(entries) = std::fs::read_dir(std::path::Path::new(&home).join(base)) {
                for e in entries.flatten() {
                    out.push(e.path().join("bin/node"));
                    // fnm nests one level deeper.
                    out.push(e.path().join("installation/bin/node"));
                }
            }
        }
    }
    out.retain(|p| p.exists());
    out
}

/// Ask a Node binary for its major version. `None` if it will not answer.
fn node_major(path: &std::path::Path) -> Option<u32> {
    let out = Command::new(path).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}
