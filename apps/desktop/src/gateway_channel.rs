//! Gateway channel client (Rust mirror of packages/gateway/channel-client.ts).
//!
//! Connects to the gateway's Unix socket and speaks the Layer-1 channel
//! protocol: attach to a workspace, forward Layer-0 RPC commands (response
//! correlated by id), enumerate workspaces, and receive the agent's event
//! stream. This is the building block for migrating the desktop bridge from
//! "spawn a sidecar per cwd" to "one gateway-owned agent, many channels".
//!
//! Kept self-contained (std::net + a reader thread, mirroring bridge.rs's
//! sidecar reader pattern) so it can be wired behind a new Tauri command
//! without touching the existing spawn path.
//!
//! NOTE: this module is the foundation; the live init_sidecar/rpc_command
//! rewrite + GUI smoke test is a separate step (see ADR in the PR thread).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};

/// Default gateway socket path: ~/.pizza/gateway.sock
pub fn gateway_socket_path() -> Option<PathBuf> {
	let home = std::env::var("HOME").ok()?;
	Some(PathBuf::from(home).join(".pizza").join("gateway.sock"))
}

/// One message delivered to the caller: either an id-routed RPC response, or
/// a fanned-out event for a workspace.
#[derive(Debug, Clone)]
pub enum ChannelMessage {
	/// A response to a command we sent (correlated by id).
	Response { id: String, frame: Value },
	/// A fanned-out event from a workspace's agent.
	Event { workspace: String, frame: Value },
	/// A list_result (response to list()).
	ListResult { workspaces: Value },
	/// An attach confirmation (carries the resolved cwd).
	AttachOk { workspace: String },
	/// A gateway-level error.
	Error(String),
	/// The reader thread hit EOF / the connection closed.
	Disconnected,
}

type PendingMap = Arc<Mutex<HashMap<String, Arc<Mutex<Option<Value>>>>>>;

/// A channel connection to the gateway. Cheap to clone — the underlying socket
/// and reader thread are shared via Arc. Each clone is the same connection;
/// use one per desktop process (the gateway multiplexes many workspaces).
#[derive(Clone)]
pub struct GatewayChannel {
	write: Arc<Mutex<UnixStream>>,
	pending: PendingMap,
	/// Inbox for non-response messages (events, attach_ok, list_result, error).
	inbox: Arc<Mutex<Vec<ChannelMessage>>>,
}

