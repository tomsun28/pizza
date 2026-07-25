use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Read an API key for a provider from ~/.pizza/agent/auth.json.
fn read_api_key(provider: &str) -> Option<String> {
	let home = std::env::var("HOME").ok()?;
	let auth_path = PathBuf::from(&home)
		.join(".pizza")
		.join("agent")
		.join("auth.json");
	let raw = std::fs::read_to_string(&auth_path).ok()?;
	let parsed: Value = serde_json::from_str(&raw).ok()?;
	let key = parsed.get(provider)?.get("key")?.as_str()?.to_string();
	if key.is_empty() {
		None
	} else {
		Some(key)
	}
}

fn log_file(msg: &str) {
	use std::io::Write;
	if let Ok(mut f) = std::fs::OpenOptions::new()
		.create(true)
		.append(true)
		.open("/tmp/pizza-gui-bridge.log")
	{
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
/// Run the user's login shell once and capture the PATH it would set in an
/// interactive terminal, so the GUI-launched sidecar (which inherits launchd's
/// minimal PATH and never sources ~/.zprofile / ~/.bash_profile) still finds
/// tools the user installed via homebrew/cargo/nvm/etc.
///
/// Runs `<shell> -lic 'printf %s "$PATH"'` with stdin wired to /dev/null and a
/// hard timeout, so a misbehaving rc file can't hang the app. The result is
/// cached per process via OnceLock.
fn capture_login_shell_path() -> Option<String> {
	// Prefer the user's configured login shell, then common fallbacks.
	let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty());
	let candidates: Vec<String> = match shell {
		Some(s) => vec![s, "/bin/zsh".to_string(), "/bin/bash".to_string()],
		None => vec!["/bin/zsh".to_string(), "/bin/bash".to_string()],
	};

	for shell in candidates {
		if !PathBuf::from(&shell).exists() {
			continue;
		}
		match run_shell_capture_path(&shell) {
			Some(path) if !path.trim().is_empty() => return Some(path),
			_ => continue,
		}
	}
	None
}

/// Spawn `<shell> -lic 'printf %s "$PATH"'` with a timeout and return its
/// trimmed stdout. Returns None on timeout, non-zero exit, or empty output.
fn run_shell_capture_path(shell: &str) -> Option<String> {
	const TIMEOUT: Duration = Duration::from_secs(3);

	let (tx, rx) = std::sync::mpsc::channel();
	let shell = shell.to_string();
	thread::spawn(move || {
		let result = (|| {
			let output = Command::new(&shell)
				.args(["-lic", "printf %s \"$PATH\""])
				.stdin(Stdio::null())
				.stdout(Stdio::piped())
				.stderr(Stdio::piped())
				.output()
				.ok()?;
			if !output.status.success() {
				return None;
			}
			let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
			if path.is_empty() {
				None
			} else {
				Some(path)
			}
		})();
		let _ = tx.send(result);
	});

	match rx.recv_timeout(TIMEOUT) {
		Ok(value) => value,
		Err(_) => None, // timed out — give up on this shell
	}
}

/// Resolve the PATH to pass to sidecars: the login-shell PATH if we could
/// capture one, otherwise the process's inherited PATH. Cached per process.
fn resolve_shell_path() -> String {
	static CACHED: OnceLock<Option<String>> = OnceLock::new();
	let cached = CACHED.get_or_init(capture_login_shell_path);
	match cached {
		Some(path) => path.clone(),
		None => std::env::var("PATH").unwrap_or_default(),
	}
}

fn resolve_pizza_command(app: &AppHandle) -> (String, Vec<String>) {
	// 1. PIZZA_BIN env var — explicit override (any executable, including a
	//    manually-built `dist/pizza` Bun binary).
	if let Ok(bin) = std::env::var("PIZZA_BIN") {
		let parts: Vec<&str> = bin.split_whitespace().collect();
		if parts.len() >= 2 {
			return (
				parts[0].to_string(),
				parts[1..]
					.iter()
					.map(|s| s.to_string())
					.chain(["--mode".to_string(), "rpc".to_string()])
					.collect(),
			);
		}
		return (
			parts[0].to_string(),
			vec!["--mode".to_string(), "rpc".to_string()],
		);
	}

	// 2. Packaged binary bundled via tauri.conf.json `bundle.resources`.
	//    The resource_dir is the runtime location of bundled assets
	//    (e.g. inside the .app bundle on macOS). When present, this makes
	//    the desktop app self-contained — no Node.js required.
	//    On Windows the binary has a .exe extension.
	//    Skipped in debug builds: in dev the resource_dir points at
	//    target/debug/ where a stale dist/pizza may exist from a prior
	//    `build:binary`, which can hang the sidecar.
	if !cfg!(debug_assertions) {
		if let Ok(resource_dir) = app.path().resource_dir() {
			let pizza_bin = resource_dir.join(if cfg!(windows) { "pizza.exe" } else { "pizza" });
			if pizza_bin.exists() {
				log_file(&format!(
					"resolve_pizza_command: using bundled binary at {}",
					pizza_bin.display()
				));
				return (
					pizza_bin.to_string_lossy().to_string(),
					vec!["--mode".to_string(), "rpc".to_string()],
				);
			}
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
	log_file(&format!(
		"resolve_pizza_command: dev fallback, node={}, cli_js={}",
		node,
		cli_js.display()
	));
	(
		node,
		vec![
			cli_js.to_string_lossy().to_string(),
			"--mode".to_string(),
			"rpc".to_string(),
		],
	)
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

	// The persistent Chat workspace (~/.pizza/main) is auto-created on first
	// launch. It is the default workspace the desktop app boots into, so it
	// must always exist — unlike user-selected project directories, which are
	// expected to be present already.
	let is_persistent_chat = std::env::var("HOME")
		.ok()
		.map(|home| cwd == format!("{}/.pizza/main", home))
		.unwrap_or(false);
	if is_persistent_chat && !std::path::Path::new(&cwd).is_dir() {
		log_file(&format!(
			"init_sidecar: creating persistent Chat workspace at {}",
			cwd
		));
		if let Err(e) = std::fs::create_dir_all(&cwd) {
			return Err(format!("Failed to create Chat workspace {}: {}", cwd, e));
		}
	}

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
		log_file(&format!(
			"init_sidecar: sidecar already running for cwd={}, switching active",
			cwd
		));
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
			sidecar
				.stdin
				.write_all(line.as_bytes())
				.map_err(|e| format!("write: {e}"))?;
			sidecar
				.stdin
				.write_all(b"\n")
				.map_err(|e| format!("write nl: {e}"))?;
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

	let (program, mut args) = resolve_pizza_command(window.app_handle());
	// When the workspace is the persistent Chat (~/.pizza/main), launch pizza
	// in main-agent mode so it initializes the soul file + long-term memory
	// scaffold and injects the main-agent guidelines into the system prompt.
	if is_persistent_chat {
		args.push("--main".to_string());
	}
	let mut cmd = Command::new(&program);
	cmd.args(&args);
	cmd.current_dir(&cwd);
	cmd.stdin(Stdio::piped());
	cmd.stdout(Stdio::piped());
	cmd.stderr(Stdio::inherit());
	// GUI-launched processes inherit launchd's minimal PATH and never source the
	// user's shell rc files, so homebrew/cargo/nvm etc. would be missing. Capture
	// the login-shell PATH once and pass it to the sidecar explicitly.
	cmd.env("PATH", resolve_shell_path());
	log_file(&format!(
		"init_sidecar: sidecar PATH = {}",
		resolve_shell_path()
	));

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
		stdin_ref
			.write_all(line.as_bytes())
			.map_err(|e| format!("write: {e}"))?;
		stdin_ref
			.write_all(b"\n")
			.map_err(|e| format!("write nl: {e}"))?;
		stdin_ref.flush().map_err(|e| format!("flush: {e}"))?;
	}
	log_file("init_sidecar: get_state sent, reading first response");

	// Read first line from stdout synchronously (the get_state response).
	let mut reader = BufReader::new(stdout);
	let mut first_line = String::new();
	let bytes_read = reader
		.read_line(&mut first_line)
		.map_err(|e| format!("read response: {e}"))?;
	log_file(&format!("init_sidecar: first line = {}", first_line.trim()));

	// If we got EOF (0 bytes) the sidecar died immediately. Check exit status
	// to surface a meaningful error instead of storing a dead sidecar that
	// would cause "Broken pipe" on the next write.
	if bytes_read == 0 {
		let exit_info = match child.try_wait() {
			Ok(Some(status)) => format!(" (exit {})", status),
			_ => String::new(),
		};
		return Err(format!(
			"Sidecar exited immediately without responding{}",
			exit_info
		));
	}

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
					let etype = parsed
						.get("type")
						.and_then(|t| t.as_str())
						.unwrap_or("")
						.to_string();
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
										obj.insert(
											"_cwd".to_string(),
											Value::String(reader_cwd.clone()),
										);
									}
									let _ = win.emit("rpc_response", tagged);
								}
								"extension_ui_request" => {
									let _ = win.emit("extension_ui_request", parsed.clone());
								}
								_ => {
									let mut tagged = parsed.clone();
									if let Some(obj) = tagged.as_object_mut() {
										obj.insert(
											"_cwd".to_string(),
											Value::String(reader_cwd.clone()),
										);
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
		// Reap the dead sidecar: remove from the map and wait() to avoid a
		// zombie process lingering until the GUI exits. drop(stdin) first so
		// the write pipe is closed before we wait for exit.
		// If kill_sidecar_for_cwd already removed it, we get None and skip.
		{
			let app_ref = &app;
			let state = app_ref.state::<BridgeState>();
			let mut sidecars = state.sidecars.lock().unwrap();
			if let Some(mut entry) = sidecars.remove(&reader_cwd) {
				let pid = entry.child.id();
				drop(entry.stdin);
				let _ = entry.child.wait();
				log_file(&format!(
					"reader thread: reaped sidecar pid={:?} cwd={}",
					pid, reader_cwd
				));
			}
		}
		// Notify all windows — sidecar_exit includes cwd for frontend filtering.
		let app_ref = &app;
		let active = app_ref.state::<BridgeState>();
		let active_map = active.active.lock().unwrap();
		for (label, _ac_cwd) in active_map.iter() {
			if let Some(win) = app_ref.get_webview_window(label) {
				let _ = win.emit(
					"sidecar_exit",
					serde_json::json!({ "code": null, "cwd": reader_cwd }),
				);
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
	let mut obj = command
		.as_object()
		.cloned()
		.ok_or("command must be an object")?;
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
	sidecar
		.stdin
		.write_all(line.as_bytes())
		.map_err(|e| format!("write: {e}"))?;
	sidecar
		.stdin
		.write_all(b"\n")
		.map_err(|e| format!("write nl: {e}"))?;
	sidecar.stdin.flush().map_err(|e| format!("flush: {e}"))?;
	Ok(id)
}

/// Create a new workspace window with its own independent sidecar.
#[tauri::command]
pub async fn new_workspace(app: AppHandle) -> Result<String, String> {
	let label = format!("workspace-{}", uuid::Uuid::new_v4().simple());
	log_file(&format!("new_workspace: creating window={}", label));
	let _window = {
		let mut builder = tauri::WebviewWindowBuilder::new(
			&app,
			&label,
			tauri::WebviewUrl::App("index.html".into()),
		)
		.title("Pizza")
		.inner_size(1200.0, 800.0)
		.min_inner_size(720.0, 480.0)
		.background_color(tauri::webview::Color(18, 18, 18, 255));
		#[cfg(target_os = "macos")]
		{
			builder = builder
				.title_bar_style(tauri::TitleBarStyle::Transparent)
				.hidden_title(true);
		}
		builder
			.build()
			.map_err(|e| format!("Failed to create window: {e}"))?
	};
	Ok(label)
}

/// List all workspaces from ~/.pizza/agent/workspaces/*/meta.json
#[tauri::command]
pub async fn list_workspaces() -> Result<Vec<Value>, String> {
	let home = std::env::var("HOME").map_err(|_| "HOME not set")?;
	let workspaces_dir = PathBuf::from(&home)
		.join(".pizza")
		.join("agent")
		.join("workspaces");

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
		let a_time = a
			.get("last_accessed_at")
			.and_then(|v| v.as_i64())
			.unwrap_or(0);
		let b_time = b
			.get("last_accessed_at")
			.and_then(|v| v.as_i64())
			.unwrap_or(0);
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
				meta.get("cwd")
					.and_then(|v| v.as_str())
					.map(|s| s.to_string())
			} else {
				None
			}
		} else {
			None
		}
	} else {
		None
	};

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
	/// Human-readable display name (from pi-ai built-ins); falls back to id.
	#[serde(rename = "name")]
	name: String,
	has_api_key: bool,
	auth_type: Option<String>, // "api_key" | "oauth"
}

/// Load built-in provider {id -> display name} map from the generated
/// `providers.json` (sourced from pi-ai at build time). Returns an empty map
/// on any failure — callers fall back to the raw id as the display name.
///
/// Search order mirrors `resolve_pizza_command`:
///   1. Packaged: `<resource_dir>/providers.json`
///   2. Dev:      `<CARGO_MANIFEST_DIR>/../../dist/providers.json`
fn load_builtin_providers(app: &AppHandle) -> HashMap<String, String> {
	let candidates: Vec<PathBuf> = {
		let mut v = Vec::new();
		if let Ok(resource_dir) = app.path().resource_dir() {
			v.push(resource_dir.join("providers.json"));
		}
		v.push(
			PathBuf::from(env!("CARGO_MANIFEST_DIR"))
				.join("..")
				.join("..")
				.join("dist")
				.join("providers.json"),
		);
		v
	};

	for path in candidates {
		match std::fs::read_to_string(&path) {
			Ok(raw) => match serde_json::from_str::<HashMap<String, String>>(&raw) {
				Ok(parsed) => return parsed,
				Err(e) => log_file(&format!(
					"load_builtin_providers: {} exists but failed to parse JSON: {}",
					path.display(),
					e
				)),
			},
			Err(_) => {} // file missing — try next candidate
		}
	}
	log_file("load_builtin_providers: no readable providers.json found in any candidate path");
	HashMap::new()
}

/// List all known providers and their auth status from auth.json.
/// The built-in provider list and display names come from the generated
/// `providers.json` (pi-ai catalog). Providers present in auth.json but not
/// in the catalog (custom providers) are appended with their raw id as name.
#[tauri::command]
pub async fn list_providers(app: AppHandle) -> Result<Vec<ProviderInfo>, String> {
	let home = std::env::var("HOME").map_err(|_| "HOME not set")?;
	let auth_path = PathBuf::from(&home)
		.join(".pizza")
		.join("agent")
		.join("auth.json");

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

	// Built-in providers: { id -> display name } from pi-ai (generated JSON).
	// Preserve catalog order by reading the file as an ordered map.
	let builtin_names: HashMap<String, String> = load_builtin_providers(&app);
	// Preserve stable display order: sorted by id.
	let mut builtin_ids: Vec<&String> = builtin_names.keys().collect();
	builtin_ids.sort();

	let mut providers: Vec<ProviderInfo> = Vec::new();

	for id in &builtin_ids {
		let cred = auth_data.get(*id);
		let has_api_key = cred.is_some();
		let auth_type = cred
			.and_then(|c| c.get("type"))
			.and_then(|t| t.as_str())
			.map(|s| s.to_string());
		providers.push(ProviderInfo {
			id: (*id).clone(),
			name: builtin_names
				.get(*id)
				.cloned()
				.unwrap_or_else(|| (*id).clone()),
			has_api_key,
			auth_type,
		});
	}

	// Add any custom providers from auth.json not in builtin list.
	for (key, _val) in &auth_data {
		if !builtin_names.contains_key(key) {
			let cred = auth_data.get(key);
			let auth_type = cred
				.and_then(|c| c.get("type"))
				.and_then(|t| t.as_str())
				.map(|s| s.to_string());
			providers.push(ProviderInfo {
				id: key.clone(),
				name: key.clone(),
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
	let json = serde_json::to_string_pretty(&Value::Object(auth_data))
		.map_err(|e| format!("serialize: {e}"))?;
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
	let auth_path = PathBuf::from(&home)
		.join(".pizza")
		.join("agent")
		.join("auth.json");

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

	log_file(&format!(
		"remove_provider_api_key: removed key for {}",
		provider
	));
	Ok(())
}

/// Set the window background color (for theme adaptation).
#[tauri::command]
pub async fn set_window_background(app: AppHandle, r: u8, g: u8, b: u8) -> Result<(), String> {
	let window = app
		.get_webview_window("main")
		.or_else(|| app.webview_windows().into_iter().next().map(|(_, w)| w));
	if let Some(window) = window {
		window
			.set_background_color(Some(tauri::webview::Color(r, g, b, 255)))
			.map_err(|e| format!("set_background_color: {e}"))?;
	}
	Ok(())
}

/// Transcribe audio data using OpenAI's Whisper API.
///
/// `audio_b64` is base64-encoded audio data (no data-URL prefix).
/// `mime_type` is the audio MIME type (e.g. "audio/webm", "audio/mp4").
/// The OpenAI API key is read from ~/.pizza/agent/auth.json under the "openai" key.
#[tauri::command]
pub async fn transcribe_audio(audio_b64: String, mime_type: String) -> Result<String, String> {
	let api_key = read_api_key("openai").ok_or_else(|| {
		"OpenAI API key not found. Add it in Settings to use voice input.".to_string()
	})?;

	// Decode base64 audio.
	let audio_bytes =
		base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &audio_b64)
			.map_err(|e| format!("base64 decode: {e}"))?;

	// Determine file extension from MIME type.
	let ext = match mime_type.as_str() {
		"audio/webm" => "webm",
		"audio/mp4" | "audio/m4a" => "mp4",
		"audio/ogg" => "ogg",
		"audio/wav" | "audio/wave" | "audio/x-wav" => "wav",
		"audio/mpeg" | "audio/mp3" => "mp3",
		_ => "webm",
	};
	let filename = format!("recording.{}", ext);

	// Build multipart form and POST to OpenAI Whisper API.
	let part = reqwest::multipart::Part::bytes(audio_bytes)
		.file_name(filename)
		.mime_str(&mime_type)
		.map_err(|e| format!("mime_str: {e}"))?;
	let form = reqwest::multipart::Form::new()
		.text("model", "whisper-1")
		.part("file", part);

	let client = reqwest::Client::new();
	let resp = client
		.post("https://api.openai.com/v1/audio/transcriptions")
		.bearer_auth(&api_key)
		.multipart(form)
		.send()
		.await
		.map_err(|e| format!("Whisper request: {e}"))?;

	if !resp.status().is_success() {
		let status = resp.status();
		let body = resp.text().await.unwrap_or_default();
		let msg = if body.len() > 500 {
			format!("Whisper API error ({}): {}...", status, &body[..500])
		} else {
			format!("Whisper API error ({}): {}", status, body)
		};
		log_file(&msg);
		return Err(msg);
	}

	let json: Value = resp
		.json()
		.await
		.map_err(|e| format!("Whisper response parse: {e}"))?;

	let text = json
		.get("text")
		.and_then(|t| t.as_str())
		.unwrap_or("")
		.trim()
		.to_string();

	Ok(text)
}

// --- File explorer (list_dir / read_file) ---

/// Directories to skip when listing (to avoid huge / irrelevant trees).
const SKIP_DIRS: &[&str] = &[
	".git",
	"node_modules",
	"target",
	".next",
	".cache",
	".turbo",
	"dist",
	"build",
	".DS_Store",
];

#[derive(serde::Serialize)]
pub struct DirEntry {
	pub name: String,
	pub path: String,
	pub is_dir: bool,
	pub size: u64,
}

/// Resolve `cwd` (expanding `~`) and join `sub_path` if provided.
fn resolve_workspace_path(cwd: &str, sub_path: Option<&str>) -> Result<PathBuf, String> {
	let expanded = if cwd.starts_with("~") {
		let home = std::env::var("HOME").map_err(|_| "HOME not set")?;
		format!("{}{}", home, &cwd[1..])
	} else {
		cwd.to_string()
	};
	let base = PathBuf::from(&expanded);
	let full = match sub_path {
		Some(s) if !s.is_empty() => base.join(s),
		_ => base,
	};
	// Canonicalize to resolve any `..` etc., but fall back to the raw path.
	Ok(full.canonicalize().unwrap_or(full))
}

/// List entries in a directory within the workspace. `sub_path` is relative
/// to `cwd`. Directories in `SKIP_DIRS` are excluded.
#[tauri::command]
pub async fn list_dir(cwd: String, sub_path: Option<String>) -> Result<Vec<DirEntry>, String> {
	let dir = resolve_workspace_path(&cwd, sub_path.as_deref())?;
	if !dir.exists() {
		return Err(format!("Directory does not exist: {}", dir.display()));
	}
	if !dir.is_dir() {
		return Err(format!("Not a directory: {}", dir.display()));
	}

	let base = resolve_workspace_path(&cwd, None)?;
	let entries = std::fs::read_dir(&dir).map_err(|e| format!("read_dir: {e}"))?;

	let mut result: Vec<DirEntry> = Vec::new();
	for entry in entries.filter_map(|e| e.ok()) {
		let file_name = entry.file_name().to_string_lossy().to_string();
		// Skip known huge / irrelevant directories.
		if SKIP_DIRS.contains(&file_name.as_str()) {
			continue;
		}
		let file_type = entry.file_type().map_err(|e| format!("file_type: {e}"))?;
		let full_path = entry.path();
		// Compute relative path from workspace root.
		let rel = full_path
			.strip_prefix(&base)
			.map(|p| p.to_string_lossy().to_string())
			.unwrap_or_else(|_| file_name.clone());
		let size = if file_type.is_dir() {
			0
		} else {
			entry.metadata().map(|m| m.len()).unwrap_or(0)
		};
		result.push(DirEntry {
			name: file_name,
			path: rel,
			is_dir: file_type.is_dir(),
			size,
		});
	}

	// Sort: directories first, then alphabetical.
	result.sort_by(|a, b| {
		b.is_dir
			.cmp(&a.is_dir)
			.then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
	});

	Ok(result)
}

/// Read a file's text content within the workspace. `file_path` is relative
/// to `cwd`. Files larger than 2 MB are rejected to avoid UI overload.
#[tauri::command]
pub async fn read_file(cwd: String, file_path: String) -> Result<String, String> {
	let full = resolve_workspace_path(&cwd, Some(&file_path))?;
	if !full.exists() {
		return Err(format!("File does not exist: {}", full.display()));
	}
	if full.is_dir() {
		return Err(format!("Path is a directory: {}", full.display()));
	}
	let metadata = std::fs::metadata(&full).map_err(|e| format!("metadata: {e}"))?;
	const MAX_SIZE: u64 = 2 * 1024 * 1024; // 2 MB
	if metadata.len() > MAX_SIZE {
		return Err(format!(
			"File is too large ({} bytes, max {} bytes)",
			metadata.len(),
			MAX_SIZE
		));
	}
	std::fs::read_to_string(&full).map_err(|e| format!("read_to_string: {e}"))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn resolve_shell_path_never_empty() {
		// Always returns something (login-shell PATH or a fallback to env PATH).
		let path = resolve_shell_path();
		assert!(
			!path.is_empty(),
			"resolve_shell_path must return a non-empty PATH"
		);
	}

	#[test]
	fn run_shell_capture_path_is_clean() {
		// When captured, the PATH must be a single line with no surrounding
		// whitespace (the printf %s form guarantees no trailing newline).
		if let Some(path) = run_shell_capture_path("/bin/zsh") {
			assert!(
				!path.contains('\n'),
				"captured PATH must not contain newlines: {path:?}"
			);
			assert_eq!(path, path.trim(), "captured PATH must be trimmed: {path:?}");
		}
	}
}
