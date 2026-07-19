use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

fn log_file(msg: &str) {
	use std::io::Write;
	if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open("/tmp/pizza-gui-bridge.log") {
		let _ = writeln!(f, "{}", msg);
	}
}

fn find_node() -> Option<String> {
	// Check PIZZA_NODE env var first.
	if let Ok(node) = std::env::var("PIZZA_NODE") {
		if std::path::Path::new(&node).exists() {
			return Some(node);
		}
	}
	// Try nvm first — nvm versions are usually newer and have node:sqlite.
	if let Ok(home) = std::env::var("HOME") {
		let nvm_node = format!("{}/.nvm/versions/node", home);
		if let Ok(entries) = std::fs::read_dir(&nvm_node) {
			let mut versions: Vec<_> = entries.filter_map(|e| e.ok()).collect();
			versions.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
			for v in versions {
				let node_path = v.path().join("bin/node");
				if node_path.exists() {
					return Some(node_path.to_string_lossy().to_string());
				}
			}
		}
	}
	// Check common locations (homebrew, system).
	let candidates = [
		"/opt/homebrew/bin/node",
		"/usr/local/bin/node",
		"/usr/bin/node",
	];
	for c in &candidates {
		if std::path::Path::new(c).exists() {
			return Some(c.to_string());
		}
	}
	// Fallback to "node" and hope PATH works.
	Some("node".to_string())
}

fn resolve_pizza_command(app: &AppHandle) -> (String, Vec<String>) {
	// 1. PIZZA_BIN env var — explicit override (any executable, including a
	//    manually-built `dist/pizza` Bun binary).
	if let Ok(bin) = std::env::var("PIZZA_BIN") {
		let parts: Vec<&str> = bin.split_whitespace().collect();
		if parts.len() >= 2 {
			return (
				parts[0].to_string(),
				parts[1..].iter().map(|s| s.to_string()).chain(["--mode".to_string(), "rpc".to_string()]).collect(),
			);
		}
		return (parts[0].to_string(), vec!["--mode".to_string(), "rpc".to_string()]);
	}

	// 2. Packaged binary bundled via tauri.conf.json `bundle.resources`.
	//    The resource_dir is the runtime location of bundled assets
	//    (e.g. inside the .app bundle on macOS). When present, this makes
	//    the desktop app self-contained — no Node.js required.
	//    On Windows the binary has a .exe extension.
	if let Ok(resource_dir) = app.path().resource_dir() {
		let pizza_bin = resource_dir.join(if cfg!(windows) { "pizza.exe" } else { "pizza" });
		if pizza_bin.exists() {
			log_file(&format!("resolve_pizza_command: using bundled binary at {}", pizza_bin.display()));
			return (pizza_bin.to_string_lossy().to_string(), vec!["--mode".to_string(), "rpc".to_string()]);
		}
	}

	// 3. Dev fallback: run `node dist/src/cli.js` from the source tree.
	let cli_js = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("..")
		.join("..")
		.join("dist")
		.join("src")
		.join("cli.js");
	let node = find_node().unwrap_or_else(|| "node".to_string());
	log_file(&format!("resolve_pizza_command: dev fallback, node={}, cli_js={}", node, cli_js.display()));
	(node, vec![cli_js.to_string_lossy().to_string(), "--mode".to_string(), "rpc".to_string()])
}

/// Sidecar entry: the process + which windows are using it.
struct SidecarEntry {
	child: Child,
	stdin: ChildStdin,
}

pub struct BridgeState {
	/// Sidecars keyed by cwd.
	sidecars: Mutex<HashMap<String, SidecarEntry>>,
	/// Active cwd per window label.
	active: Mutex<HashMap<String, String>>,
}

impl Default for BridgeState {
	fn default() -> Self {
		Self {
			sidecars: Mutex::new(HashMap::new()),
			active: Mutex::new(HashMap::new()),
		}
	}
}

