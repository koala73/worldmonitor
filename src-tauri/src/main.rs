#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use keyring::Entry;
use reqwest::Url;
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, RunEvent, Webview, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_biometry;

const DEFAULT_LOCAL_API_PORT: u16 = 46123;
const KEYRING_SERVICE: &str = "world-monitor";
const LOCAL_API_LOG_FILE: &str = "local-api.log";
const DESKTOP_LOG_FILE: &str = "desktop.log";
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024; // 5 MB per log file before rotation
const MAX_LOG_BACKUPS: u32 = 3; // keep .log.1 .log.2 .log.3
const MENU_FILE_SETTINGS_ID: &str = "file.settings";
const MENU_FILE_GHOST_MODE_ID: &str = "file.ghost_mode";
const MENU_HELP_GITHUB_ID: &str = "help.github";
const MENU_HELP_CHECK_UPDATES_ID: &str = "help.check_updates";
const MENU_HELP_OPEN_LOGS_ID: &str = "help.open_logs";
#[cfg(feature = "devtools")]
const MENU_HELP_DEVTOOLS_ID: &str = "help.devtools";
const TRUSTED_WINDOWS: [&str; 3] = ["main", "settings", "live-channels"];
const SUPPORTED_SECRET_KEYS: [&str; 26] = [
    "WORLDMONITOR_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "FRED_API_KEY",
    "EIA_API_KEY",
    "CLOUDFLARE_API_TOKEN",
    "ACLED_ACCESS_TOKEN",
    "ACLED_EMAIL",
    "URLHAUS_AUTH_KEY",
    "OTX_API_KEY",
    "ABUSEIPDB_API_KEY",
    "WINGBITS_API_KEY",
    "WS_RELAY_URL",
    "VITE_OPENSKY_RELAY_URL",
    "OPENSKY_CLIENT_ID",
    "OPENSKY_CLIENT_SECRET",
    "AISSTREAM_API_KEY",
    "VITE_WS_RELAY_URL",
    "FINNHUB_API_KEY",
    "NASA_FIRMS_API_KEY",
    "OLLAMA_API_URL",
    "OLLAMA_MODEL",
    "WTO_API_KEY",
    "AVIATIONSTACK_API",
    "ICAO_API_KEY",
    "THREATFOX_API_KEY",
];

// Rate-limit native notifications: no more than 1 per 30 seconds across all threads.
static NOTIFICATION_LAST_SENT: Mutex<Option<Instant>> = Mutex::new(None);
const NOTIFICATION_RATE_LIMIT: Duration = Duration::from_secs(30);
const MIN_CACHE_FLUSH_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Default)]
struct LocalApiState {
    child: Mutex<Option<Child>>,
    token: Mutex<Option<String>>,
    port: Mutex<Option<u16>>,
}

/// In-memory cache for keychain secrets. Populated once at startup to avoid
/// repeated macOS Keychain prompts (each `Entry::get_password()` triggers one).
struct SecretsCache {
    secrets: Mutex<HashMap<String, String>>,
}

/// In-memory mirror of persistent-cache.json. The file can grow to 10+ MB,
/// so reading/parsing/writing it on every IPC call blocks the main thread.
/// Instead, load once into RAM and serialize writes to preserve ordering.
struct PersistentCache {
    data: Mutex<Map<String, Value>>,
    revision: AtomicU64,
    flushed_revision: AtomicU64,
    flush_scheduled: Mutex<bool>,
    last_flush_at: Mutex<Option<Instant>>,
}

impl SecretsCache {
    fn load_from_keychain() -> Self {
        // Try consolidated vault first — single keychain prompt
        if let Ok(entry) = Entry::new(KEYRING_SERVICE, "secrets-vault") {
            if let Ok(json) = entry.get_password() {
                if let Ok(map) = serde_json::from_str::<HashMap<String, String>>(&json) {
                    let secrets: HashMap<String, String> = map
                        .into_iter()
                        .filter(|(k, v)| {
                            SUPPORTED_SECRET_KEYS.contains(&k.as_str()) && !v.trim().is_empty()
                        })
                        .map(|(k, v)| (k, v.trim().to_string()))
                        .collect();
                    return SecretsCache {
                        secrets: Mutex::new(secrets),
                    };
                }
            }
        }

        // Migration: read individual keys (old format), consolidate into vault.
        // This triggers one keychain prompt per key — happens only once.
        let mut secrets = HashMap::new();
        for key in SUPPORTED_SECRET_KEYS.iter() {
            if let Ok(entry) = Entry::new(KEYRING_SERVICE, key) {
                if let Ok(value) = entry.get_password() {
                    let trimmed = value.trim().to_string();
                    if !trimmed.is_empty() {
                        secrets.insert((*key).to_string(), trimmed);
                    }
                }
            }
        }

        // Write consolidated vault and clean up individual entries
        if !secrets.is_empty() {
            if let Ok(json) = serde_json::to_string(&secrets) {
                if let Ok(vault_entry) = Entry::new(KEYRING_SERVICE, "secrets-vault") {
                    if vault_entry.set_password(&json).is_ok() {
                        for key in SUPPORTED_SECRET_KEYS.iter() {
                            if let Ok(entry) = Entry::new(KEYRING_SERVICE, key) {
                                let _ = entry.delete_credential();
                            }
                        }
                    }
                }
            }
        }

        SecretsCache {
            secrets: Mutex::new(secrets),
        }
    }
}

impl PersistentCache {
    fn load(path: &Path) -> Self {
        let data = if path.exists() {
            std::fs::read_to_string(path)
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default()
        } else {
            Map::new()
        };
        PersistentCache {
            data: Mutex::new(data),
            revision: AtomicU64::new(0),
            flushed_revision: AtomicU64::new(0),
            flush_scheduled: Mutex::new(false),
            last_flush_at: Mutex::new(None),
        }
    }

    fn get(&self, key: &str) -> Option<Value> {
        let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        data.get(key).cloned()
    }

    /// Flush to disk only if dirty. Returns Ok(true) if written.
    fn flush(&self, path: &Path, force: bool) -> Result<bool, String> {
        if self.revision.load(Ordering::Acquire) == self.flushed_revision.load(Ordering::Acquire) {
            return Ok(false);
        }

        if !force {
            let last_flush_at = self.last_flush_at.lock().unwrap_or_else(|e| e.into_inner());
            if last_flush_at
                .as_ref()
                .map(|at| at.elapsed() < MIN_CACHE_FLUSH_INTERVAL)
                .unwrap_or(false)
            {
                return Ok(false);
            }
        }

        let (snapshot, snapshot_revision) = {
            let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
            let snapshot = data.clone();
            let snapshot_revision = self.revision.load(Ordering::Acquire);
            (snapshot, snapshot_revision)
        };

        if snapshot_revision == self.flushed_revision.load(Ordering::Acquire) {
            return Ok(false);
        }

        let tmp_path = path.with_extension("json.tmp");
        let tmp_file = File::create(&tmp_path)
            .map_err(|e| format!("Failed to create cache temp file {}: {e}", tmp_path.display()))?;
        let mut writer = BufWriter::new(tmp_file);
        serde_json::to_writer(&mut writer, &snapshot)
            .map_err(|e| format!("Failed to serialize cache: {e}"))?;
        writer
            .flush()
            .map_err(|e| format!("Failed to flush cache temp file {}: {e}", tmp_path.display()))?;

        #[cfg(windows)]
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }

        std::fs::rename(&tmp_path, path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            format!(
                "Failed to replace cache {} from {}: {e}",
                path.display(),
                tmp_path.display()
            )
        })?;
        self.flushed_revision.store(snapshot_revision, Ordering::Release);
        let mut last_flush_at = self.last_flush_at.lock().unwrap_or_else(|e| e.into_inner());
        *last_flush_at = Some(Instant::now());
        Ok(true)
    }
}

fn schedule_cache_flush(app: &AppHandle) {
    let should_spawn = match app.try_state::<PersistentCache>() {
        Some(cache) => {
            let mut scheduled = cache.flush_scheduled.lock().unwrap_or_else(|e| e.into_inner());
            if *scheduled {
                false
            } else {
                *scheduled = true;
                true
            }
        }
        None => false,
    };
    if !should_spawn {
        return;
    }

    let app_handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(750));

        let flush_result = if let Ok(path) = cache_file_path(&app_handle) {
            if let Some(cache) = app_handle.try_state::<PersistentCache>() {
                cache.flush(&path, false)
            } else {
                Ok(false)
            }
        } else {
            Ok(false)
        };

        if let Some(cache) = app_handle.try_state::<PersistentCache>() {
            {
                let mut scheduled = cache.flush_scheduled.lock().unwrap_or_else(|e| e.into_inner());
                *scheduled = false;
            }

            if flush_result.is_ok() {
                if cache.revision.load(Ordering::Acquire) != cache.flushed_revision.load(Ordering::Acquire) {
                    schedule_cache_flush(&app_handle);
                }
            }
        }
    });
}

#[derive(Serialize)]
struct DesktopRuntimeInfo {
    os: String,
    arch: String,
    local_api_port: Option<u16>,
    username: Option<String>,
    display_name: Option<String>,
}