impl GatewayChannel {
	/// Connect to the gateway socket. Spawns a background reader thread that
	/// parses JSONL and dispatches responses (by id) to pending waiters and
	/// everything else into the shared inbox.
	#[cfg(unix)]
	pub fn connect(socket_path: &PathBuf) -> Result<Self, String> {
		let stream = UnixStream::connect(socket_path).map_err(|e| {
			format!("Failed to connect to gateway at {}: {}", socket_path.display(), e)
		})?;
		stream
			.set_nonblocking(false)
			.map_err(|e| format!("set_nonblocking failed: {e}"))?;
		let write_stream = stream.try_clone().map_err(|e| format!("clone stream: {e}"))?;

		let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
		let inbox: Arc<Mutex<Vec<ChannelMessage>>> = Arc::new(Mutex::new(Vec::new()));

		let reader_pending = Arc::clone(&pending);
		let reader_inbox = Arc::clone(&inbox);
		thread::spawn(move || {
			let reader = BufReader::new(stream);
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
						Self::dispatch(&parsed, &reader_pending, &reader_inbox);
					}
					Err(_) => break,
				}
			}
			// EOF: notify + release any waiters so they don't hang forever.
			reader_inbox.lock().unwrap().push(ChannelMessage::Disconnected);
			for (_, slot) in reader_pending.lock().unwrap().drain() {
				if let Ok(mut guard) = slot.lock() {
					if guard.is_none() {
						*guard = Some(json!({ "_disconnected": true }));
					}
				}
			}
		});

		Ok(Self {
			write: Arc::new(Mutex::new(write_stream)),
			pending,
			inbox,
		})
	}

	/// Route one parsed gateway message to its waiter (response) or the inbox.
	fn dispatch(parsed: &Value, pending: &PendingMap, inbox: &Arc<Mutex<Vec<ChannelMessage>>>) {
		let etype = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");
		match etype {
			"rpc" => {
				let workspace = parsed
					.get("workspace")
					.and_then(|w| w.as_str())
					.unwrap_or("")
					.to_string();
				let frame = parsed.get("frame").cloned().unwrap_or(Value::Null);
				let id = frame.get("id").and_then(|i| i.as_str()).map(|s| s.to_string());
				if let Some(id) = id {
					if let Some(slot) = pending.lock().unwrap().get(&id).cloned() {
						if let Ok(mut guard) = slot.lock() {
							*guard = Some(frame.clone());
						}
						return;
					}
				}
				// Not a pending response → it's a fanned-out event.
				inbox
					.lock()
					.unwrap()
					.push(ChannelMessage::Event { workspace, frame });
			}
			"attach_ok" => {
				let workspace = parsed
					.get("workspace")
					.and_then(|w| w.as_str())
					.unwrap_or("")
					.to_string();
				inbox.lock().unwrap().push(ChannelMessage::AttachOk { workspace });
			}
			"list_result" => {
				let workspaces = parsed.get("workspaces").cloned().unwrap_or(Value::Array(vec![]));
				inbox.lock().unwrap().push(ChannelMessage::ListResult { workspaces });
			}
			"error" => {
				let message = parsed
					.get("message")
					.and_then(|m| m.as_str())
					.unwrap_or("gateway error")
					.to_string();
				inbox.lock().unwrap().push(ChannelMessage::Error(message));
			}
			_ => {}
		}
	}

	fn write_line(&self, obj: &Value) -> Result<(), String> {
		let line = serde_json::to_string(obj).map_err(|e| e.to_string())?;
		let mut stream = self.write.lock().map_err(|e| e.to_string())?;
		stream
			.write_all(line.as_bytes())
			.map_err(|e| format!("write: {e}"))?;
		stream.write_all(b"\n").map_err(|e| format!("write nl: {e}"))?;
		stream.flush().map_err(|e| format!("flush: {e}"))?;
		Ok(())
	}

	/// Attach to a workspace's event stream. Returns the resolved cwd.
	pub fn attach(&self, workspace: &str) -> Result<String, String> {
		self.write_line(&json!({ "type": "attach", "workspace": workspace }))?;
		self.wait_inbox(|msg| {
			matches!(msg, ChannelMessage::AttachOk { .. } | ChannelMessage::Error(_))
		})
		.and_then(|msg| match msg {
			ChannelMessage::AttachOk { workspace } => Ok(workspace),
			ChannelMessage::Error(e) => Err(e),
			_ => Err("unexpected message".into()),
		})
	}

	/// Forward a Layer-0 RPC command to a workspace's agent and await the
	/// response (correlated by the command's id).
	pub fn rpc(&self, workspace: &str, frame: Value) -> Result<Value, String> {
		let id = frame
			.get("id")
			.and_then(|i| i.as_str())
			.ok_or_else(|| "rpc frame requires a string id".to_string())?
			.to_string();
		let slot: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
		self.pending.lock().unwrap().insert(id.clone(), Arc::clone(&slot));
		self.write_line(&json!({ "type": "rpc", "workspace": workspace, "frame": frame }))?;
		// Spin-wait on the slot. The reader thread fills it (or a disconnect
		// sentinel). Matches the blocking nature of the sidecar reader path.
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
		loop {
			if let Some(value) = slot.lock().unwrap().take() {
				self.pending.lock().unwrap().remove(&id);
				if value.get("_disconnected").is_some() {
					return Err("gateway connection closed".into());
				}
				return Ok(value);
			}
			if std::time::Instant::now() > deadline {
				self.pending.lock().unwrap().remove(&id);
				return Err("rpc timed out waiting for response".into());
			}
			std::thread::sleep(std::time::Duration::from_millis(5));
		}
	}

	/// Enumerate known workspaces.
	pub fn list(&self) -> Result<Value, String> {
		self.write_line(&json!({ "type": "list" }))?;
		self.wait_inbox(|msg| matches!(msg, ChannelMessage::ListResult { .. } | ChannelMessage::Error(_)))
			.and_then(|msg| match msg {
				ChannelMessage::ListResult { workspaces } => Ok(workspaces),
				ChannelMessage::Error(e) => Err(e),
				_ => Err("unexpected message".into()),
			})
	}

	/// Stop receiving events for a workspace on this connection.
	pub fn detach(&self, workspace: &str) -> Result<(), String> {
		self.write_line(&json!({ "type": "detach", "workspace": workspace }))
	}

	/// Drain the inbox of fanned-out events (and any other non-response messages).
	pub fn drain_events(&self) -> Vec<ChannelMessage> {
		self.inbox.lock().unwrap().drain(..).collect()
	}

	/// Block until an inbox message matches `pred`, then return it.
	fn wait_inbox<F>(&self, pred: F) -> Result<ChannelMessage, String>
	where
		F: Fn(&ChannelMessage) -> bool,
	{
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
		loop {
			let mut inbox = self.inbox.lock().unwrap();
			if let Some(pos) = inbox.iter().position(|m| pred(m)) {
				return Ok(inbox.remove(pos));
			}
			drop(inbox);
			if std::time::Instant::now() > deadline {
				return Err("timed out waiting for gateway response".into());
			}
			std::thread::sleep(std::time::Duration::from_millis(5));
		}
	}
}

