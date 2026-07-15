#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use parking_lot::Mutex;
use rand::distr::{Alphanumeric, SampleString};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command as ProcessCommand,
    sync::Arc,
    time::Duration,
};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    phase: String,
    message: String,
    proxy_port: Option<u16>,
    control_port: Option<u16>,
    pool: Option<Value>,
}

#[derive(Clone, Serialize)]
struct LogPayload {
    level: String,
    message: String,
}

struct RuntimeState {
    child: Option<CommandChild>,
    phase: String,
    message: String,
    proxy_port: Option<u16>,
    control_port: Option<u16>,
    control_token: Option<String>,
    generation: u64,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            child: None,
            phase: "stopped".into(),
            message: "Ready to find an exit".into(),
            proxy_port: None,
            control_port: None,
            control_token: None,
            generation: 0,
        }
    }
}

struct AppState {
    runtime: Arc<Mutex<RuntimeState>>,
    client: reqwest::Client,
}

impl AppState {
    fn new() -> Self {
        Self {
            runtime: Arc::new(Mutex::new(RuntimeState::default())),
            client: reqwest::Client::new(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartConfig {
    country: String,
    rank_mode: String,
    max_candidates: u16,
    pool_size: u8,
    auto_fallback: bool,
}

fn snapshot(runtime: &RuntimeState, pool: Option<Value>) -> DesktopStatus {
    DesktopStatus {
        phase: runtime.phase.clone(),
        message: runtime.message.clone(),
        proxy_port: runtime.proxy_port,
        control_port: runtime.control_port,
        pool,
    }
}

fn emit_state(app: &AppHandle, runtime: &Arc<Mutex<RuntimeState>>) {
    let value = snapshot(&runtime.lock(), None);
    let _ = app.emit("engine-state", value);
}

fn emit_log(app: &AppHandle, level: &str, message: impl Into<String>) {
    let _ = app.emit(
        "engine-log",
        LogPayload {
            level: level.into(),
            message: message.into(),
        },
    );
}

fn process_engine_line(
    app: &AppHandle,
    runtime: &Arc<Mutex<RuntimeState>>,
    generation: u64,
    line: &str,
) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let parsed: Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(_) => {
            emit_log(app, "info", trimmed);
            return;
        }
    };
    let event = parsed.get("event").and_then(Value::as_str).unwrap_or("log");
    match event {
        "log" => {
            let level = parsed
                .get("level")
                .and_then(Value::as_str)
                .unwrap_or("info");
            let message = parsed
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or(trimmed);
            emit_log(app, level, message);
            let mut inner = runtime.lock();
            if inner.generation == generation && inner.phase == "starting" {
                inner.message = message.into();
            }
        }
        "ready" => {
            let status = parsed.get("status");
            let has_exit = status
                .and_then(|value| value.get("current"))
                .map(|current| !current.is_null())
                .unwrap_or(false);
            let country = status
                .and_then(|value| value.get("country"))
                .and_then(Value::as_str)
                .unwrap_or("selected");
            let mut inner = runtime.lock();
            if inner.generation == generation {
                inner.phase = "running".into();
                inner.message = if has_exit {
                    format!("{country} exit is active")
                } else {
                    "No working exit yet — use Refresh to try again".into()
                };
            }
            drop(inner);
            emit_state(app, runtime);
            if let Some(status) = status {
                let _ = app.emit("pool-updated", status.clone());
            }
        }
        "pool-updated" => {
            if let Some(status) = parsed.get("status") {
                let _ = app.emit("pool-updated", status.clone());
            }
        }
        "fatal" => {
            let message = parsed
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Proxy engine failed");
            let mut inner = runtime.lock();
            if inner.generation == generation {
                inner.phase = "error".into();
                inner.message = message.lines().next().unwrap_or(message).into();
            }
            drop(inner);
            emit_log(app, "error", message);
            emit_state(app, runtime);
        }
        _ => emit_log(app, "info", trimmed),
    }
}

#[tauri::command]
async fn start_engine(
    app: AppHandle,
    state: State<'_, AppState>,
    config: StartConfig,
) -> Result<DesktopStatus, String> {
    let country = config.country.trim().to_ascii_uppercase();
    if country.len() != 2 || !country.bytes().all(|value| value.is_ascii_alphabetic()) {
        return Err("Country must be a two-letter code".into());
    }
    if !matches!(config.rank_mode.as_str(), "speed" | "balanced" | "consumer") {
        return Err("Ranking must be speed, balanced, or consumer".into());
    }
    if !(20..=500).contains(&config.max_candidates) {
        return Err("Candidate sample must be between 20 and 500".into());
    }
    if !(1..=20).contains(&config.pool_size) {
        return Err("Pool size must be between 1 and 20".into());
    }

    // Firefox reads proxy preferences only at profile startup. Stable ports keep an already-open
    // dedicated profile valid across engine and app restarts.
    let proxy_port = 17877;
    let control_port = 17878;
    let control_token = Alphanumeric.sample_string(&mut rand::rng(), 48);
    let command = app
        .shell()
        .sidecar("meshhop-engine")
        .map_err(|error| error.to_string())?;

    let generation = {
        let mut inner = state.runtime.lock();
        if inner.child.is_some() {
            return Err("The proxy engine is already running".into());
        }
        inner.generation += 1;
        inner.phase = "starting".into();
        inner.message = format!("Testing published {country} exits…");
        inner.proxy_port = Some(proxy_port);
        inner.control_port = Some(control_port);
        inner.control_token = Some(control_token.clone());
        inner.generation
    };
    emit_state(&app, &state.runtime);

    let command = command
        .env("COUNTRY", &country)
        .env("RANK_MODE", &config.rank_mode)
        .env("LISTEN_PORT", proxy_port.to_string())
        .env("CONTROL_PORT", control_port.to_string())
        .env("CONTROL_TOKEN", &control_token)
        .env("MAX_CANDIDATES", config.max_candidates.to_string())
        .env("POOL_SIZE", config.pool_size.to_string())
        .env(
            "AUTO_FALLBACK",
            if config.auto_fallback { "1" } else { "0" },
        )
        .env("PROBE_CONCURRENCY", "40")
        .env("PROBE_TIMEOUT_MS", "7000")
        .env("CONNECT_TIMEOUT_MS", "5000")
        .env("MAX_ATTEMPTS", "3")
        .env("REFRESH_MINUTES", "10");

    let (mut receiver, child) = match command.spawn() {
        Ok(value) => value,
        Err(error) => {
            let mut inner = state.runtime.lock();
            inner.phase = "error".into();
            inner.message = error.to_string();
            inner.proxy_port = None;
            inner.control_port = None;
            inner.control_token = None;
            return Err(error.to_string());
        }
    };
    state.runtime.lock().child = Some(child);

    let runtime = state.runtime.clone();
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut stdout_buffer = String::new();
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    stdout_buffer.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(index) = stdout_buffer.find('\n') {
                        let line = stdout_buffer[..index].to_string();
                        stdout_buffer.drain(..=index);
                        process_engine_line(&app_handle, &runtime, generation, &line);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    emit_log(
                        &app_handle,
                        "warn",
                        String::from_utf8_lossy(&bytes).trim().to_string(),
                    );
                }
                CommandEvent::Error(message) => emit_log(&app_handle, "error", message),
                CommandEvent::Terminated(_) => {
                    if !stdout_buffer.trim().is_empty() {
                        process_engine_line(
                            &app_handle,
                            &runtime,
                            generation,
                            stdout_buffer.trim(),
                        );
                    }
                    let mut inner = runtime.lock();
                    if inner.generation == generation {
                        inner.child = None;
                        inner.proxy_port = None;
                        inner.control_port = None;
                        inner.control_token = None;
                        if inner.phase != "stopped" && inner.phase != "error" {
                            inner.phase = "error".into();
                            inner.message = "Proxy engine stopped unexpectedly".into();
                        }
                    }
                    drop(inner);
                    emit_state(&app_handle, &runtime);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(snapshot(&state.runtime.lock(), None))
}

#[tauri::command]
fn stop_engine(app: AppHandle, state: State<'_, AppState>) -> Result<DesktopStatus, String> {
    let child = {
        let mut inner = state.runtime.lock();
        inner.phase = "stopped".into();
        inner.message = "Proxy stopped".into();
        inner.proxy_port = None;
        inner.control_port = None;
        inner.control_token = None;
        inner.child.take()
    };
    if let Some(child) = child {
        child.kill().map_err(|error| error.to_string())?;
    }
    emit_state(&app, &state.runtime);
    Ok(snapshot(&state.runtime.lock(), None))
}

#[tauri::command]
async fn engine_status(state: State<'_, AppState>) -> Result<DesktopStatus, String> {
    let (base, control_port, control_token) = {
        let inner = state.runtime.lock();
        (
            snapshot(&inner, None),
            inner.control_port,
            inner.control_token.clone(),
        )
    };
    let Some(port) = control_port else {
        return Ok(base);
    };
    if base.phase != "running" {
        return Ok(base);
    }
    let mut request = state
        .client
        .get(format!("http://127.0.0.1:{port}/api/status"))
        .timeout(Duration::from_secs(3));
    if let Some(token) = control_token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await;
    match response {
        Ok(response) if response.status().is_success() => {
            let pool = response
                .json::<Value>()
                .await
                .map_err(|error| error.to_string())?;
            Ok(DesktopStatus {
                pool: Some(pool),
                ..base
            })
        }
        _ => Ok(base),
    }
}

async fn post_control(state: &AppState, action: &str, timeout: u64) -> Result<Value, String> {
    let (port, control_token) = {
        let inner = state.runtime.lock();
        (
            inner
                .control_port
                .ok_or_else(|| "Start the proxy first".to_string())?,
            inner.control_token.clone(),
        )
    };
    let mut request = state
        .client
        .post(format!("http://127.0.0.1:{port}/api/{action}"))
        .timeout(Duration::from_secs(timeout));
    if let Some(token) = control_token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Engine returned HTTP {}", response.status()));
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn rotate_exit(state: State<'_, AppState>) -> Result<Value, String> {
    post_control(&state, "rotate", 10).await
}

#[tauri::command]
async fn refresh_exits(state: State<'_, AppState>) -> Result<Value, String> {
    // Steady-state speed measurement with a second confirming sample makes a full
    // refresh take longer; allow generous headroom before the request times out.
    post_control(&state, "refresh", 180).await
}

fn first_existing(candidates: Vec<(&'static str, PathBuf)>) -> Option<(&'static str, PathBuf)> {
    candidates.into_iter().find(|(_, path)| path.is_file())
}

const UBLOCK_XPI: &str = "resources/uBlock0_1.72.2.firefox.signed.xpi";
const UBLOCK_ID: &str = "uBlock0@raymondhill.net";

#[cfg(target_os = "windows")]
fn firefox_binary() -> Option<PathBuf> {
    let program_files = env::var_os("ProgramFiles").map(PathBuf::from);
    let program_files_x86 = env::var_os("ProgramFiles(x86)").map(PathBuf::from);
    first_existing(vec![
        (
            "Firefox",
            program_files
                .unwrap_or_default()
                .join("Mozilla Firefox/firefox.exe"),
        ),
        (
            "Firefox",
            program_files_x86
                .unwrap_or_default()
                .join("Mozilla Firefox/firefox.exe"),
        ),
    ])
    .map(|(_, path)| path)
}

#[cfg(target_os = "macos")]
fn firefox_binary() -> Option<PathBuf> {
    first_existing(vec![(
        "Firefox",
        PathBuf::from("/Applications/Firefox.app/Contents/MacOS/firefox"),
    )])
    .map(|(_, path)| path)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn firefox_binary() -> Option<PathBuf> {
    first_existing(vec![
        ("Firefox", PathBuf::from("/usr/bin/firefox")),
        ("Firefox", PathBuf::from("/usr/bin/firefox-esr")),
        ("Firefox", PathBuf::from("/snap/bin/firefox")),
    ])
    .map(|(_, path)| path)
}

// A Chromium-family fallback (Chrome, Chromium, or Edge) for users without
// Firefox. It gets a proxied, isolated profile but not the bundled uBlock Origin,
// which ships as a Firefox XPI.
#[cfg(target_os = "windows")]
fn chromium_binary() -> Option<(&'static str, PathBuf)> {
    let program_files = env::var_os("ProgramFiles").map(PathBuf::from);
    let program_files_x86 = env::var_os("ProgramFiles(x86)").map(PathBuf::from);
    let local = env::var_os("LOCALAPPDATA").map(PathBuf::from);
    first_existing(vec![
        (
            "Google Chrome",
            program_files
                .clone()
                .unwrap_or_default()
                .join("Google/Chrome/Application/chrome.exe"),
        ),
        (
            "Google Chrome",
            program_files_x86
                .clone()
                .unwrap_or_default()
                .join("Google/Chrome/Application/chrome.exe"),
        ),
        (
            "Google Chrome",
            local
                .unwrap_or_default()
                .join("Google/Chrome/Application/chrome.exe"),
        ),
        (
            "Microsoft Edge",
            program_files_x86
                .unwrap_or_default()
                .join("Microsoft/Edge/Application/msedge.exe"),
        ),
        (
            "Microsoft Edge",
            program_files
                .unwrap_or_default()
                .join("Microsoft/Edge/Application/msedge.exe"),
        ),
    ])
}

#[cfg(target_os = "macos")]
fn chromium_binary() -> Option<(&'static str, PathBuf)> {
    first_existing(vec![
        (
            "Google Chrome",
            PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ),
        (
            "Chromium",
            PathBuf::from("/Applications/Chromium.app/Contents/MacOS/Chromium"),
        ),
        (
            "Microsoft Edge",
            PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        ),
    ])
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn chromium_binary() -> Option<(&'static str, PathBuf)> {
    first_existing(vec![
        ("Google Chrome", PathBuf::from("/usr/bin/google-chrome")),
        ("Chromium", PathBuf::from("/usr/bin/chromium")),
        ("Chromium", PathBuf::from("/usr/bin/chromium-browser")),
        ("Microsoft Edge", PathBuf::from("/usr/bin/microsoft-edge")),
    ])
}

fn meshhop_data_root() -> PathBuf {
    env::var_os("LOCALAPPDATA")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(".").to_path_buf())
        .join("MeshHop")
}

fn prepare_firefox_profile(app: &AppHandle, profile: &Path, proxy_port: u16) -> Result<(), String> {
    let extension_dir = profile.join("extensions");
    fs::create_dir_all(&extension_dir).map_err(|error| error.to_string())?;

    let bundled_xpi = app
        .path()
        .resolve(UBLOCK_XPI, BaseDirectory::Resource)
        .map_err(|error| format!("Unable to locate bundled uBlock Origin: {error}"))?;
    if !bundled_xpi.is_file() {
        return Err(format!(
            "Bundled uBlock Origin is missing: {}",
            bundled_xpi.display()
        ));
    }
    let installed_xpi = extension_dir.join(format!("{UBLOCK_ID}.xpi"));
    let needs_copy = match (fs::metadata(&bundled_xpi), fs::metadata(&installed_xpi)) {
        (Ok(source), Ok(installed)) => source.len() != installed.len(),
        (Ok(_), Err(_)) => true,
        (Err(error), _) => return Err(error.to_string()),
    };
    if needs_copy {
        fs::copy(&bundled_xpi, &installed_xpi).map_err(|error| error.to_string())?;
    }

    let preferences = format!(
        r#"// Managed by MeshHop. Applied to this dedicated profile only.
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.installDistroAddons", true);
user_pref("network.proxy.type", 1);
user_pref("network.proxy.http", "127.0.0.1");
user_pref("network.proxy.http_port", {proxy_port});
user_pref("network.proxy.ssl", "127.0.0.1");
user_pref("network.proxy.ssl_port", {proxy_port});
user_pref("network.proxy.share_proxy_settings", true);
user_pref("network.proxy.no_proxies_on", "localhost, 127.0.0.1");
user_pref("network.dns.disablePrefetch", true);
user_pref("network.prefetch-next", false);
user_pref("media.peerconnection.ice.default_address_only", true);
user_pref("media.peerconnection.ice.proxy_only_if_behind_proxy", true);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.startup.homepage_welcome_url", "");
user_pref("browser.startup.homepage_welcome_url.additional", "");
"#,
    );
    fs::write(profile.join("user.js"), preferences).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_browser(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let proxy_port = {
        let inner = state.runtime.lock();
        if inner.phase != "running" {
            return Err("Wait for a working exit before opening the browser".into());
        }
        inner
            .proxy_port
            .ok_or_else(|| "Proxy port is unavailable".to_string())?
    };
    // Prefer Firefox, which gets the full hardened profile with bundled uBlock
    // Origin. Fall back to a Chromium-family browser (proxied, isolated profile,
    // but no uBlock) so users without Firefox can still route their traffic.
    if let Some(executable) = firefox_binary() {
        let profile_root = meshhop_data_root().join("FirefoxProfile-v2");
        prepare_firefox_profile(&app, &profile_root, proxy_port)?;
        ProcessCommand::new(executable)
            .args([
                "-no-remote".into(),
                "-profile".into(),
                profile_root.display().to_string(),
                "https://ipwho.is/".into(),
            ])
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok("Opened dedicated Firefox with uBlock Origin".into());
    }

    if let Some((name, executable)) = chromium_binary() {
        let profile_root = meshhop_data_root().join("ChromiumProfile");
        fs::create_dir_all(&profile_root).map_err(|error| error.to_string())?;
        ProcessCommand::new(executable)
            .args([
                format!("--user-data-dir={}", profile_root.display()),
                format!("--proxy-server=http://127.0.0.1:{proxy_port}"),
                "--no-first-run".into(),
                "--no-default-browser-check".into(),
                "--disable-quic".into(),
                "--force-webrtc-ip-handling-policy=disable_non_proxied_udp".into(),
                "https://ipwho.is/".into(),
            ])
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(format!(
            "Opened dedicated {name} (install Firefox for the bundled uBlock Origin profile)"
        ));
    }

    Err("No supported browser found. Install Firefox for the full MeshHop profile with uBlock Origin, or Chrome, Chromium, or Edge for a basic proxied profile.".into())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            start_engine,
            stop_engine,
            engine_status,
            rotate_exit,
            refresh_exits,
            open_browser
        ])
        .build(tauri::generate_context!())
        .expect("failed to build MeshHop");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            let state = app_handle.state::<AppState>();
            let child = { state.runtime.lock().child.take() };
            if let Some(child) = child {
                let _ = child.kill();
            }
        }
    });
}
