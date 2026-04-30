// Memoria desktop entry point.
//
// On startup we (try to) spawn the Node-based Memoria server as a child
// process and aim the WebView at http://localhost:<MEMORIA_PORT>/. When the
// app window is closed we kill the child so the port is freed.
//
// Spawn behaviour is controlled by env vars / build mode:
//   MEMORIA_SERVER_DIR  — absolute path to the server/ directory.
//                          Default lookup order:
//                            1. <resources>/server/   (production bundle)
//                            2. <exe_dir>/server/     (legacy dev sidecar)
//   MEMORIA_NODE_BIN    — Node executable.
//                          Default lookup order:
//                            1. <resources>/node/<plat>/{node,bin/node[.exe]}
//                               (production bundle, prepared by
//                                desktop/scripts/bundle-server.mjs)
//                            2. "node" on PATH
//   MEMORIA_PORT        — port the server listens on (default: 5180)
//
// In `cargo tauri dev` the user is expected to run the server themselves;
// the spawn errors are tolerated so the dev workflow stays clean.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{path::BaseDirectory, Manager};

struct ServerHandle(Mutex<Option<Child>>);

fn target_node_subdir() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        return "win-x64";
    }
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return "darwin-arm64";
    }
    if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        return "darwin-x64";
    }
    if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        return "linux-x64";
    }
    if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        return "linux-arm64";
    }
    "unknown"
}

fn bundled_node(app: &tauri::AppHandle) -> Option<PathBuf> {
    let base = app
        .path()
        .resolve("resources/node", BaseDirectory::Resource)
        .ok()?;
    let plat = base.join(target_node_subdir());
    let candidates = [
        plat.join("node.exe"),
        plat.join("bin").join("node"),
        plat.join("node"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

#[cfg(target_os = "windows")]
fn discover_git_bash() -> Option<PathBuf> {
    // Common Git for Windows installation paths.
    let candidates = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ];
    for c in candidates {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    // %USERPROFILE%\AppData\Local\Programs\Git\bin\bash.exe (per-user install).
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let p = PathBuf::from(profile).join(r"AppData\Local\Programs\Git\bin\bash.exe");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn bundled_server(app: &tauri::AppHandle) -> Option<PathBuf> {
    let p = app
        .path()
        .resolve("resources/server", BaseDirectory::Resource)
        .ok()?;
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

fn spawn_server(app: &tauri::AppHandle) -> Option<Child> {
    let server_dir = std::env::var("MEMORIA_SERVER_DIR")
        .map(PathBuf::from)
        .ok()
        .or_else(|| bundled_server(app))
        .unwrap_or_else(|| {
            let mut p = std::env::current_exe().unwrap_or_default();
            p.pop();
            p.push("server");
            p
        });
    let node_bin: PathBuf = std::env::var("MEMORIA_NODE_BIN")
        .map(PathBuf::from)
        .ok()
        .or_else(|| bundled_node(app))
        .unwrap_or_else(|| Path::new("node").to_path_buf());
    let port = std::env::var("MEMORIA_PORT").unwrap_or_else(|_| "5180".to_string());

    if !server_dir.exists() {
        eprintln!(
            "[memoria-desktop] server dir not found at {:?} — assuming it's already running",
            server_dir
        );
        return None;
    }

    let mut cmd = Command::new(&node_bin);
    cmd.current_dir(&server_dir)
        .arg("index.js")
        .env("MEMORIA_PORT", &port)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // Windows-only: best-effort discovery of git-bash so the Claude CLI
    // (spawned from Node) can find its own bash. Settings can override
    // the discovered path; this just gets first-run users moving.
    #[cfg(target_os = "windows")]
    {
        if std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH").is_none() {
            if let Some(found) = discover_git_bash() {
                cmd.env("CLAUDE_CODE_GIT_BASH_PATH", &found);
                eprintln!("[memoria-desktop] git-bash → {:?}", found);
            }
        }
    }

    match cmd.spawn() {
        Ok(child) => {
            eprintln!(
                "[memoria-desktop] spawned {:?} (pid {}) in {:?} (port {})",
                node_bin,
                child.id(),
                server_dir,
                port
            );
            Some(child)
        }
        Err(e) => {
            eprintln!(
                "[memoria-desktop] failed to spawn server ({:?} index.js in {:?}): {}",
                node_bin, server_dir, e
            );
            None
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ServerHandle(Mutex::new(None)))
        .setup(|app| {
            let app_handle = app.handle().clone();
            let handle: tauri::State<ServerHandle> = app.state();
            *handle.0.lock().unwrap() = spawn_server(&app_handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let handle: tauri::State<ServerHandle> = window.app_handle().state();
                if let Some(mut child) = handle.0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