/// Spawn (or reuse) the gateway daemon: `pizza --mode gateway`. Detached, like
/// the TS ensureGateway. Returns once the socket responds to a ping.
pub fn ensure_gateway(socket_path: &PathBuf, pizza_cmd: (&str, &[String])) -> Result<(), String> {
	use std::process::{Command, Stdio};
	// Fast path: ping an existing gateway.
	if socket_path.exists() && ping_gateway(socket_path).unwrap_or(false) {
		return Ok(());
	}
	let env_pizza = std::env::var("PIZZA_BIN").ok();
	let (program, base_args): (String, Vec<String>) = if let Some(bin) = env_pizza {
		let parts: Vec<&str> = bin.split_whitespace().collect();
		let p = parts[0].to_string();
		let mut a: Vec<String> = parts[1..].iter().map(|s| s.to_string()).collect();
		a.extend(["--mode".to_string(), "gateway".to_string()]);
		(p, a)
	} else {
		(pizza_cmd.0.to_string(), {
			let mut v = pizza_cmd.1.to_vec();
			v.extend(["--mode".to_string(), "gateway".to_string()]);
			v
		})
	};
	let mut cmd = Command::new(&program);
	cmd.args(&base_args);
	cmd.envs(std::env::vars().filter(|(k, _)| k != "PIZZA_BIN"));
	cmd.env("PIZZA_GATEWAY_SOCKET", socket_path.to_string_lossy().to_string());
	cmd.stdin(Stdio::null());
	cmd.stdout(Stdio::null());
	cmd.stderr(Stdio::null());
	let child = cmd
		.spawn()
		.map_err(|e| format!("Failed to spawn gateway: {e}"))?;
	// Detach so it outlives the desktop process.
	let _ = child.id();
	// Wait for the socket to respond.
	let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
	while std::time::Instant::now() < deadline {
		std::thread::sleep(std::time::Duration::from_millis(100));
		if socket_path.exists() && ping_gateway(socket_path).unwrap_or(false) {
			return Ok(());
		}
	}
	Err(format!(
		"Gateway failed to start within 15s (socket: {})",
		socket_path.display()
	))
}

/// Ping the gateway; true if it answers pong.
fn ping_gateway(socket_path: &PathBuf) -> Result<bool, String> {
	let mut stream = UnixStream::connect(socket_path).map_err(|e| e.to_string())?;
	stream
		.set_read_timeout(Some(std::time::Duration::from_secs(2)))
		.map_err(|e| e.to_string())?;
	let payload = serde_json::to_string(&json!({ "type": "ping" })).map_err(|e| e.to_string())?;
	stream
		.write_all(payload.as_bytes())
		.map_err(|e| e.to_string())?;
	stream.write_all(b"\n").map_err(|e| e.to_string())?;
	let mut reader = BufReader::new(stream);
	let mut line = String::new();
	reader.read_line(&mut line).map_err(|e| e.to_string())?;
	let parsed: Value = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
	Ok(parsed.get("type").and_then(|t| t.as_str()) == Some("pong"))
}

#[cfg(not(unix))]
mod _non_unix_stub {
	//! Gateway channel is Unix-socket-based for now. Windows uses named pipes
	//! (the TS gateway already handles both); the Rust client's Windows path is
	//! a follow-up. This stub keeps the crate compiling on non-unix targets.
	use super::*;
	impl GatewayChannel {
		pub fn connect(_socket_path: &PathBuf) -> Result<Self, String> {
			Err("gateway channel is not implemented on this platform".into())
		}
	}
	#[cfg(unix)]
	pub fn ensure_gateway(_socket_path: &PathBuf, _pizza_cmd: (&str, &[String])) -> Result<(), String> {
		Err("gateway channel is not implemented on this platform".into())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn dispatch_routes_response_by_id_and_events_to_inbox() {
		let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
		let inbox: Arc<Mutex<Vec<ChannelMessage>>> = Arc::new(Mutex::new(Vec::new()));
		let slot: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
		pending
			.lock()
			.unwrap()
			.insert("req_1".to_string(), Arc::clone(&slot));

		// A response with id req_1 → fills the slot, NOT the inbox.
		GatewayChannel::dispatch(
			&json!({ "type": "rpc", "workspace": "/x", "frame": { "id": "req_1", "type": "response" } }),
			&pending,
			&inbox,
		);
		assert!(slot.lock().unwrap().is_some());
		assert!(inbox.lock().unwrap().is_empty());

		// An event (no matching id) → inbox.
		GatewayChannel::dispatch(
			&json!({ "type": "rpc", "workspace": "/x", "frame": { "type": "AGENT_MESSAGE" } }),
			&pending,
			&inbox,
		);
		assert!(matches!(
			inbox.lock().unwrap().last(),
			Some(ChannelMessage::Event { .. })
		));

		// attach_ok / list_result / error → inbox.
		GatewayChannel::dispatch(
			&json!({ "type": "attach_ok", "workspace": "/x" }),
			&pending,
			&inbox,
		);
		GatewayChannel::dispatch(&json!({ "type": "error", "message": "boom" }), &pending, &inbox);
		assert!(inbox.lock().unwrap().iter().any(|m| matches!(m, ChannelMessage::AttachOk { .. })));
		assert!(inbox.lock().unwrap().iter().any(|m| matches!(m, ChannelMessage::Error(_))));
	}
}