/// Kill and remove the sidecar for a specific cwd.
pub fn kill_sidecar_for_cwd(state: &BridgeState, cwd: &str) {
	log_file(&format!("kill_sidecar_for_cwd: cwd={}", cwd));
	let mut sidecars = state.sidecars.lock().unwrap();
	if let Some(mut sidecar) = sidecars.remove(cwd) {
		let _ = sidecar.child.kill();
		let _ = sidecar.child.wait();
		log_file(&format!("kill_sidecar_for_cwd: killed sidecar for {}", cwd));
	}
}

/// Kill all sidecars for a given window (by active cwd).
pub fn kill_sidecar_for_window(state: &BridgeState, window_label: &str) {
	let cwd = {
		let active = state.active.lock().unwrap();
		active.get(window_label).cloned()
	};
	if let Some(cwd) = cwd {
		// Remove this window from active map.
		{
			let mut active = state.active.lock().unwrap();
			active.remove(window_label);
		}
		// Check if any other window is using this sidecar.
		let still_in_use = {
			let active = state.active.lock().unwrap();
			active.values().any(|c| c == &cwd)
		};
		if !still_in_use {
			kill_sidecar_for_cwd(state, &cwd);
		}
	}
}

/// One-shot init: spawns sidecar for the calling window, sends get_state. Returns state JSON.
/// If a sidecar for this cwd already exists, just switches the active pointer (no restart).
/// `cwd` is the working directory for the pizza rpc process (the user's project).
#[tauri::command]
pub async fn init_sidecar(
	window: tauri::Window,
	state: tauri::State<'_, BridgeState>,
	cwd: Option<String>,
) -> Result<String, String> {
	let window_label = window.label().to_string();
	log_file(&format!("init_sidecar: start, window={}", window_label));

	let cwd = cwd.unwrap_or_else(|| {
		PathBuf::from(env!("CARGO_MANIFEST_DIR"))
			.join("..")
			.join("..")
			.canonicalize()
			.map(|p| p.to_string_lossy().to_string())
			.unwrap_or_else(|_| ".".to_string())
	});
	// Expand ~ to home directory.
	let cwd = if cwd.starts_with("~") {
		if let Ok(home) = std::env::var("HOME") {
			format!("{}{}", home, &cwd[1..])
		} else {
			cwd
		}
	} else {
		cwd
	};
	log_file(&format!("init_sidecar: cwd={}", cwd));

	// Validate that the cwd directory exists before attempting to spawn.
	if !std::path::Path::new(&cwd).is_dir() {
		return Err(format!("Directory does not exist: {}", cwd));
	}

	// Check if sidecar for this cwd already exists.
	let already_running = {
		let sidecars = state.sidecars.lock().unwrap();
		sidecars.contains_key(&cwd)
	};

	if already_running {
		// Just switch active pointer.
		log_file(&format!("init_sidecar: sidecar already running for cwd={}, switching active", cwd));
		{
			let mut active = state.active.lock().unwrap();
			active.insert(window_label.clone(), cwd.clone());
		}
		// Send get_state to get current state.
		let id = uuid::Uuid::new_v4().to_string();
		let cmd = serde_json::json!({ "id": id, "type": "get_state" });
		let line = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
		{
			let mut sidecars = state.sidecars.lock().unwrap();
			let sidecar = sidecars.get_mut(&cwd).ok_or("Sidecar disappeared")?;
			use std::io::Write;
			sidecar.stdin.write_all(line.as_bytes()).map_err(|e| format!("write: {e}"))?;
			sidecar.stdin.write_all(b"\n").map_err(|e| format!("write nl: {e}"))?;
			sidecar.stdin.flush().map_err(|e| format!("flush: {e}"))?;
		}
		// We can't easily read the response synchronously here since the reader
		// thread is already consuming stdout. The frontend will get the state
		// via the rpc_response event. Return empty state.
		log_file("init_sidecar: switched, returning empty (state will come via event)");
		return Ok(serde_json::json!({}).to_string());
	}

	// Multi-sidecar: never kill the old sidecar on switch — it persists.
	// Just update the active workspace mapping for this window (done below).

	let (program, args) = resolve_pizza_command(window.app_handle());
	let mut cmd = Command::new(&program);
	cmd.args(&args);
	cmd.current_dir(&cwd);
	cmd.stdin(Stdio::piped());
	cmd.stdout(Stdio::piped());
	cmd.stderr(Stdio::inherit());

	log_file(&format!("init_sidecar: spawning {} {:?}", program, args));
	let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn: {e}"))?;
	log_file(&format!("init_sidecar: pid={:?}", child.id()));
	let stdin = child.stdin.take().ok_or("no stdin")?;
	let stdout = child.stdout.take().ok_or("no stdout")?;

	// Send get_state BEFORE storing stdin (so we can read the response synchronously).
	log_file("init_sidecar: sending get_state");
	let id = uuid::Uuid::new_v4().to_string();
	let cmd = serde_json::json!({ "id": id, "type": "get_state" });
	let line = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
	{
		use std::io::Write;
		let mut stdin_ref = &stdin;
		stdin_ref.write_all(line.as_bytes()).map_err(|e| format!("write: {e}"))?;
		stdin_ref.write_all(b"\n").map_err(|e| format!("write nl: {e}"))?;
		stdin_ref.flush().map_err(|e| format!("flush: {e}"))?;
	}
	log_file("init_sidecar: get_state sent, reading first response");

	// Read first line from stdout synchronously (the get_state response).
	let mut reader = BufReader::new(stdout);
	let mut first_line = String::new();
	reader.read_line(&mut first_line).map_err(|e| format!("read response: {e}"))?;
	log_file(&format!("init_sidecar: first line = {}", first_line.trim()));

	// Parse the response.
	let state_data: Value = {
		let trimmed = first_line.trim();
		if trimmed.starts_with('{') {
			serde_json::from_str(trimmed).unwrap_or(Value::Null)
		} else {
			Value::Null
		}
	};

	// Store sidecar keyed by cwd.
	{
		let mut sidecars = state.sidecars.lock().unwrap();
		sidecars.insert(cwd.clone(), SidecarEntry { child, stdin });
	}

	// Set active cwd for this window.
	{
		let mut active = state.active.lock().unwrap();
		active.insert(window_label.clone(), cwd.clone());
	}

	// Spawn reader thread for subsequent events — emit to all windows that have this cwd active.
	let app = window.app_handle().clone();
	let reader_cwd = cwd.clone();
	std::thread::spawn(move || {
		log_file(&format!("reader thread: started for cwd={}", reader_cwd));
		for line in reader.lines() {
			match line {
				Ok(line) => {
					let trimmed = line.trim();
					if trimmed.is_empty() || !trimmed.starts_with('{') {
						continue;
					}
					let mut parsed: Value = match serde_json::from_str(trimmed) {
						Ok(v) => v,
						Err(_) => continue,
					};
					log_file(&format!("sidecar stdout [cwd={}]: {}", reader_cwd, trimmed));
					// Emit to all windows that have this cwd as active.
					let app_ref = &app;
					let active = app_ref.state::<BridgeState>();
					let active_map = active.active.lock().unwrap();
					// Emit to ALL windows — include _cwd so frontend can filter.
					// This ensures events are received even when the workspace is not active.
					let etype = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string();
					if etype == "response" {
						// Add _cwd to response for frontend routing.
						if let Some(obj) = parsed.as_object_mut() {
							obj.insert("_cwd".to_string(), Value::String(reader_cwd.clone()));
						}
					}
					for (label, _ac_cwd) in active_map.iter() {
						if let Some(win) = app_ref.get_webview_window(label) {
							match etype.as_str() {
								"response" => {
									let mut tagged = parsed.clone();
									if let Some(obj) = tagged.as_object_mut() {
										obj.insert("_cwd".to_string(), Value::String(reader_cwd.clone()));
									}
									let _ = win.emit("rpc_response", tagged);
								}
								"extension_ui_request" => { let _ = win.emit("extension_ui_request", parsed.clone()); }
								_ => {
									let mut tagged = parsed.clone();
									if let Some(obj) = tagged.as_object_mut() {
										obj.insert("_cwd".to_string(), Value::String(reader_cwd.clone()));
									}
									let _ = win.emit("rpc_event", tagged);
								}
							}
						}
					}
				}
				Err(e) => {
					log_file(&format!("reader error [cwd={}]: {e}", reader_cwd));
					break;
				}
			}
		}
		log_file(&format!("reader thread: EOF for cwd={}", reader_cwd));
		// Notify all windows — sidecar_exit includes cwd for frontend filtering.
		let app_ref = &app;
		let active = app_ref.state::<BridgeState>();
		let active_map = active.active.lock().unwrap();
		for (label, _ac_cwd) in active_map.iter() {
			if let Some(win) = app_ref.get_webview_window(label) {
				let _ = win.emit("sidecar_exit", serde_json::json!({ "code": null, "cwd": reader_cwd }));
			}
		}
	});

	log_file("init_sidecar: done");
	Ok(state_data.to_string())
}