fn humanize_user_name(value: &str) -> Option<String> {
    let mut parts = Vec::new();
    for raw in value.split(|c: char| c == '.' || c == '_' || c == '-' || c.is_whitespace()) {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut chars = trimmed.chars();
        if let Some(first) = chars.next() {
            let first_upper = first.to_uppercase().collect::<String>();
            let rest = chars.as_str().to_lowercase();
            parts.push(format!("{first_upper}{rest}"));
        }
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

fn resolve_runtime_user_name() -> Option<String> {
    env::var("USER")
        .ok()
        .or_else(|| env::var("USERNAME").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn resolve_runtime_display_name(username: Option<&String>) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("id").arg("-F").output() {
            if output.status.success() {
                let display_name = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !display_name.is_empty() {
                    return Some(display_name);
                }
            }
        }
    }

    username.and_then(|value| humanize_user_name(value))
}

fn save_vault(cache: &HashMap<String, String>) -> Result<(), String> {
    let json =
        serde_json::to_string(cache).map_err(|e| format!("Failed to serialize vault: {e}"))?;
    let entry = Entry::new(KEYRING_SERVICE, "secrets-vault")
        .map_err(|e| format!("Keyring init failed: {e}"))?;
    entry
        .set_password(&json)
        .map_err(|e| format!("Failed to write vault: {e}"))?;
    Ok(())
}

fn generate_local_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("OS CSPRNG unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn require_trusted_window(label: &str) -> Result<(), String> {
    if TRUSTED_WINDOWS.contains(&label) {
        Ok(())
    } else {
        Err(format!("Command not allowed from window '{label}'"))
    }
}

#[tauri::command]
fn get_local_api_token(webview: Webview, state: tauri::State<'_, LocalApiState>) -> Result<String, String> {
    require_trusted_window(webview.label())?;
    let token = state
        .token
        .lock()
        .map_err(|_| "Failed to lock local API token".to_string())?;
    token
        .clone()
        .ok_or_else(|| "Token not generated".to_string())
}

#[tauri::command]
fn get_desktop_runtime_info(state: tauri::State<'_, LocalApiState>) -> DesktopRuntimeInfo {
    let port = state.port.lock().ok().and_then(|g| *g);
    let username = resolve_runtime_user_name();
    let display_name = resolve_runtime_display_name(username.as_ref());
    DesktopRuntimeInfo {
        os: env::consts::OS.to_string(),
        arch: env::consts::ARCH.to_string(),
        local_api_port: port,
        username,
        display_name,
    }
}

#[tauri::command]
fn get_local_api_port(webview: Webview, state: tauri::State<'_, LocalApiState>) -> Result<u16, String> {
    require_trusted_window(webview.label())?;
    state.port.lock()
        .map_err(|_| "Failed to lock port state".to_string())?
        .ok_or_else(|| "Port not yet assigned".to_string())
}

#[tauri::command]
fn list_supported_secret_keys() -> Vec<String> {
    SUPPORTED_SECRET_KEYS
        .iter()
        .map(|key| (*key).to_string())
        .collect()
}

#[tauri::command]
fn get_secret(
    webview: Webview,
    key: String,
    cache: tauri::State<'_, SecretsCache>,
) -> Result<Option<String>, String> {
    require_trusted_window(webview.label())?;
    if !SUPPORTED_SECRET_KEYS.contains(&key.as_str()) {
        return Err(format!("Unsupported secret key: {key}"));
    }
    let secrets = cache
        .secrets
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    Ok(secrets.get(&key).cloned())
}

#[tauri::command]
fn get_all_secrets(webview: Webview, cache: tauri::State<'_, SecretsCache>) -> Result<HashMap<String, String>, String> {
    require_trusted_window(webview.label())?;
    Ok(cache
        .secrets
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone())
}

#[tauri::command]
fn set_secret(
    webview: Webview,
    key: String,
    value: String,
    cache: tauri::State<'_, SecretsCache>,
) -> Result<(), String> {
    require_trusted_window(webview.label())?;
    if !SUPPORTED_SECRET_KEYS.contains(&key.as_str()) {
        return Err(format!("Unsupported secret key: {key}"));
    }
    let mut secrets = cache
        .secrets
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    let trimmed = value.trim().to_string();
    // Build proposed state, persist first, then commit to cache
    let mut proposed = secrets.clone();
    if trimmed.is_empty() {
        proposed.remove(&key);
    } else {
        proposed.insert(key, trimmed);
    }
    save_vault(&proposed)?;
    *secrets = proposed;
    Ok(())
}

#[tauri::command]
fn delete_secret(webview: Webview, key: String, cache: tauri::State<'_, SecretsCache>) -> Result<(), String> {
    require_trusted_window(webview.label())?;
    if !SUPPORTED_SECRET_KEYS.contains(&key.as_str()) {
        return Err(format!("Unsupported secret key: {key}"));
    }
    let mut secrets = cache
        .secrets
        .lock()
        .map_err(|_| "Lock poisoned".to_string())?;
    let mut proposed = secrets.clone();
    proposed.remove(&key);
    save_vault(&proposed)?;
    *secrets = proposed;
    Ok(())
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
fn read_cache_entry(webview: Webview, cache: tauri::State<'_, PersistentCache>, key: String) -> Result<Option<Value>, String> {
    require_trusted_window(webview.label())?;
    Ok(cache.get(&key))
}

#[tauri::command]
fn delete_cache_entry(webview: Webview, app: AppHandle, cache: tauri::State<'_, PersistentCache>, key: String) -> Result<(), String> {
    require_trusted_window(webview.label())?;
    {
        let mut data = cache.data.lock().unwrap_or_else(|e| e.into_inner());
        data.remove(&key);
        cache.revision.fetch_add(1, Ordering::AcqRel);
    }
    schedule_cache_flush(&app);
    Ok(())
}

#[tauri::command]
fn write_cache_entry(webview: Webview, app: AppHandle, cache: tauri::State<'_, PersistentCache>, key: String, value: String) -> Result<(), String> {
    require_trusted_window(webview.label())?;
    let parsed_value: Value = serde_json::from_str(&value)
        .map_err(|e| format!("Invalid cache payload JSON: {e}"))?;
    {
        let mut data = cache.data.lock().unwrap_or_else(|e| e.into_inner());
        data.insert(key, parsed_value);
        cache.revision.fetch_add(1, Ordering::AcqRel);
    }
    schedule_cache_flush(&app);
    Ok(())
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

/// Rotate `path` if it exceeds MAX_LOG_BYTES. Keeps MAX_LOG_BACKUPS numbered copies.
fn rotate_log_if_needed(path: &Path) {
    let size = path.metadata().map(|m| m.len()).unwrap_or(0);
    if size < MAX_LOG_BYTES {
        return;
    }
    // Shift existing backups up: .log.2 → .log.3, .log.1 → .log.2, etc.
    for i in (1..MAX_LOG_BACKUPS).rev() {
        let from = path.with_extension(format!("log.{i}"));
        let to = path.with_extension(format!("log.{}", i + 1));
        let _ = fs::rename(&from, &to);
    }
    // Move current log to .log.1
    let first_backup = path.with_extension("log.1");
    let _ = fs::rename(path, &first_backup);
}

fn append_desktop_log(app: &AppHandle, level: &str, message: &str) {
    let Ok(path) = desktop_log_path(app) else {
        return;
    };

    rotate_log_if_needed(&path);

    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(file, "[{timestamp}][{level}] {message}");
}

fn open_in_shell(arg: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg(arg);
        cmd
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("explorer");
        cmd.arg(arg);
        cmd
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(arg);
        cmd
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open {}: {e}", arg))
}

fn open_path_in_shell(path: &Path) -> Result<(), String> {
    open_in_shell(&path.to_string_lossy())
}

#[cfg(target_os = "macos")]
fn bundle_root_from_executable(executable: &Path) -> Option<PathBuf> {
    executable
        .ancestors()
        .find(|candidate| {
            candidate.extension().and_then(|ext| ext.to_str()) == Some("app")
                && candidate.file_name().and_then(|name| name.to_str()) == Some("World Monitor.app")
        })
        .map(Path::to_path_buf)
}

#[cfg(target_os = "macos")]
fn canonical_user_app_path() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("Applications").join("World Monitor.app"))
}

#[cfg(target_os = "macos")]
fn resolve_update_install_path() -> Result<PathBuf, String> {
    let current_exe =
        env::current_exe().map_err(|e| format!("Failed to resolve current executable: {e}"))?;
    if let Some(bundle_root) = bundle_root_from_executable(&current_exe) {
        if bundle_root
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            == Some("Applications")
        {
            return Ok(bundle_root);
        }
    }

    canonical_user_app_path()
        .ok_or_else(|| "Could not resolve canonical ~/Applications install path".to_string())
}

#[cfg(target_os = "macos")]
fn verify_app_bundle_signature(app_path: &Path, label: &str) -> Result<(), String> {
    let output = Command::new("codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(app_path)
        .output()
        .map_err(|e| format!("codesign command failed for {label}: {e}"))?;

    if output.status.success() {
        return Ok(());
    }

    Err(format!(
        "{label} signature verification failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

#[cfg(target_os = "macos")]
fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };

    if metadata.file_type().is_dir() {
        fs::remove_dir_all(path).map_err(|e| format!("Failed to remove {}: {e}", path.display()))
    } else {
        fs::remove_file(path).map_err(|e| format!("Failed to remove {}: {e}", path.display()))
    }
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "Invalid URL".to_string())?;

    // Only HTTPS is allowed. Local/internal URLs must never be opened via this command
    // to prevent a compromised webview from hitting the local API server (127.0.0.1:46123)
    // or other internal services through the system browser.
    if parsed.scheme() != "https" {
        return Err("Only https:// URLs may be opened via open_url".to_string());
    }

    // Block loopback, link-local, and private network hosts even over HTTPS
    let host = parsed.host_str().unwrap_or("");
    let blocked = host == "localhost"
        || host == "127.0.0.1"
        || host == "::1"
        || host.starts_with("192.168.")
        || host.starts_with("10.")
        || host.ends_with(".local");
    if blocked {
        return Err("Internal/private addresses may not be opened via open_url".to_string());
    }

    // URL length guard — browsers accept long URLs but this prevents log spam
    if url.len() > 4096 {
        return Err("URL exceeds maximum allowed length".to_string());
    }

    open_in_shell(parsed.as_str())
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
async fn open_settings_window_command(app: AppHandle) -> Result<(), String> {
    open_settings_window(&app)
}

#[tauri::command]
fn close_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window
            .close()
            .map_err(|e| format!("Failed to close settings window: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn open_live_channels_window_command(
    app: AppHandle,
    base_url: Option<String>,
) -> Result<(), String> {
    open_live_channels_window(&app, base_url)
}

#[tauri::command]
fn close_live_channels_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("live-channels") {
        window
            .close()
            .map_err(|e| format!("Failed to close live channels window: {e}"))?;
    }
    Ok(())
}

/// Send a native macOS notification via osascript. No-op on non-macOS platforms.
/// Rate-limited to 1 notification per 30 seconds to prevent notification spam.
/// Input fields are length-capped and sanitized before interpolation into AppleScript.
#[tauri::command]
fn send_notification(title: String, body: String, sound: Option<String>) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (title, body, sound);
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        // Rate limit: silently drop if fired too recently
        {
            let mut last = NOTIFICATION_LAST_SENT.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(t) = *last {
                if t.elapsed() < NOTIFICATION_RATE_LIMIT {
                    return Ok(()); // suppressed — too soon
                }
            }
            *last = Some(Instant::now());
        }

        // Enforce length limits to bound log size and script length
        let title = if title.len() > 128 { &title[..128] } else { title.as_str() };
        let body  = if body.len()  > 256 { &body[..256]  } else { body.as_str()  };
        let sound_name = sound.as_deref().unwrap_or("Ping");
        let sound_name = if sound_name.len() > 64 { &sound_name[..64] } else { sound_name };

        // Sanitize: remove characters that have meaning in AppleScript string literals.
        // We use double-quoted AppleScript strings so we strip " and \ (escape char).
        // Newlines and control chars are also removed to prevent multi-statement injection.
        let sanitize = |s: &str| -> String {
            s.chars()
                .filter(|c| !matches!(c, '"' | '\\' | '\n' | '\r' | '\x00'..='\x1f'))
                .collect()
        };
        let safe_title = sanitize(title);
        let safe_body  = sanitize(body);
        let safe_sound = sanitize(sound_name);

        let script = format!(
            r#"display notification "{safe_body}" with title "{safe_title}" sound name "{safe_sound}""#
        );
        Command::new("osascript")
            .args(["-e", &script])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("osascript spawn failed: {e}"))?;
        Ok(())
    }
}

/// Download a macOS DMG release, mount it, install the app bundle, and relaunch.
/// On non-macOS platforms returns an error immediately (no-op — only called on macOS).
#[tauri::command]
async fn install_update(download_url: String) -> Result<(), String> {
    // Validate the URL comes from GitHub
    let parsed = reqwest::Url::parse(&download_url)
        .map_err(|e| format!("Invalid update URL: {e}"))?;
    let host = parsed.host_str().unwrap_or("");
    if !matches!(host, "objects.githubusercontent.com" | "github.com" | "codeload.github.com") {
        return Err(format!("Update URL host '{host}' is not trusted — must be from github.com"));
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = download_url;
        return Err("Auto-install is only supported on macOS".into());
    }

    #[cfg(target_os = "macos")]
    {
        let tmp_dmg = "/tmp/wm-update.dmg";
        let mount_point = "/tmp/wm-update-vol";
        let cleanup_mount = || {
            let _ = Command::new("hdiutil").args(["detach", mount_point, "-quiet"]).output();
            let _ = std::fs::remove_file(tmp_dmg);
        };

        // 1. Download the DMG
        let client = reqwest::Client::builder()
            .use_native_tls()
            .user_agent(concat!("CrystalBall-Desktop/", env!("CARGO_PKG_VERSION")))
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| format!("HTTP client init failed: {e}"))?;

        let resp = client
            .get(&download_url)
            .send()
            .await
            .map_err(|e| format!("Download failed: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!("Download HTTP {}", resp.status()));
        }

        let bytes = resp.bytes().await
            .map_err(|e| format!("Download read failed: {e}"))?;

        std::fs::write(tmp_dmg, &bytes)
            .map_err(|e| format!("Write DMG to /tmp failed: {e}"))?;

        // 2. Mount the DMG
        let attach = Command::new("hdiutil")
            .args(["attach", tmp_dmg, "-mountpoint", mount_point, "-nobrowse", "-quiet"])
            .output()
            .map_err(|e| format!("hdiutil attach failed: {e}"))?;

        if !attach.status.success() {
            let _ = std::fs::remove_file(tmp_dmg);
            return Err(format!(
                "hdiutil attach error: {}",
                String::from_utf8_lossy(&attach.stderr)
            ));
        }

        // 3. Verify the app bundle identifier and code signature before replacing the installed app.
        //    This prevents a compromised GitHub account or MITM from replacing the app
        //    with a malicious binary that passes the host check but is not World Monitor.
        let source = PathBuf::from(mount_point).join("World Monitor.app");
        let dest = resolve_update_install_path()?;
        let parent = dest
            .parent()
            .ok_or_else(|| format!("Install path has no parent directory: {}", dest.display()))?
            .to_path_buf();
        let bundle_name = dest
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| format!("Install path has no bundle name: {}", dest.display()))?;
        let staged = parent.join(format!("{bundle_name}.update-staged"));
        let backup = parent.join(format!("{bundle_name}.update-backup"));
        fs::create_dir_all(&parent)
            .map_err(|e| format!("Failed to create install directory {}: {e}", parent.display()))?;

        // 3a. Verify macOS code signature — ensures binary was signed by the legitimate developer.
        //     --deep checks all nested bundles/frameworks, --strict applies additional requirements.
        if let Err(err) = verify_app_bundle_signature(&source, "Source app") {
            cleanup_mount();
            return Err(err);
        }

        const EXPECTED_BUNDLE_ID: &str = "com.bradleybond.worldmonitor";
        let plist = source.join("Contents").join("Info.plist");
        let id_check = Command::new("plutil")
            .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
            .arg(&plist)
            .output();
        match id_check {
            Ok(out) if out.status.success() => {
                let bundle_id = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if bundle_id != EXPECTED_BUNDLE_ID {
                    cleanup_mount();
                    return Err(format!(
                        "Bundle identifier mismatch: expected '{EXPECTED_BUNDLE_ID}', got '{bundle_id}'"
                    ));
                }
            }
            _ => {
                cleanup_mount();
                return Err("Could not verify bundle identifier — aborting update".into());
            }
        }

        remove_path_if_exists(&staged)?;
        remove_path_if_exists(&backup)?;

        let copy = Command::new("ditto")
            .arg(&source)
            .arg(&staged)
            .output()
            .map_err(|e| format!("ditto failed: {e}"))?;

        // 4. Detach the DMG and clean up regardless of copy result
        cleanup_mount();

        if !copy.status.success() {
            let _ = remove_path_if_exists(&staged);
            return Err(format!(
                "Copy to install path failed: {}",
                String::from_utf8_lossy(&copy.stderr)
            ));
        }

        if let Err(err) = verify_app_bundle_signature(&staged, "Staged app") {
            let _ = remove_path_if_exists(&staged);
            return Err(err);
        }

        let had_existing_install = dest.exists();
        if had_existing_install {
            fs::rename(&dest, &backup).map_err(|e| {
                let _ = remove_path_if_exists(&staged);
                format!(
                    "Failed to move current install into backup {}: {e}",
                    backup.display()
                )
            })?;
        }

        if let Err(rename_err) = fs::rename(&staged, &dest) {
            if had_existing_install {
                let _ = fs::rename(&backup, &dest);
            }
            let _ = remove_path_if_exists(&staged);
            return Err(format!(
                "Failed to move staged update into install path {}: {rename_err}",
                dest.display()
            ));
        }

        if let Err(err) = verify_app_bundle_signature(&dest, "Installed app") {
            let _ = remove_path_if_exists(&dest);
            if had_existing_install {
                fs::rename(&backup, &dest).map_err(|restore_err| {
                    format!(
                        "{err}. Restore from backup {} failed: {restore_err}",
                        backup.display()
                    )
                })?;
            }
            return Err(err);
        }

        let _ = remove_path_if_exists(&backup);

        // 5. Relaunch and exit
        let _ = open_path_in_shell(&dest);
        std::process::exit(0);
    }
}

