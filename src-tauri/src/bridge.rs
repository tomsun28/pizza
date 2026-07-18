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

fn resolve_pizza_command() -> (String, Vec<String>) {
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
	let cli_js = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("..")
		.join("dist")
		.join("cli.js");
	("node".to_string(), vec![cli_js.to_string_lossy().to_string(), "--mode".to_string(), "rpc".to_string()])
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
			.canonicalize()
			.map(|p| p.to_string_lossy().to_string())
			.unwrap_or_else(|_| ".".to_string())
	});
	log_file(&format!("init_sidecar: cwd={}", cwd));

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

	// Kill existing sidecar for this window's previous cwd if switching.
	let old_cwd_to_kill: Option<String> = {
		let active = state.active.lock().unwrap();
		if let Some(old_cwd) = active.get(&window_label) {
			if old_cwd != &cwd {
				log_file(&format!("init_sidecar: switching from old cwd={}", old_cwd));
				// Don't kill the old sidecar — it may be used by other windows.
				// Just check if any other window still uses it.
				let old_still_in_use = active.values().any(|c| c == old_cwd);
				if !old_still_in_use {
					Some(old_cwd.clone())
				} else {
					None
				}
			} else {
				None
			}
		} else {
			None
		}
	};
	if let Some(old_cwd) = old_cwd_to_kill {
		kill_sidecar_for_cwd(&state, &old_cwd);
	}

	let (program, args) = resolve_pizza_command();
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
					let parsed: Value = match serde_json::from_str(trimmed) {
						Ok(v) => v,
						Err(_) => continue,
					};
					log_file(&format!("sidecar stdout [cwd={}]: {}", reader_cwd, trimmed));
					// Emit to all windows that have this cwd as active.
					let app_ref = &app;
					let active = app_ref.state::<BridgeState>();
					let active_map = active.active.lock().unwrap();
					for (label, ac_cwd) in active_map.iter() {
						if ac_cwd == &reader_cwd {
							if let Some(win) = app_ref.get_webview_window(label) {
								let etype = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");
								match etype {
									"response" => { let _ = win.emit("rpc_response", parsed.clone()); }
									"extension_ui_request" => { let _ = win.emit("extension_ui_request", parsed.clone()); }
									_ => { let _ = win.emit("rpc_event", parsed.clone()); }
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
		// Notify all windows that had this cwd active.
		let app_ref = &app;
		let active = app_ref.state::<BridgeState>();
		let active_map = active.active.lock().unwrap();
		for (label, ac_cwd) in active_map.iter() {
			if ac_cwd == &reader_cwd {
				if let Some(win) = app_ref.get_webview_window(label) {
					let _ = win.emit("sidecar_exit", serde_json::json!({ "code": null, "cwd": reader_cwd }));
				}
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