#[tauri::command]
pub fn stop_sidecar(
	window: tauri::Window,
	state: tauri::State<'_, BridgeState>,
) -> Result<(), String> {
	kill_sidecar_for_window(state.inner(), window.label());
	Ok(())
}

#[tauri::command]
pub fn rpc_command(
	window: tauri::Window,
	state: tauri::State<'_, BridgeState>,
	command: Value,
) -> Result<String, String> {
	let window_label = window.label();
	log_file(&format!("rpc_command [{}]: {}", window_label, command));
	let mut obj = command.as_object().cloned().ok_or("command must be an object")?;
	let id = if let Some(existing) = obj.get("id").and_then(|v| v.as_str()) {
		existing.to_string()
	} else {
		let id = uuid::Uuid::new_v4().to_string();
		obj.insert("id".to_string(), Value::String(id.clone()));
		id
	};
	let line = serde_json::to_string(&Value::Object(obj)).map_err(|e| e.to_string())?;
	log_file(&format!("rpc_command [{}] sending: {}", window_label, line));

	// Route to the active sidecar for this window.
	let cwd = {
		let active = state.active.lock().unwrap();
		active.get(window_label).cloned()
	};
	let cwd = cwd.ok_or("No active workspace for this window")?;

	let mut sidecars = state.sidecars.lock().unwrap();
	let sidecar = sidecars.get_mut(&cwd).ok_or("Sidecar is not running")?;
	sidecar.stdin.write_all(line.as_bytes()).map_err(|e| format!("write: {e}"))?;
	sidecar.stdin.write_all(b"\n").map_err(|e| format!("write nl: {e}"))?;
	sidecar.stdin.flush().map_err(|e| format!("flush: {e}"))?;
	Ok(id)
}