/// Fetch JSON from Polymarket Gamma API using native TLS (bypasses Cloudflare JA3 blocking).
/// Called from frontend when browser CORS and sidecar Node.js TLS both fail.
#[tauri::command]
async fn fetch_polymarket(webview: Webview, path: String, params: String) -> Result<String, String> {
    require_trusted_window(webview.label())?;
    let allowed = ["events", "markets", "tags"];
    let segment = path.trim_start_matches('/');
    if !allowed.iter().any(|a| segment.starts_with(a)) {
        return Err("Invalid Polymarket path".into());
    }
    // Reject path traversal and unusual characters in the path segment
    if segment.contains("..") || segment.contains('\n') || segment.contains('\r') {
        return Err("Invalid characters in Polymarket path".into());
    }
    // Guard against extremely long params strings that could be used for log injection
    if params.len() > 2048 {
        return Err("Polymarket query params exceed maximum allowed length".into());
    }
    let url = format!("https://gamma-api.polymarket.com/{}?{}", segment, params);
    let client = reqwest::Client::builder()
        .use_native_tls()
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Polymarket fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Polymarket HTTP {}", resp.status()));
    }
    resp.text()
        .await
        .map_err(|e| format!("Read body failed: {e}"))
}

fn open_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus settings window: {e}"))?;
        return Ok(());
    }

    let _settings_window = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("World Monitor Settings")
        .inner_size(980.0, 760.0)
        .min_inner_size(820.0, 620.0)
        .resizable(true)
        .background_color(tauri::webview::Color(26, 28, 30, 255))
        .build()
        .map_err(|e| format!("Failed to create settings window: {e}"))?;

    // On Windows/Linux, menus are per-window. Remove the inherited app menu
    // from the settings window (macOS uses a shared app-wide menu bar instead).
    #[cfg(not(target_os = "macos"))]
    let _ = _settings_window.remove_menu();

    Ok(())
}

