#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use std::env;

use keyring::Entry;
use serde_json::{Map, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const LOCAL_API_PORT: &str = "46123";
const KEYRING_SERVICE: &str = "world-monitor";
const LOCAL_API_LOG_FILE: &str = "local-api.log";
const DESKTOP_LOG_FILE: &str = "desktop.log";
const MENU_FILE_SETTINGS_ID: &str = "file.settings";
const MENU_DEBUG_OPEN_LOGS_ID: &str = "debug.open_logs";
const MENU_DEBUG_OPEN_SIDECAR_LOG_ID: &str = "debug.open_sidecar_log";
const SUPPORTED_SECRET_KEYS: [&str; 15] = [
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "FRED_API_KEY",
    "EIA_API_KEY",
    "CLOUDFLARE_API_TOKEN",
    "ACLED_ACCESS_TOKEN",
    "WINGBITS_API_KEY",
    "WS_RELAY_URL",
    "VITE_OPENSKY_RELAY_URL",
    "OPENSKY_CLIENT_ID",
    "OPENSKY_CLIENT_SECRET",
    "AISSTREAM_API_KEY",
    "VITE_WS_RELAY_URL",
    "FINNHUB_API_KEY",
    "NASA_FIRMS_API_KEY",
];

#[derive(Default)]
struct LocalApiState {
    child: Mutex<Option<Child>>,
}

fn secret_entry(key: &str) -> Result<Entry, String> {
    if !SUPPORTED_SECRET_KEYS.contains(&key) {
        return Err(format!("Unsupported secret key: {key}"));
    }
    Entry::new(KEYRING_SERVICE, key).map_err(|e| format!("Keyring init failed: {e}"))
}

#[tauri::command]
fn list_supported_secret_keys() -> Vec<String> {
    SUPPORTED_SECRET_KEYS.iter().map(|key| (*key).to_string()).collect()
}

#[tauri::command]
fn get_secret(key: String) -> Result<Option<String>, String> {
    let entry = secret_entry(&key)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("Failed to read keyring secret: {err}")),
    }
}

#[tauri::command]
fn set_secret(key: String, value: String) -> Result<(), String> {
    let entry = secret_entry(&key)?;
    entry
        .set_password(&value)
        .map_err(|e| format!("Failed to write keyring secret: {e}"))
}

#[tauri::command]
fn delete_secret(key: String) -> Result<(), String> {
    let entry = secret_entry(&key)?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("Failed to delete keyring secret: {err}")),
    }
}

fn cache_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create app data directory {}: {e}", dir.display()))?;
    Ok(dir.join("persistent-cache.json"))
}

#[tauri::command]
fn read_cache_entry(app: AppHandle, key: String) -> Result<Option<Value>, String> {
    let path = cache_file_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }

    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read cache store {}: {e}", path.display()))?;
    let parsed: Value = serde_json::from_str(&contents).unwrap_or_else(|_| Value::Object(Map::new()));
    let Some(root) = parsed.as_object() else {
        return Ok(None);
    };

    Ok(root.get(&key).cloned())
}

#[tauri::command]
fn write_cache_entry(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let path = cache_file_path(&app)?;

    let mut root: Map<String, Value> = if path.exists() {
        let contents = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read cache store {}: {e}", path.display()))?;
        serde_json::from_str::<Value>(&contents)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        Map::new()
    };

    let parsed_value: Value = serde_json::from_str(&value)
        .map_err(|e| format!("Invalid cache payload JSON: {e}"))?;
    root.insert(key, parsed_value);

    let serialized = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("Failed to serialize cache store: {e}"))?;
    std::fs::write(&path, serialized)
        .map_err(|e| format!("Failed to write cache store {}: {e}", path.display()))
}

fn logs_dir_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to resolve app log dir: {e}"))?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create app log dir {}: {e}", dir.display()))?;
    Ok(dir)
}

fn sidecar_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(logs_dir_path(app)?.join(LOCAL_API_LOG_FILE))
}