/// Create a new workspace window with its own independent sidecar.
#[tauri::command]
pub async fn new_workspace(app: AppHandle) -> Result<String, String> {
	let label = format!("workspace-{}", uuid::Uuid::new_v4().simple());
	log_file(&format!("new_workspace: creating window={}", label));
	let _window = tauri::WebviewWindowBuilder::new(
		&app,
		&label,
		tauri::WebviewUrl::App("index.html".into()),
	)
	.title("Pizza")
	.inner_size(1200.0, 800.0)
	.min_inner_size(720.0, 480.0)
	.title_bar_style(tauri::TitleBarStyle::Transparent)
	.hidden_title(true)
	.background_color(tauri::webview::Color(18, 18, 18, 255))
	.build()
	.map_err(|e| format!("Failed to create window: {e}"))?;
	Ok(label)
}

/// List all workspaces from ~/.pizza/agent/workspaces/*/meta.json
#[tauri::command]
pub async fn list_workspaces() -> Result<Vec<Value>, String> {
	let home = std::env::var("HOME").map_err(|_| "HOME not set")?;
	let workspaces_dir = PathBuf::from(&home).join(".pizza").join("agent").join("workspaces");

	if !workspaces_dir.exists() {
		return Ok(Vec::new());
	}

	let entries = std::fs::read_dir(&workspaces_dir).map_err(|e| format!("read_dir: {e}"))?;
	let mut workspaces: Vec<Value> = Vec::new();

	for entry in entries {
		let entry = entry.map_err(|e| format!("entry: {e}"))?;
		let meta_path = entry.path().join("meta.json");
		if !meta_path.exists() {
			continue;
		}
		let raw = match std::fs::read_to_string(&meta_path) {
			Ok(s) => s,
			Err(_) => continue,
		};
		let meta: Value = match serde_json::from_str(&raw) {
			Ok(v) => v,
			Err(_) => continue,
		};
		workspaces.push(meta);
	}

	// Sort by last_accessed_at descending
	workspaces.sort_by(|a, b| {
		let a_time = a.get("last_accessed_at").and_then(|v| v.as_i64()).unwrap_or(0);
		let b_time = b.get("last_accessed_at").and_then(|v| v.as_i64()).unwrap_or(0);
		b_time.cmp(&a_time)
	});

	Ok(workspaces)
}