fn open_live_channels_window(app: &AppHandle, base_url: Option<String>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("live-channels") {
        let _ = window.show();
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus live channels window: {e}"))?;
        return Ok(());
    }

    // In dev, use the same origin as the main window (e.g. http://localhost:3001) so we don't
    // get "connection refused" when Vite runs on a different port than devUrl.
    let url = match base_url {
        Some(ref origin) if !origin.is_empty() => {
            let path = origin.trim_end_matches('/');
            let full_url = format!("{}/live-channels.html", path);
            WebviewUrl::External(Url::parse(&full_url).map_err(|_| "Invalid base URL".to_string())?)
        }
        _ => WebviewUrl::App("live-channels.html".into()),
    };

    let _live_channels_window = WebviewWindowBuilder::new(app, "live-channels", url)
    .title("Channel management - World Monitor")
    .inner_size(680.0, 760.0)
    .min_inner_size(520.0, 600.0)
    .resizable(true)
    .background_color(tauri::webview::Color(26, 28, 30, 255))
    .build()
    .map_err(|e| format!("Failed to create live channels window: {e}"))?;

    #[cfg(not(target_os = "macos"))]
    let _ = _live_channels_window.remove_menu();

    Ok(())
}

fn open_youtube_login_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("youtube-login") {
        let _ = window.show();
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus YouTube login window: {e}"))?;
        return Ok(());
    }

    let url = WebviewUrl::External(
        Url::parse("https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/")
            .map_err(|e| format!("Invalid URL: {e}"))?
    );

    let notified = Arc::new(AtomicBool::new(false));
    let notified_nav = notified.clone();
    let app_nav = app.clone();

    let _yt_window = WebviewWindowBuilder::new(app, "youtube-login", url)
        .title("Sign in to YouTube")
        .inner_size(500.0, 700.0)
        .resizable(true)
        .on_navigation(move |nav_url| {
            let host = nav_url.host_str().unwrap_or("");
            if (host == "www.youtube.com" || host == "youtube.com")
                && !notified_nav.swap(true, Ordering::SeqCst)
            {
                let app_clone = app_nav.clone();
                std::thread::spawn(move || {
                    if let Some(main_win) = app_clone.get_webview_window("main") {
                        let _ = main_win.eval(
                            "document.dispatchEvent(new CustomEvent('wm:youtube-signed-in'))"
                        );
                    }
                    std::thread::sleep(std::time::Duration::from_millis(800));
                    if let Some(w) = app_clone.get_webview_window("youtube-login") {
                        let _ = w.close();
                    }
                });
            }
            true
        })
        .build()
        .map_err(|e| format!("Failed to create YouTube login window: {e}"))?;

    #[cfg(not(target_os = "macos"))]
    let _ = _yt_window.remove_menu();

    Ok(())
}

#[tauri::command]
async fn open_youtube_login(app: AppHandle) -> Result<(), String> {
    open_youtube_login_window(&app)
}