fn desktop_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(logs_dir_path(app)?.join(DESKTOP_LOG_FILE))
}

fn append_desktop_log(app: &AppHandle, level: &str, message: &str) {
    let Ok(path) = desktop_log_path(app) else {
        return;
    };

    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(file, "[{timestamp}][{level}] {message}");
}

fn open_path_in_shell(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg(path);
        cmd
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("explorer");
        cmd.arg(path);
        cmd
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(path);
        cmd
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open {}: {e}", path.display()))
}

fn open_logs_folder_impl(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = logs_dir_path(app)?;
    open_path_in_shell(&dir)?;
    Ok(dir)
}

fn open_sidecar_log_impl(app: &AppHandle) -> Result<PathBuf, String> {
    let log_path = sidecar_log_path(app)?;
    if !log_path.exists() {
        File::create(&log_path)
            .map_err(|e| format!("Failed to create sidecar log {}: {e}", log_path.display()))?;
    }
    open_path_in_shell(&log_path)?;
    Ok(log_path)
}

#[tauri::command]
fn open_logs_folder(app: AppHandle) -> Result<String, String> {
    open_logs_folder_impl(&app).map(|path| path.display().to_string())
}

#[tauri::command]
fn open_sidecar_log_file(app: AppHandle) -> Result<String, String> {
    open_sidecar_log_impl(&app).map(|path| path.display().to_string())
}

#[tauri::command]
fn open_settings_window_command(app: AppHandle) -> Result<(), String> {
    open_settings_window(&app)
}

fn open_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus settings window: {e}"))?;
        return Ok(());
    }

    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("World Monitor Settings")
        .inner_size(980.0, 760.0)
        .min_inner_size(820.0, 620.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("Failed to create settings window: {e}"))?;

    Ok(())
}

fn build_app_menu(handle: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let settings_item = MenuItem::with_id(
        handle,
        MENU_FILE_SETTINGS_ID,
        "Settings...",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let separator = PredefinedMenuItem::separator(handle)?;
    let quit_item = PredefinedMenuItem::quit(handle, Some("Quit"))?;
    let file_menu =
        Submenu::with_items(handle, "File", true, &[&settings_item, &separator, &quit_item])?;

    let open_logs_item = MenuItem::with_id(
        handle,
        MENU_DEBUG_OPEN_LOGS_ID,
        "Open Logs Folder",
        true,
        None::<&str>,
    )?;
    let open_sidecar_log_item = MenuItem::with_id(
        handle,
        MENU_DEBUG_OPEN_SIDECAR_LOG_ID,
        "Open Local API Log",
        true,
        None::<&str>,
    )?;
    let debug_menu = Submenu::with_items(
        handle,
        "Debug",
        true,
        &[&open_logs_item, &open_sidecar_log_item],
    )?;

    Menu::with_items(handle, &[&file_menu, &debug_menu])
}

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        MENU_FILE_SETTINGS_ID => {
            if let Err(err) = open_settings_window(app) {
                append_desktop_log(app, "ERROR", &format!("settings menu failed: {err}"));
                eprintln!("[tauri] settings menu failed: {err}");
            }
        }
        MENU_DEBUG_OPEN_LOGS_ID => {
            if let Err(err) = open_logs_folder_impl(app) {
                append_desktop_log(app, "ERROR", &format!("open logs folder failed: {err}"));
                eprintln!("[tauri] open logs folder failed: {err}");
            }
        }
        MENU_DEBUG_OPEN_SIDECAR_LOG_ID => {
            if let Err(err) = open_sidecar_log_impl(app) {
                append_desktop_log(app, "ERROR", &format!("open sidecar log failed: {err}"));
                eprintln!("[tauri] open sidecar log failed: {err}");
            }
        }
        _ => {}
    }
}

