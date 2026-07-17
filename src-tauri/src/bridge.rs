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

struct SidecarState {
	child: Child,
	stdin: ChildStdin,
}

pub struct BridgeState {
	sidecars: Mutex<HashMap<String, SidecarState>>,
}

impl Default for BridgeState {
	fn default() -> Self {
		Self {
			sidecars: Mutex::new(HashMap::new()),
		}
	}
}

/// Kill and remove the sidecar for a specific window label.
pub fn kill_sidecar_for_window(state: &BridgeState, window_label: &str) {
	log_file(&format!("kill_sidecar_for_window: label={}", window_label));
	let mut sidecars = state.sidecars.lock().unwrap();
	if let Some(mut sidecar) = sidecars.remove(window_label) {
		let _ = sidecar.child.kill();
		let _ = sidecar.child.wait();
		log_file(&format!("kill_sidecar_for_window: killed sidecar for {}", window_label));
	}
}

/// One-shot init: spawns sidecar for the calling window, sends get_state. Returns state JSON.
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

	// Kill existing sidecar for this window if any
	kill_sidecar_for_window(&state, &window_label);

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

	// Store sidecar in the per-window map.
	{
		let mut sidecars = state.sidecars.lock().unwrap();
		sidecars.insert(window_label.clone(), SidecarState { child, stdin });
	}

	// Spawn reader thread for subsequent events — emit to this specific window.
	let app = window.app_handle().clone();
	let label = window_label.clone();
	std::thread::spawn(move || {
		log_file(&format!("reader thread: started for window={}", label));
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
					log_file(&format!("sidecar stdout [{}]: {}", label, trimmed));
					// Emit to the specific window only
					if let Some(win) = app.get_webview_window(&label) {
						let etype = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");
						match etype {
							"response" => { let _ = win.emit("rpc_response", parsed); }
							"extension_ui_request" => { let _ = win.emit("extension_ui_request", parsed); }
							_ => { let _ = win.emit("rpc_event", parsed); }
						}
					}
				}
				Err(e) => {
					log_file(&format!("reader error [{}]: {e}", label));
					break;
				}
			}
		}
		log_file(&format!("reader thread: EOF for window={}", label));
		if let Some(win) = app.get_webview_window(&label) {
			let _ = win.emit("sidecar_exit", serde_json::json!({ "code": null }));
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
	kill_sidecar_for_window(&state, window.label());
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

	let mut sidecars = state.sidecars.lock().unwrap();
	let sidecar = sidecars.get_mut(window_label).ok_or("Sidecar is not running")?;
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
	.build()
	.map_err(|e| format!("Failed to create window: {e}"))?;
	Ok(label)
}