#[tauri::command]
async fn open_youtube_logout(app: AppHandle) -> Result<(), String> {
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.eval(
            "document.dispatchEvent(new CustomEvent('wm:youtube-signed-out'))"
        );
    }
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
    let ghost_mode_item = MenuItem::with_id(
        handle,
        MENU_FILE_GHOST_MODE_ID,
        "Toggle Ghost Mode",
        true,
        Some("CmdOrCtrl+Shift+G"),
    )?;
    let separator = PredefinedMenuItem::separator(handle)?;
    let ghost_separator = PredefinedMenuItem::separator(handle)?;
    let quit_item = PredefinedMenuItem::quit(handle, Some("Quit"))?;
    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[&settings_item, &ghost_separator, &ghost_mode_item, &separator, &quit_item],
    )?;

    let about_metadata = AboutMetadata {
        name: Some("World Monitor".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        copyright: Some("\u{00a9} 2024\u{2013}2026 Elie Habib. Modifications \u{00a9} 2026 Bradley Bond.".into()),
        website: Some("https://github.com/bradleybond512/worldmonitor-macos".into()),
        website_label: Some("GitHub Repository".into()),
        ..Default::default()
    };
    let about_item =
        PredefinedMenuItem::about(handle, Some("About World Monitor"), Some(about_metadata))?;
    let github_item = MenuItem::with_id(
        handle,
        MENU_HELP_GITHUB_ID,
        "GitHub Repository",
        true,
        None::<&str>,
    )?;
    let check_updates_item = MenuItem::with_id(
        handle,
        MENU_HELP_CHECK_UPDATES_ID,
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    let open_logs_item = MenuItem::with_id(
        handle,
        MENU_HELP_OPEN_LOGS_ID,
        "Open Logs Folder",
        true,
        None::<&str>,
    )?;
    let help_separator = PredefinedMenuItem::separator(handle)?;
    let help_separator2 = PredefinedMenuItem::separator(handle)?;

    #[cfg(feature = "devtools")]
    let help_menu = {
        let devtools_item = MenuItem::with_id(
            handle,
            MENU_HELP_DEVTOOLS_ID,
            "Toggle Developer Tools",
            true,
            Some("CmdOrCtrl+Alt+I"),
        )?;
        Submenu::with_items(
            handle,
            "Help",
            true,
            &[&about_item, &help_separator, &check_updates_item, &github_item, &help_separator2, &open_logs_item, &devtools_item],
        )?
    };

    #[cfg(not(feature = "devtools"))]
    let help_menu = Submenu::with_items(
        handle,
        "Help",
        true,
        &[&about_item, &help_separator, &check_updates_item, &github_item, &help_separator2, &open_logs_item],
    )?;

    let window_menu = {
        let minimize = PredefinedMenuItem::minimize(handle, None)?;
        let maximize = PredefinedMenuItem::maximize(handle, None)?;
        let close = PredefinedMenuItem::close_window(handle, None)?;
        Submenu::with_items(handle, "Window", true, &[&minimize, &maximize, &close])?
    };

    let edit_menu = {
        let undo = PredefinedMenuItem::undo(handle, None)?;
        let redo = PredefinedMenuItem::redo(handle, None)?;
        let sep1 = PredefinedMenuItem::separator(handle)?;
        let cut = PredefinedMenuItem::cut(handle, None)?;
        let copy = PredefinedMenuItem::copy(handle, None)?;
        let paste = PredefinedMenuItem::paste(handle, None)?;
        let select_all = PredefinedMenuItem::select_all(handle, None)?;
        Submenu::with_items(
            handle,
            "Edit",
            true,
            &[&undo, &redo, &sep1, &cut, &copy, &paste, &select_all],
        )?
    };

    Menu::with_items(handle, &[&file_menu, &edit_menu, &window_menu, &help_menu])
}

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        MENU_FILE_SETTINGS_ID => {
            if let Err(err) = open_settings_window(app) {
                append_desktop_log(app, "ERROR", &format!("settings menu failed: {err}"));
                eprintln!("[tauri] settings menu failed: {err}");
            }
        }
        MENU_FILE_GHOST_MODE_ID => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.eval("document.dispatchEvent(new CustomEvent('wm:toggle-ghost-mode'))");
            }
        }
        MENU_HELP_GITHUB_ID => {
            let _ = open_in_shell("https://github.com/bradleybond512/worldmonitor-macos");
        }
        MENU_HELP_CHECK_UPDATES_ID => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.eval("document.dispatchEvent(new CustomEvent('wm:check-for-updates'))");
            }
        }
        MENU_HELP_OPEN_LOGS_ID => {
            let _ = open_logs_folder_impl(app);
        }
        #[cfg(feature = "devtools")]
        MENU_HELP_DEVTOOLS_ID => {
            if let Some(window) = app.get_webview_window("main") {
                if window.is_devtools_open() {
                    window.close_devtools();
                } else {
                    window.open_devtools();
                }
            }
        }
        _ => {}
    }
}

/// Strip Windows extended-length path prefixes that `canonicalize()` adds.
/// Preserve UNC semantics: `\\?\UNC\server\share\...` must become
/// `\\server\share\...` (not `UNC\server\share\...`).
fn sanitize_path_for_node(p: &Path) -> String {
    let s = p.to_string_lossy();
    if let Some(stripped_unc) = s.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{stripped_unc}")
    } else if let Some(stripped) = s.strip_prefix("\\\\?\\") {
        stripped.to_string()
    } else {
        s.into_owned()
    }
}

#[cfg(test)]
mod sanitize_path_tests {
    use super::sanitize_path_for_node;
    use std::path::Path;

    #[test]
    fn strips_extended_drive_prefix() {
        let raw = Path::new(r"\\?\C:\Program Files\nodejs\node.exe");
        assert_eq!(
            sanitize_path_for_node(raw),
            r"C:\Program Files\nodejs\node.exe".to_string()
        );
    }

    #[test]
    fn strips_extended_unc_prefix_and_preserves_unc_root() {
        let raw = Path::new(r"\\?\UNC\server\share\sidecar\local-api-server.mjs");
        assert_eq!(
            sanitize_path_for_node(raw),
            r"\\server\share\sidecar\local-api-server.mjs".to_string()
        );
    }

