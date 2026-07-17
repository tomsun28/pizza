use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

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

static SIDECAR_STDIN: Mutex<Option<std::process::ChildStdin>> = Mutex::new(None);
static SIDECAR_CHILD: Mutex<Option<Child>> = Mutex::new(None);
pub static APP_HANDLE: Mutex<Option<AppHandle>> = Mutex::new(None);

/// One-shot init: spawns sidecar, sends get_state. Returns cwd.
#[tauri::command]
pub async fn init_sidecar() -> Result<String, String> {
	log_file("init_sidecar: start");

	let cwd = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("..")
		.canonicalize()
		.map(|p| p.to_string_lossy().to_string())
		.unwrap_or_else(|_| ".".to_string());
	log_file(&format!("init_sidecar: cwd={}", cwd));

	{
		let mut g = SIDECAR_STDIN.lock().unwrap();
		*g = None;
	}
	{
		let mut g = SIDECAR_CHILD.lock().unwrap();
		if let Some(mut child) = g.take() {
			let _ = child.kill();
			let _ = child.wait();
		}
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

	// Store stdin and child.
	{
		let mut g = SIDECAR_STDIN.lock().unwrap();
		*g = Some(stdin);
	}
	{
		let mut g = SIDECAR_CHILD.lock().unwrap();
		*g = Some(child);
	}

	// Spawn reader thread for subsequent events.
	let app = APP_HANDLE.lock().unwrap().clone();
	std::thread::spawn(move || {
		log_file("reader thread: started");
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
					log_file(&format!("sidecar stdout: {}", trimmed));
					if let Some(app) = &app {
						let etype = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");
						match etype {
							"response" => { let _ = app.emit("rpc_response", parsed); }
							"extension_ui_request" => { let _ = app.emit("extension_ui_request", parsed); }
							_ => { let _ = app.emit("rpc_event", parsed); }
						}
					}
				}
				Err(e) => {
					log_file(&format!("reader error: {e}"));
					break;
				}
			}
		}
		log_file("reader thread: EOF");
		// Diagnostics: why did sidecar stdout close?
		{
			let mut g = SIDECAR_CHILD.lock().unwrap();
			if let Some(child) = g.as_mut() {
				match child.try_wait() {
					Ok(Some(status)) => log_file(&format!("sidecar exited: status={status}")),
					Ok(None) => log_file("sidecar still running but stdout closed (stdin pipe may be broken)"),
					Err(e) => log_file(&format!("sidecar try_wait error: {e}")),
				}
			} else {
				log_file("sidecar child is None on EOF (taken/killed elsewhere)");
			}
			let stdin_alive = SIDECAR_STDIN.lock().unwrap().is_some();
			log_file(&format!("stdin still held: {stdin_alive}"));
		}
		if let Some(app) = &app {
			let _ = app.emit("sidecar_exit", serde_json::json!({ "code": null }));
		}
	});

	log_file("init_sidecar: done");
	// Return the state data as JSON string.
	Ok(state_data.to_string())
}

#[tauri::command]
pub fn stop_sidecar() -> Result<(), String> {
	{
		let mut g = SIDECAR_STDIN.lock().unwrap();
		*g = None;
	}
	let mut g = SIDECAR_CHILD.lock().unwrap();
	if let Some(mut child) = g.take() {
		let _ = child.kill();
		let _ = child.wait();
	}
	Ok(())
}

#[tauri::command]
pub fn rpc_command(command: Value) -> Result<String, String> {
	log_file(&format!("rpc_command: {}", command));
	let mut obj = command.as_object().cloned().ok_or("command must be an object")?;
	let id = if let Some(existing) = obj.get("id").and_then(|v| v.as_str()) {
		existing.to_string()
	} else {
		let id = uuid::Uuid::new_v4().to_string();
		obj.insert("id".to_string(), Value::String(id.clone()));
		id
	};
	let line = serde_json::to_string(&Value::Object(obj)).map_err(|e| e.to_string())?;
	log_file(&format!("rpc_command sending: {}", line));

	let mut g = SIDECAR_STDIN.lock().unwrap();
	let stdin = g.as_mut().ok_or("Sidecar is not running")?;
	stdin.write_all(line.as_bytes()).map_err(|e| format!("write: {e}"))?;
	stdin.write_all(b"\n").map_err(|e| format!("write nl: {e}"))?;
	stdin.flush().map_err(|e| format!("flush: {e}"))?;
	Ok(id)
}