/// Delete a workspace by its workspace_id — removes the workspace meta directory
/// and kills any running sidecar for that workspace's cwd.
#[tauri::command]
pub async fn delete_workspace(
	state: tauri::State<'_, BridgeState>,
	workspace_id: String,
) -> Result<(), String> {
	let home = std::env::var("HOME").map_err(|_| "HOME not set")?;
	let ws_dir = PathBuf::from(&home)
		.join(".pizza")
		.join("agent")
		.join("workspaces")
		.join(&workspace_id);

	if !ws_dir.exists() {
		return Err(format!("Workspace {} not found", workspace_id));
	}

	// Read the cwd from meta.json before deleting, so we can kill the sidecar.
	let meta_path = ws_dir.join("meta.json");
	let cwd: Option<String> = if meta_path.exists() {
		if let Ok(raw) = std::fs::read_to_string(&meta_path) {
			if let Ok(meta) = serde_json::from_str::<Value>(&raw) {
				meta.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string())
			} else { None }
		} else { None }
	} else { None };

	// Kill sidecar if running.
	if let Some(ref cwd) = cwd {
		kill_sidecar_for_cwd(state.inner(), cwd);
	}

	// Remove the workspace directory.
	std::fs::remove_dir_all(&ws_dir).map_err(|e| format!("Failed to delete workspace: {e}"))?;

	log_file(&format!("delete_workspace: deleted {}", workspace_id));
	Ok(())
}

/// Reveal a workspace's cwd in the system file manager (Finder on macOS).
#[tauri::command]
pub async fn reveal_workspace(cwd: String) -> Result<(), String> {
	let path = if cwd.starts_with("~") {
		if let Ok(home) = std::env::var("HOME") {
			format!("{}{}", home, &cwd[1..])
		} else {
			cwd.clone()
		}
	} else {
		cwd.clone()
	};

	if !std::path::Path::new(&path).exists() {
		return Err(format!("Path does not exist: {}", path));
	}

	#[cfg(target_os = "macos")]
	let opener = "open";
	#[cfg(target_os = "linux")]
	let opener = "xdg-open";
	#[cfg(target_os = "windows")]
	let opener = "explorer";

	std::process::Command::new(opener)
		.arg(&path)
		.spawn()
		.map_err(|e| format!("Failed to open file manager: {e}"))?;

	Ok(())
}

/// Provider info returned to the frontend.
#[derive(serde::Serialize)]
pub struct ProviderInfo {
	id: String,
	has_api_key: bool,
	auth_type: Option<String>, // "api_key" | "oauth"
}

