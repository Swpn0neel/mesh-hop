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
use tauri::menu::{Menu, MenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_notification::NotificationExt;
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
    socks_port: Option<u16>,
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
    socks_port: Option<u16>,
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
            socks_port: None,
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
    #[serde(default)]
    blocked_exit_ips: Vec<String>,
    // Opt-in local SOCKS5 listener for non-browser apps. Off unless the user
    // explicitly turns it on in Advanced options.
    #[serde(default)]
    socks_enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheck {
    current_version: String,
    latest_version: String,
    update_available: bool,
    download_url: String,
    release_url: String,
}

fn parse_semver(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.trim().trim_start_matches('v').split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    Some((major, minor, patch))
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    match (parse_semver(latest), parse_semver(current)) {
        (Some(left), Some(right)) => left > right,
        _ => false,
    }
}

fn snapshot(runtime: &RuntimeState, pool: Option<Value>) -> DesktopStatus {
    DesktopStatus {
        phase: runtime.phase.clone(),
        message: runtime.message.clone(),
        proxy_port: runtime.proxy_port,
        control_port: runtime.control_port,
        socks_port: runtime.socks_port,
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

/// Best-effort Windows toast. Failures are ignored so notifications never break the engine path.
fn notify_user(app: &AppHandle, title: &str, body: impl AsRef<str>) {
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body.as_ref())
        .show();
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
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
            drop(inner);
            // Only automatic failover (not manual Rotate) while the window may be tray-hidden.
            if message.contains("switching to a verified fallback") {
                notify_user(app, "MeshHop rotated exit", message);
            }
        }
        "progress" => {
            // Structured discovery stages from the engine (fetch/probe/speed/confirm/commit).
            let message = parsed
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Verifying route…");
            let mut inner = runtime.lock();
            if inner.generation == generation && inner.phase == "starting" {
                inner.message = message.into();
            }
            drop(inner);
            let _ = app.emit("engine-progress", parsed);
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
            let discovery_error = status
                .and_then(|value| value.get("lastDiscoveryError"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let socks_port = parsed
                .get("socksPort")
                .and_then(Value::as_u64)
                .and_then(|port| u16::try_from(port).ok());
            let mut inner = runtime.lock();
            if inner.generation == generation {
                inner.phase = "running".into();
                inner.socks_port = socks_port;
                inner.message = if has_exit {
                    format!("{country} exit is active")
                } else if let Some(error) = discovery_error {
                    error.chars().take(220).collect()
                } else {
                    "No working exit yet — use Refresh to try again".into()
                };
            }
            drop(inner);
            emit_state(app, runtime);
            if let Some(status) = status {
                let _ = app.emit("pool-updated", status.clone());
            }
            if !has_exit {
                notify_user(
                    app,
                    "MeshHop",
                    "No verified exit yet — open MeshHop and use Refresh, or try another region.",
                );
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
            notify_user(
                app,
                "MeshHop needs attention",
                message.lines().next().unwrap_or(message),
            );
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
    assert_loopback_port_free(proxy_port, "browser proxy")?;
    assert_loopback_port_free(control_port, "control")?;
    let socks_port = if config.socks_enabled {
        let port = 17879;
        assert_loopback_port_free(port, "SOCKS")?;
        Some(port)
    } else {
        None
    };
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
        inner.socks_port = socks_port;
        inner.control_token = Some(control_token.clone());
        inner.generation
    };
    emit_state(&app, &state.runtime);

    let command = command
        .env("COUNTRY", &country)
        .env("RANK_MODE", &config.rank_mode)
        .env("LISTEN_PORT", proxy_port.to_string())
        .env("CONTROL_PORT", control_port.to_string())
        .env("SOCKS_PORT", socks_port.unwrap_or(0).to_string())
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
        .env("REFRESH_MINUTES", "10")
        .env("HEARTBEAT_SECONDS", "45")
        .env(
            "BLOCKED_EXIT_IPS",
            config
                .blocked_exit_ips
                .iter()
                .map(|ip| ip.trim())
                .filter(|ip| !ip.is_empty())
                .collect::<Vec<_>>()
                .join(","),
        );

    let (mut receiver, child) = match command.spawn() {
        Ok(value) => value,
        Err(error) => {
            let mut inner = state.runtime.lock();
            inner.phase = "error".into();
            inner.message = error.to_string();
            inner.proxy_port = None;
            inner.control_port = None;
            inner.socks_port = None;
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
                        inner.socks_port = None;
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
        inner.socks_port = None;
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

async fn post_control(
    state: &AppState,
    action: &str,
    timeout: u64,
    body: Option<&Value>,
) -> Result<Value, String> {
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
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let message = response.json::<Value>().await.ok().and_then(|value| {
            value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        return Err(message.unwrap_or_else(|| format!("Engine returned HTTP {status}")));
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn rotate_exit(state: State<'_, AppState>) -> Result<Value, String> {
    post_control(&state, "rotate", 10, None).await
}

#[tauri::command]
async fn refresh_exits(state: State<'_, AppState>) -> Result<Value, String> {
    // Steady-state speed measurement with a second confirming sample makes a full
    // refresh take longer; allow generous headroom before the request times out.
    post_control(&state, "refresh", 180, None).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectExitRequest {
    protocol: String,
    host: String,
    port: u16,
}

#[tauri::command]
async fn select_exit(
    state: State<'_, AppState>,
    protocol: String,
    host: String,
    port: u16,
) -> Result<Value, String> {
    let body = serde_json::to_value(SelectExitRequest {
        protocol,
        host,
        port,
    })
    .map_err(|error| error.to_string())?;
    post_control(&state, "select", 10, Some(&body)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BlockExitRequest {
    exit_ip: String,
}

#[tauri::command]
async fn block_exit(state: State<'_, AppState>, exit_ip: String) -> Result<Value, String> {
    let body = serde_json::to_value(BlockExitRequest {
        exit_ip: exit_ip.trim().to_string(),
    })
    .map_err(|error| error.to_string())?;
    post_control(&state, "block", 10, Some(&body)).await
}

#[tauri::command]
async fn unblock_exit(state: State<'_, AppState>, exit_ip: String) -> Result<Value, String> {
    let body = serde_json::to_value(BlockExitRequest {
        exit_ip: exit_ip.trim().to_string(),
    })
    .map_err(|error| error.to_string())?;
    post_control(&state, "unblock", 10, Some(&body)).await
}

#[tauri::command]
async fn check_for_update(state: State<'_, AppState>) -> Result<UpdateCheck, String> {
    const MANIFEST_URL: &str =
        "https://github.com/Swpn0neel/mesh-hop/releases/latest/download/meshhop-release.json";
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let response = state
        .client
        .get(MANIFEST_URL)
        .timeout(Duration::from_secs(8))
        .header("user-agent", format!("MeshHop-Desktop/{current_version}"))
        .send()
        .await
        .map_err(|error| format!("Update check failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Update check returned HTTP {}", response.status()));
    }
    let manifest = response
        .json::<Value>()
        .await
        .map_err(|error| format!("Update manifest was invalid: {error}"))?;
    let latest_version = manifest
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or(&current_version)
        .to_string();
    let download_url = manifest
        .pointer("/assets/windows/nsis/latestUrl")
        .and_then(Value::as_str)
        .unwrap_or(
            "https://github.com/Swpn0neel/mesh-hop/releases/latest/download/MeshHop-windows-x64-setup.exe",
        )
        .to_string();
    let release_url = manifest
        .get("latestReleaseUrl")
        .and_then(Value::as_str)
        .or_else(|| manifest.get("releaseUrl").and_then(Value::as_str))
        .unwrap_or("https://github.com/Swpn0neel/mesh-hop/releases/latest")
        .to_string();
    Ok(UpdateCheck {
        update_available: is_newer_version(&latest_version, &current_version),
        current_version,
        latest_version,
        download_url,
        release_url,
    })
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("Only http(s) URLs can be opened".into());
    }
    // Windows: use cmd start so we do not need an extra opener crate.
    #[cfg(target_os = "windows")]
    {
        ProcessCommand::new("cmd")
            .args(["/C", "start", "", trimmed])
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        ProcessCommand::new("open")
            .arg(trimmed)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        ProcessCommand::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Opening URLs is not supported on this platform".into())
}

/// Fail fast with a clear Windows-facing message when MeshHop's fixed loopback
/// ports are already taken (usually a previous engine still running).
fn assert_loopback_port_free(port: u16, purpose: &str) -> Result<(), String> {
    match std::net::TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => {
            drop(listener);
            Ok(())
        }
        Err(_) => Err(format!(
            "MeshHop {purpose} port {port} is already in use on 127.0.0.1. \
Close the other MeshHop window or end any leftover meshhop-engine process in Task Manager, then try again."
        )),
    }
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
user_pref("network.dns.disableIPv6", false);
user_pref("network.prefetch-next", false);
user_pref("network.http.speculative-parallel-limit", 0);
// Disable WebRTC entirely in this profile so STUN cannot leak the real IP.
// MeshHop only routes HTTPS/TCP; real-time media is out of scope.
user_pref("media.peerconnection.enabled", false);
user_pref("media.peerconnection.ice.default_address_only", true);
user_pref("media.peerconnection.ice.no_host", true);
user_pref("media.peerconnection.ice.proxy_only", true);
user_pref("media.peerconnection.ice.proxy_only_if_behind_proxy", true);
// Prefer the browser not opening a parallel DoH path that bypasses the proxy story.
user_pref("network.trr.mode", 5);
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
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            start_engine,
            stop_engine,
            engine_status,
            rotate_exit,
            select_exit,
            block_exit,
            unblock_exit,
            refresh_exits,
            open_browser,
            check_for_update,
            open_external_url
        ])
        .setup(|app| {
            // Close button hides to tray so the route can keep running in the background.
            if let Some(window) = app.get_webview_window("main") {
                let window_handle = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_handle.hide();
                    }
                });
            }

            let show_item = MenuItem::with_id(app, "show", "Show MeshHop", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or_else(|| "MeshHop window icon is missing for the tray".to_string())?;

            let _tray = TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .tooltip("MeshHop")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => {
                        let state = app.state::<AppState>();
                        let child = { state.runtime.lock().child.take() };
                        if let Some(child) = child {
                            let _ = child.kill();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
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
