// Memoria desktop entry point.
//
// On startup we (try to) spawn the Node-based Memoria server as a child
// process and aim the WebView at http://localhost:<MEMORIA_PORT>/. When the
// app window is closed we kill the child so the port is freed.
//
// Spawn behaviour is controlled by env vars / build mode:
//   MEMORIA_SERVER_DIR  — absolute path to the server/ directory
//                          (default: <exe_dir>/server)
//   MEMORIA_NODE_BIN    — Node executable (default: "node")
//   MEMORIA_PORT        — port the server listens on (default: 5180)
//
// In `cargo tauri dev` the user is expected to run the server themselves;
// the spawn errors are tolerated so the dev workflow stays clean.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::Manager;

struct ServerHandle(Mutex<Option<Child>>);

fn spawn_server() -> Option<Child> {
    let server_dir = std::env::var("MEMORIA_SERVER_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let mut p = std::env::current_exe().unwrap_or_default();
            p.pop();
            p.push("server");
            p
        });
    let node_bin = std::env::var("MEMORIA_NODE_BIN").unwrap_or_else(|_| "node".to_string());
    let port = std::env::var("MEMORIA_PORT").unwrap_or_else(|_| "5180".to_string());

    if !server_dir.exists() {
        eprintln!(
            "[memoria-desktop] server dir not found at {:?} — assuming it's already running",
            server_dir
        );
        return None;
    }

    match Command::new(&node_bin)
        .current_dir(&server_dir)
        .arg("index.js")
        .env("MEMORIA_PORT", &port)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => {
            eprintln!(
                "[memoria-desktop] spawned {} (pid {}) in {:?} (port {})",
                node_bin,
                child.id(),
                server_dir,
                port
            );
            Some(child)
        }
        Err(e) => {
            eprintln!(
                "[memoria-desktop] failed to spawn server ({} index.js in {:?}): {}",
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
            let handle: tauri::State<ServerHandle> = app.state();
            *handle.0.lock().unwrap() = spawn_server();
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