    #[test]
    fn leaves_standard_paths_unchanged() {
        let raw = Path::new(r"C:\Users\alice\sidecar\local-api-server.mjs");
        assert_eq!(
            sanitize_path_for_node(raw),
            r"C:\Users\alice\sidecar\local-api-server.mjs".to_string()
        );
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

fn resolve_node_binary(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(explicit) = env::var("LOCAL_API_NODE_BIN") {
        let explicit_path = PathBuf::from(explicit);
        if explicit_path.is_file() {
            return Some(explicit_path);
        }
        append_desktop_log(
            app,
            "WARN",
            &format!(
                "LOCAL_API_NODE_BIN is set but not a valid file: {}",
                explicit_path.display()
            ),
        );
    }

    if !cfg!(debug_assertions) {
        let node_name = if cfg!(windows) { "node.exe" } else { "node" };
        if let Ok(resource_dir) = app.path().resource_dir() {
            let mut candidates = vec![resource_dir.join("sidecar").join("node").join(node_name)];
            if cfg!(windows) {
                // NSIS resource paths can flatten nested names in some upgrade scenarios.
                // Keep this fallback so sidecar startup still succeeds if the runtime is
                // materialized as sidecar\node.node.exe instead of sidecar\node\node.exe.
                candidates.push(resource_dir.join("sidecar").join("node.node.exe"));
            }
            for bundled in candidates {
                if bundled.is_file() {
                    return Some(bundled);
                }
            }
        }
    }

    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    if let Some(path_var) = env::var_os("PATH") {
        for dir in env::split_paths(&path_var) {
            let candidate = dir.join(node_name);
            if candidate.is_file() {
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

    common_locations.into_iter().find(|path| path.is_file())
}

fn read_port_file(path: &Path, timeout_ms: u64) -> Option<u16> {
    let start = std::time::Instant::now();
    let interval = std::time::Duration::from_millis(100);
    let timeout = std::time::Duration::from_millis(timeout_ms);
    while start.elapsed() < timeout {
        if let Ok(contents) = fs::read_to_string(path) {
            if let Ok(port) = contents.trim().parse::<u16>() {
                if port > 0 {
                    return Some(port);
                }
            }
        }
        std::thread::sleep(interval);
    }
    None
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

    // Clear port state for fresh start
    if let Ok(mut port_slot) = state.port.lock() {
        *port_slot = None;
    }

    let (script, resource_root) = local_api_paths(app);
    if !script.exists() {
        return Err(format!(
            "Local API sidecar script missing at {}",
            script.display()
        ));
    }
    let node_binary = resolve_node_binary(app).ok_or_else(|| {
        "Node.js executable not found. Install Node 18+ or set LOCAL_API_NODE_BIN".to_string()
    })?;

    let port_file = logs_dir_path(app)?.join("sidecar.port");
    let _ = fs::remove_file(&port_file);

    let log_path = sidecar_log_path(app)?;
    rotate_log_if_needed(&log_path);
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
    append_desktop_log(
        app,
        "INFO",
        &format!("resolved node binary={}", node_binary.display()),
    );
    append_desktop_log(
        app,
        "INFO",
        &format!(
            "local API sidecar preferred port={} port_file={}",
            DEFAULT_LOCAL_API_PORT,
            port_file.display()
        ),
    );

    // Generate a unique token for local API auth (prevents other local processes from accessing sidecar)
    let mut token_slot = state
        .token
        .lock()
        .map_err(|_| "Failed to lock token slot")?;
    if token_slot.is_none() {
        *token_slot = Some(generate_local_token());
    }
    let local_api_token = token_slot.clone().unwrap();
    drop(token_slot);

    let mut cmd = Command::new(&node_binary);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW — hide the node.exe console
                                    // Sanitize paths for Node.js on Windows: strip \\?\ UNC prefix and set
                                    // explicit working directory to avoid bare drive-letter CWD issues that
                                    // cause EISDIR errors in Node.js module resolution.
    let script_for_node = sanitize_path_for_node(&script);
    let resource_for_node = sanitize_path_for_node(&resource_root);
    append_desktop_log(
        app,
        "INFO",
        &format!("node args: script={script_for_node} resource_dir={resource_for_node}"),
    );
    let data_dir = logs_dir_path(app)
        .map(|p| sanitize_path_for_node(&p))
        .unwrap_or_else(|_| resource_for_node.clone());
    cmd.arg(&script_for_node)
        .env("LOCAL_API_PORT", DEFAULT_LOCAL_API_PORT.to_string())
        .env("LOCAL_API_PORT_FILE", &port_file)
        .env("LOCAL_API_RESOURCE_DIR", &resource_for_node)
        .env("LOCAL_API_DATA_DIR", &data_dir)
        .env("LOCAL_API_MODE", "tauri-sidecar")
        .env("LOCAL_API_TOKEN", &local_api_token)
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err));
    if let Some(parent) = script.parent() {
        cmd.current_dir(parent);
    }

    // Pass cached keychain secrets to sidecar as env vars (no keychain re-read)
    let mut secret_count = 0u32;
    let secrets_cache = app.state::<SecretsCache>();
    if let Ok(secrets) = secrets_cache.secrets.lock() {
        for (key, value) in secrets.iter() {
            cmd.env(key, value);
            secret_count += 1;
        }
    }
    append_desktop_log(
        app,
        "INFO",
        &format!("injected {secret_count} keychain secrets into sidecar env"),
    );

    // Inject build-time secrets (CI) with runtime env fallback (dev)
    if let Some(url) = option_env!("CONVEX_URL") {
        cmd.env("CONVEX_URL", url);
    } else if let Ok(url) = std::env::var("CONVEX_URL") {
        cmd.env("CONVEX_URL", url);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch local API: {e}"))?;
    append_desktop_log(
        app,
        "INFO",
        &format!("local API sidecar started pid={}", child.id()),
    );
    *slot = Some(child);
    drop(slot);

    // Wait for sidecar to write confirmed port (up to 5s)
    if let Some(confirmed_port) = read_port_file(&port_file, 5000) {
        append_desktop_log(
            app,
            "INFO",
            &format!("sidecar confirmed port={confirmed_port}"),
        );
        if let Ok(mut port_slot) = state.port.lock() {
            *port_slot = Some(confirmed_port);
        }
    } else {
        append_desktop_log(
            app,
            "WARN",
            "sidecar port file not found within timeout, using default",
        );
        if let Ok(mut port_slot) = state.port.lock() {
            *port_slot = Some(DEFAULT_LOCAL_API_PORT);
        }
    }

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
        if let Ok(mut port_slot) = state.port.lock() {
            *port_slot = None;
        }
        if let Ok(log_dir) = logs_dir_path(app) {
            let _ = fs::remove_file(log_dir.join("sidecar.port"));
        }
    }
}

#[cfg(target_os = "linux")]
fn resolve_appimage_gio_module_dir() -> Option<PathBuf> {
    let appdir = env::var_os("APPDIR")?;
    let appdir = PathBuf::from(appdir);

    // Common layouts produced by AppImage/linuxdeploy on Debian and RPM families.
    let preferred = [
        "usr/lib/gio/modules",
        "usr/lib64/gio/modules",
        "usr/lib/x86_64-linux-gnu/gio/modules",
        "usr/lib/aarch64-linux-gnu/gio/modules",
        "usr/lib/arm-linux-gnueabihf/gio/modules",
        "lib/gio/modules",
        "lib64/gio/modules",
    ];

    for relative in preferred {
        let candidate = appdir.join(relative);
        if candidate.is_dir() {
            return Some(candidate);
        }
    }

    // Fallback: probe one level of arch-specific directories, e.g. usr/lib/<triplet>/gio/modules.
    for lib_root in ["usr/lib", "usr/lib64", "lib", "lib64"] {
        let root = appdir.join(lib_root);
        if !root.is_dir() {
            continue;
        }
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let candidate = entry.path().join("gio/modules");
            if candidate.is_dir() {
                return Some(candidate);
            }
        }
    }

    None
}

fn main() {
    // Work around WebKitGTK rendering issues on Linux that can cause blank white
    // screens. DMA-BUF renderer failures are common with NVIDIA drivers and on
    // immutable distros (e.g. Bazzite/Fedora Atomic).  Setting the env var before
    // WebKit initialises forces a software fallback path.  Only set when the user
    // hasn't explicitly configured the variable.
    #[cfg(target_os = "linux")]
    {
        if env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            // SAFETY: called before any threads are spawned (Tauri hasn't started yet).
            unsafe { env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
        }

        // WebKitGTK promotes iframes, <video>, and canvas to GPU-textured
        // compositing layers.  In VMs (Apple Virtualization.framework,
        // QEMU/KVM, VMware, etc.) the virtio-gpu driver often only supports
        // 2D or limited GL — GBM buffer allocation for compositing layers
        // fails silently, rendering iframe/video content as black while the
        // main page (software-tiled) works fine.
        //
        // Detect VM environments via /proc/cpuinfo "hypervisor" flag or
        // sys_vendor strings and disable accelerated compositing + force
        // software GL so all content renders through the CPU path.
        let in_vm = std::fs::read_to_string("/proc/cpuinfo")
            .map(|c| c.contains("hypervisor"))
            .unwrap_or(false)
            || std::fs::read_to_string("/sys/class/dmi/id/sys_vendor")
                .map(|v| {
                    let v = v.trim().to_lowercase();
                    v.contains("qemu") || v.contains("vmware") || v.contains("virtualbox")
                        || v.contains("apple") || v.contains("parallels") || v.contains("xen")
                        || v.contains("microsoft") || v.contains("innotek")
                })
                .unwrap_or(false);

        if in_vm {
            if env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
                unsafe { env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1") };
            }
            if env::var_os("LIBGL_ALWAYS_SOFTWARE").is_none() {
                unsafe { env::set_var("LIBGL_ALWAYS_SOFTWARE", "1") };
            }
            eprintln!("[tauri] VM detected; disabled WebKitGTK accelerated compositing for iframe/video compatibility");
        }

        // NVIDIA proprietary drivers often fail to create a surfaceless EGL
        // display (EGL_BAD_ALLOC) in WebKitGTK's web process, especially on
        // Wayland where explicit sync can also cause flickering/crashes.
        // Detect NVIDIA by checking for /proc/driver/nvidia (created by
        // nvidia.ko) and apply Wayland-specific workarounds.
        let has_nvidia = std::path::Path::new("/proc/driver/nvidia").exists();
        if has_nvidia {
            if env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_none() {
                unsafe { env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1") };
            }
            // Force X11 backend on NVIDIA + Wayland to avoid surfaceless EGL
            // failures.  Users who prefer native Wayland can override with
            // GDK_BACKEND=wayland.
            if env::var_os("WAYLAND_DISPLAY").is_some() && env::var_os("GDK_BACKEND").is_none() {
                unsafe { env::set_var("GDK_BACKEND", "x11") };
                eprintln!(
                    "[tauri] NVIDIA GPU + Wayland detected; forcing GDK_BACKEND=x11 to avoid EGL_BAD_ALLOC. \
                     Set GDK_BACKEND=wayland to override."
                );
            }
        }

        // On Wayland-only compositors (e.g. niri, river, sway without XWayland),
        // GTK3 may fail to initialise if it defaults to X11 backend first and no
        // DISPLAY is set.  Explicitly prefer the Wayland backend when a Wayland
        // display is available.  Falls back to X11 if Wayland init fails.
        if env::var_os("WAYLAND_DISPLAY").is_some() && env::var_os("GDK_BACKEND").is_none() {
            unsafe { env::set_var("GDK_BACKEND", "wayland,x11") };
        }

        // Work around GLib version mismatch when running as an AppImage on newer
        // distros.  The AppImage bundles GLib from the CI build system (Ubuntu
        // 24.04, GLib 2.80).  Host GIO modules (e.g. GVFS's libgvfsdbus.so) may
        // link against newer GLib symbols absent in the bundled copy, producing:
        //   "undefined symbol: g_task_set_static_name"
        // Point GIO_MODULE_DIR at the AppImage's bundled modules to isolate from
        // host libraries.  Also disable the WebKit bubblewrap sandbox which fails
        // inside AppImage's FUSE mount (causes blank screen on many distros).
        if env::var_os("APPIMAGE").is_some() && env::var_os("GIO_MODULE_DIR").is_none() {
            if let Some(module_dir) = resolve_appimage_gio_module_dir() {
                unsafe { env::set_var("GIO_MODULE_DIR", &module_dir) };
            } else if env::var_os("GIO_USE_VFS").is_none() {
                // Last-resort fallback: prefer local VFS backend if module path
                // discovery fails, which reduces GVFS dependency surface.
                unsafe { env::set_var("GIO_USE_VFS", "local") };
                eprintln!(
                    "[tauri] APPIMAGE detected but bundled gio/modules not found; using GIO_USE_VFS=local fallback"
                );
            }
        }

        // WebKit2GTK's bubblewrap sandbox can fail inside an AppImage FUSE
        // mount, causing blank white screens. Disable it when running as
        // AppImage — the AppImage itself already provides isolation.
        if env::var_os("APPIMAGE").is_some() {
            // WebKitGTK 2.39.3+ deprecated WEBKIT_FORCE_SANDBOX and now expects
            // WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 instead.  Setting the
            // old variable on newer WebKitGTK triggers a noisy deprecation
            // warning in the system journal, so only set the new one.
            if env::var_os("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS").is_none() {
                unsafe { env::set_var("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1") };
            }
            // Prevent GTK from loading host input-method modules that may
            // link against incompatible library versions.
            if env::var_os("GTK_IM_MODULE").is_none() {
                unsafe { env::set_var("GTK_IM_MODULE", "gtk-im-context-simple") };
            }

            // The linuxdeploy GStreamer hook sets GST_PLUGIN_PATH_1_0 and
            // GST_PLUGIN_SYSTEM_PATH_1_0 to only contain bundled plugins.
            // CI installs the full GStreamer codec suite (base, good, bad,
            // ugly, libav, gl) so bundleMediaFramework=true bundles everything.
            //
            // IMPORTANT: Do NOT append host plugin directories — mixing plugins
            // compiled against a different GStreamer version causes ABI mismatches
            // (undefined symbol errors like gst_util_floor_log2, mpg123_open_handle64)
            // and leaves WebKit without usable codecs.  The AppImage must be fully
            // self-contained for GStreamer.
            //
            // If the linuxdeploy hook didn't set the paths (shouldn't happen),
            // explicitly block host plugin scanning to prevent ABI conflicts.
            if env::var_os("GST_PLUGIN_SYSTEM_PATH_1_0").is_none() {
                // Empty string prevents GStreamer from scanning /usr/lib/gstreamer-1.0
                unsafe { env::set_var("GST_PLUGIN_SYSTEM_PATH_1_0", "") };
            }
        }
    }

    tauri::Builder::default()
        .menu(build_app_menu)
        .on_menu_event(handle_menu_event)
        .manage(LocalApiState::default())
        .manage(SecretsCache::load_from_keychain())
        .plugin(tauri_plugin_biometry::init())
        .invoke_handler(tauri::generate_handler![
            list_supported_secret_keys,
            get_secret,
            get_all_secrets,
            set_secret,
            delete_secret,
            get_local_api_token,
            get_local_api_port,
            get_desktop_runtime_info,
            read_cache_entry,
            write_cache_entry,
            delete_cache_entry,
            open_logs_folder,
            open_sidecar_log_file,
            open_settings_window_command,
            close_settings_window,
            open_live_channels_window_command,
            close_live_channels_window,
            open_url,
            open_youtube_login,
            open_youtube_logout,
            fetch_polymarket,
            send_notification,
            install_update
        ])
        .setup(|app| {
            // Load persistent cache into memory (avoids 14MB file I/O on every IPC call)
            let cache_path = cache_file_path(&app.handle()).unwrap_or_default();
            app.manage(PersistentCache::load(&cache_path));

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
        .expect("error while running worldmonitor-macos tauri application")
        .run(|app, event| {
            match &event {
                // macOS: hide window on close instead of quitting (standard behavior)
                #[cfg(target_os = "macos")]
                RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::CloseRequested { api, .. },
                    ..
                } if label == "main" => {
                    api.prevent_close();
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
                // macOS: reshow window when dock icon is clicked
                #[cfg(target_os = "macos")]
                RunEvent::Reopen { .. } => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                // Only macOS needs explicit re-raising to keep settings above the main window.
                // On Windows, focusing the settings window here can trigger rapid focus churn
                // between windows and present as a UI hang.
                #[cfg(target_os = "macos")]
                RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::Focused(true),
                    ..
                } if label == "main" => {
                    if let Some(sw) = app.get_webview_window("settings") {
                        let _ = sw.show();
                        let _ = sw.set_focus();
                    }
                }
                RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                    // Flush in-memory cache to disk before quitting
                    if let Ok(path) = cache_file_path(app) {
                        if let Some(cache) = app.try_state::<PersistentCache>() {
                            let _ = cache.flush(&path, true);
                        }
                    }
                    stop_local_api(app);
                }
                _ => {}
            }
        });
}