/// List all known providers and their auth status from auth.json.
#[tauri::command]
pub async fn list_providers() -> Result<Vec<ProviderInfo>, String> {
	let home = std::env::var("HOME").map_err(|_| "HOME not set")?;
	let auth_path = PathBuf::from(&home).join(".pizza").join("agent").join("auth.json");

	let mut auth_data: serde_json::Map<String, Value> = serde_json::Map::new();
	if auth_path.exists() {
		if let Ok(raw) = std::fs::read_to_string(&auth_path) {
			if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
				if let Some(obj) = parsed.as_object() {
					auth_data = obj.clone();
				}
			}
		}
	}

	// Built-in known providers (from pi-ai)
	let builtin = [
		"anthropic", "openai", "google", "zai", "openrouter",
		"groq", "mistral", "deepseek", "xai", "fireworks",
		"together", "perplexity", "cohere", "amazon-bedrock",
	];

	let mut providers: Vec<ProviderInfo> = Vec::new();

	for id in &builtin {
		let cred = auth_data.get(*id);
		let has_api_key = cred.is_some();
		let auth_type = cred.and_then(|c| c.get("type")).and_then(|t| t.as_str()).map(|s| s.to_string());
		providers.push(ProviderInfo {
			id: id.to_string(),
			has_api_key,
			auth_type,
		});
	}

	// Add any custom providers from auth.json not in builtin list
	for (key, _val) in &auth_data {
		if !builtin.contains(&key.as_str()) {
			let cred = auth_data.get(key);
			let auth_type = cred.and_then(|c| c.get("type")).and_then(|t| t.as_str()).map(|s| s.to_string());
			providers.push(ProviderInfo {
				id: key.clone(),
				has_api_key: true,
				auth_type,
			});
		}
	}

	Ok(providers)
}

/// Set an API key for a provider in auth.json.
#[tauri::command]
pub async fn set_provider_api_key(provider: String, api_key: String) -> Result<(), String> {
	let home = std::env::var("HOME").map_err(|_| "HOME not set")?;
	let auth_dir = PathBuf::from(&home).join(".pizza").join("agent");
	let auth_path = auth_dir.join("auth.json");

	// Ensure directory exists
	if !auth_dir.exists() {
		std::fs::create_dir_all(&auth_dir).map_err(|e| format!("create_dir: {e}"))?;
	}

	// Read existing auth.json
	let mut auth_data: serde_json::Map<String, Value> = serde_json::Map::new();
	if auth_path.exists() {
		if let Ok(raw) = std::fs::read_to_string(&auth_path) {
			if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
				if let Some(obj) = parsed.as_object() {
					auth_data = obj.clone();
				}
			}
		}
	}

	// Set the API key
	auth_data.insert(
		provider.clone(),
		serde_json::json!({ "type": "api_key", "key": api_key }),
	);

	// Write back
	let json = serde_json::to_string_pretty(&Value::Object(auth_data)).map_err(|e| format!("serialize: {e}"))?;
	std::fs::write(&auth_path, &json).map_err(|e| format!("write: {e}"))?;

	// Set file permissions to 600
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let _ = std::fs::set_permissions(&auth_path, std::fs::Permissions::from_mode(0o600));
	}

	log_file(&format!("set_provider_api_key: set key for {}", provider));
	Ok(())
}

/// Remove a provider's credentials from auth.json.
#[tauri::command]
pub async fn remove_provider_api_key(provider: String) -> Result<(), String> {
	let home = std::env::var("HOME").map_err(|_| "HOME not set")?;
	let auth_path = PathBuf::from(&home).join(".pizza").join("agent").join("auth.json");

	if !auth_path.exists() {
		return Ok(()); // Nothing to remove
	}

	let raw = std::fs::read_to_string(&auth_path).map_err(|e| format!("read: {e}"))?;
	let mut parsed: Value = serde_json::from_str(&raw).map_err(|e| format!("parse: {e}"))?;

	if let Some(obj) = parsed.as_object_mut() {
		obj.remove(&provider);
	}

	let json = serde_json::to_string_pretty(&parsed).map_err(|e| format!("serialize: {e}"))?;
	std::fs::write(&auth_path, &json).map_err(|e| format!("write: {e}"))?;

	log_file(&format!("remove_provider_api_key: removed key for {}", provider));
	Ok(())
}

/// Set the window background color (for theme adaptation).
#[tauri::command]
pub async fn set_window_background(app: AppHandle, r: u8, g: u8, b: u8) -> Result<(), String> {
	let window = app.get_webview_window("main").or_else(|| {
		app.webview_windows().into_iter().next().map(|(_, w)| w)
	});
	if let Some(window) = window {
		window.set_background_color(Some(tauri::webview::Color(r, g, b, 255)))
			.map_err(|e| format!("set_background_color: {e}"))?;
	}
	Ok(())
}