fn local_api_paths(app: &AppHandle) -> (PathBuf, PathBuf) {
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));

    let sidecar_script = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecar/local-api-server.mjs")
    } else {
        resource_dir.join("sidecar/local-api-server.mjs")
    };

    let api_dir_root = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    } else {
        let direct_api = resource_dir.join("api");
        let lifted_root = resource_dir.join("_up_");
        let lifted_api = lifted_root.join("api");
        if direct_api.exists() {
            resource_dir
        } else if lifted_api.exists() {
            lifted_root
        } else {
            resource_dir
        }
    };

    (sidecar_script, api_dir_root)
}

fn resolve_node_binary() -> Option<PathBuf> {
    if let Ok(explicit) = env::var("LOCAL_API_NODE_BIN") {
        let explicit_path = PathBuf::from(explicit);
        if explicit_path.exists() {
            return Some(explicit_path);
        }
    }

    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    if let Some(path_var) = env::var_os("PATH") {
        for dir in env::split_paths(&path_var) {
            let candidate = dir.join(node_name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    let common_locations = if cfg!(windows) {
        vec![
            PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
            PathBuf::from(r"C:\Program Files (x86)\nodejs\node.exe"),
        ]
    } else {
        vec![
            PathBuf::from("/opt/homebrew/bin/node"),
            PathBuf::from("/usr/local/bin/node"),
            PathBuf::from("/usr/bin/node"),
            PathBuf::from("/opt/local/bin/node"),
        ]
    };

    common_locations.into_iter().find(|path| path.exists())
}

fn start_local_api(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<LocalApiState>();
    let mut slot = state
        .child
        .lock()
        .map_err(|_| "Failed to lock local API state".to_string())?;
    if slot.is_some() {
        return Ok(());
    }

    let (script, resource_root) = local_api_paths(app);
    if !script.exists() {
        return Err(format!(
            "Local API sidecar script missing at {}",
            script.display()
        ));
    }
    let node_binary = resolve_node_binary().ok_or_else(|| {
        "Node.js executable not found. Install Node 18+ or set LOCAL_API_NODE_BIN".to_string()
    })?;

    let log_path = sidecar_log_path(app)?;
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open local API log {}: {e}", log_path.display()))?;
    let log_file_err = log_file
        .try_clone()
        .map_err(|e| format!("Failed to clone local API log handle: {e}"))?;

    append_desktop_log(
        app,
        "INFO",
        &format!(
            "starting local API sidecar script={} resource_root={} log={}",
            script.display(),
            resource_root.display(),
            log_path.display()
        ),
    );
    append_desktop_log(app, "INFO", &format!("resolved node binary={}", node_binary.display()));

    let mut cmd = Command::new(&node_binary);
    cmd.arg(&script)
        .env("LOCAL_API_PORT", LOCAL_API_PORT)
        .env("LOCAL_API_RESOURCE_DIR", resource_root)
        .env("LOCAL_API_MODE", "tauri-sidecar")
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err));

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch local API: {e}"))?;
    append_desktop_log(app, "INFO", &format!("local API sidecar started pid={}", child.id()));
    *slot = Some(child);
    Ok(())
}

fn stop_local_api(app: &AppHandle) {
    if let Ok(state) = app.try_state::<LocalApiState>().ok_or(()) {
        if let Ok(mut slot) = state.child.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                append_desktop_log(app, "INFO", "local API sidecar stopped");
            }
        }
    }
}

fn main() {
    tauri::Builder::default()
        .menu(build_app_menu)
        .on_menu_event(handle_menu_event)
        .manage(LocalApiState::default())
        .invoke_handler(tauri::generate_handler![
            list_supported_secret_keys,
            get_secret,
            set_secret,
            delete_secret,
            read_cache_entry,
            write_cache_entry,
            open_logs_folder,
            open_sidecar_log_file,
            open_settings_window_command
        ])
        .setup(|app| {
            if let Err(err) = start_local_api(&app.handle()) {
                append_desktop_log(
                    &app.handle(),
                    "ERROR",
                    &format!("local API sidecar failed to start: {err}"),
                );
                eprintln!("[tauri] local API sidecar failed to start: {err}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running world-monitor tauri application")
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                stop_local_api(&app);
            }
        });
}
