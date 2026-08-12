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
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};

/// Combined `Read + Write` so a single trait object can carry both halves
/// (Rust forbids `dyn Read + Write` — only one non-auto trait per object).
trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

/// Default gateway socket path. On Unix: `~/.pizza/gateway.sock`. On Windows:
/// the named pipe `\\.\pipe\gateway` (mirrors the TS `gatewaySocketPath`).
pub fn gateway_socket_path() -> Option<PathBuf> {
	#[cfg(unix)]
	{
		let home = std::env::var("HOME").ok()?;
		Some(PathBuf::from(home).join(".pizza").join("gateway.sock"))
	}
	#[cfg(windows)]
	{
		Some(PathBuf::from(r"\\.\pipe\gateway"))
	}
	#[cfg(not(any(unix, windows)))]
	{
		None
	}
}

/// One message delivered to the caller: either an id-routed RPC response, or
/// a fanned-out event for a workspace.
#[derive(Debug, Clone)]
pub enum ChannelMessage {
	/// A response to a command we sent (correlated by id).
	#[allow(dead_code)]
	Response { id: String, frame: Value },
	/// A fanned-out event from a workspace's agent.
	#[allow(dead_code)]
	Event {
		#[allow(dead_code)]
		workspace: String,
		frame: Value,
	},
	/// A list_result (response to list()).
	ListResult {
		#[allow(dead_code)]
		workspaces: Value,
	},
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
	write: Arc<Mutex<Box<dyn Write + Send>>>,
	pending: PendingMap,
	/// Inbox for non-response messages (events, attach_ok, list_result, error).
	inbox: Arc<Mutex<Vec<ChannelMessage>>>,
}

impl GatewayChannel {
	/// Connect to the gateway socket/pipe. Spawns a background reader thread
	/// that parses JSONL and dispatches responses (by id) to pending waiters
	/// and everything else into the shared inbox.
	#[cfg(unix)]
	pub fn connect(socket_path: &PathBuf) -> Result<Self, String> {
		let stream = UnixStream::connect(socket_path).map_err(|e| {
			format!(
				"Failed to connect to gateway at {}: {}",
				socket_path.display(),
				e
			)
		})?;
		stream
			.set_nonblocking(false)
			.map_err(|e| format!("set_nonblocking failed: {e}"))?;
		let write_stream = stream
			.try_clone()
			.map_err(|e| format!("clone stream: {e}"))?;
		let write: Box<dyn Write + Send> = Box::new(write_stream);
		Self::from_streams(stream, write)
	}

	/// Connect to the gateway named pipe (Windows). Spawns the same background
	/// reader thread as the Unix path — a `File` over a duplicated pipe handle
	/// implements `Read`/`Write`, so the JSONL dispatch logic is shared.
	#[cfg(windows)]
	pub fn connect(socket_path: &PathBuf) -> Result<Self, String> {
		let pipe_name = socket_path.to_string_lossy().to_string();
		let file = windows_connect_pipe(&pipe_name)?;
		let write_half = file
			.try_clone()
			.map_err(|e| format!("clone pipe: {e}"))?;
		let write: Box<dyn Write + Send> = Box::new(write_half);
		Self::from_streams(file, write)
	}

	/// Build a channel from its read + write halves and spawn the shared
	/// reader thread. Platform-specific `connect` impls produce the halves;
	/// everything from here on (JSONL parsing, id-routed dispatch, EOF
	/// handling) is identical across Unix sockets and Windows named pipes.
	fn from_streams<R: Read + Send + 'static>(
		read: R,
		write: Box<dyn Write + Send>,
	) -> Result<Self, String> {
		let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
		let inbox: Arc<Mutex<Vec<ChannelMessage>>> = Arc::new(Mutex::new(Vec::new()));

		let reader_pending = Arc::clone(&pending);
		let reader_inbox = Arc::clone(&inbox);
		thread::spawn(move || {
			let reader = BufReader::new(read);
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
					Err(_) => {
						break;
					}
				}
			}
			// EOF: notify + release any waiters so they don't hang forever.
			reader_inbox
				.lock()
				.unwrap()
				.push(ChannelMessage::Disconnected);
			for (_, slot) in reader_pending.lock().unwrap().drain() {
				if let Ok(mut guard) = slot.lock() {
					if guard.is_none() {
						*guard = Some(json!({ "_disconnected": true }));
					}
				}
			}
		});

		Ok(Self {
			write: Arc::new(Mutex::new(write)),
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
				let id = frame
					.get("id")
					.and_then(|i| i.as_str())
					.map(|s| s.to_string());
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
				inbox
					.lock()
					.unwrap()
					.push(ChannelMessage::AttachOk { workspace });
			}
			"list_result" => {
				let workspaces = parsed
					.get("workspaces")
					.cloned()
					.unwrap_or(Value::Array(vec![]));
				inbox
					.lock()
					.unwrap()
					.push(ChannelMessage::ListResult { workspaces });
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
		stream
			.write_all(b"\n")
			.map_err(|e| format!("write nl: {e}"))?;
		stream.flush().map_err(|e| format!("flush: {e}"))?;
		Ok(())
	}

	/// Attach to a workspace's event stream. Returns the resolved cwd.
	pub fn attach(&self, workspace: &str) -> Result<String, String> {
		self.write_line(&json!({ "type": "attach", "workspace": workspace }))?;
		self.wait_inbox(|msg| {
			matches!(
				msg,
				ChannelMessage::AttachOk { .. } | ChannelMessage::Error(_)
			)
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
		self.pending
			.lock()
			.unwrap()
			.insert(id.clone(), Arc::clone(&slot));
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
	#[allow(dead_code)]
	pub fn list(&self) -> Result<Value, String> {
		self.write_line(&json!({ "type": "list" }))?;
		self.wait_inbox(|msg| {
			matches!(
				msg,
				ChannelMessage::ListResult { .. } | ChannelMessage::Error(_)
			)
		})
		.and_then(|msg| match msg {
			ChannelMessage::ListResult { workspaces } => Ok(workspaces),
			ChannelMessage::Error(e) => Err(e),
			_ => Err("unexpected message".into()),
		})
	}

	/// Stop receiving events for a workspace on this connection.
	#[allow(dead_code)]
	pub fn detach(&self, workspace: &str) -> Result<(), String> {
		self.write_line(&json!({ "type": "detach", "workspace": workspace }))
	}

	/// Drain only fanned-out **events** and the disconnect sentinel from the
	/// inbox. Control messages (AttachOk / ListResult / Error) are left in
	/// place so a concurrent `attach()`/`list()` via `wait_inbox` doesn't lose
	/// its reply to the drainer. Disconnect is also returned so the caller can
	/// detect a dead connection.
	pub fn drain_events(&self) -> Vec<ChannelMessage> {
		let mut inbox = self.inbox.lock().unwrap();
		let (events, rest): (Vec<ChannelMessage>, Vec<ChannelMessage>) =
			inbox.drain(..).partition(|m| {
				matches!(
					m,
					ChannelMessage::Event { .. } | ChannelMessage::Disconnected
				)
			});
		// Put control messages back so wait_inbox can still see them.
		inbox.extend(rest);
		events
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
/// the TS ensureGateway. Returns once the socket/pipe responds to a ping.
pub fn ensure_gateway(socket_path: &PathBuf, pizza_cmd: (&str, &[String])) -> Result<(), String> {
	use std::process::{Command, Stdio};
	// Fast path: ping an existing gateway.
	if gateway_ready(socket_path) {
		return Ok(());
	}
	let env_pizza = std::env::var("PIZZA_BIN").ok();
	// Resolve the main agent directory so the gateway can pass --main to
	// sub-agents spawned for that cwd. The gateway itself does NOT run as
	// the main agent (no --main flag); it just needs to know the path.
	let main_dir = std::env::var("HOME")
		.or_else(|_| std::env::var("USERPROFILE"))
		.ok()
		.map(|h| {
			PathBuf::from(h)
				.join(".pizza")
				.join("main")
				.to_string_lossy()
				.to_string()
		});
	let (program, base_args): (String, Vec<String>) = if let Some(bin) = env_pizza {
		let parts: Vec<&str> = bin.split_whitespace().collect();
		let p = parts[0].to_string();
		let mut a: Vec<String> = parts[1..].iter().map(|s| s.to_string()).collect();
		a.extend(["--mode".to_string(), "gateway".to_string()]);
		if let Some(ref md) = main_dir {
			a.extend(["--main-dir".to_string(), md.clone()]);
		}
		(p, a)
	} else {
		(pizza_cmd.0.to_string(), {
			let mut v = pizza_cmd.1.to_vec();
			v.extend(["--mode".to_string(), "gateway".to_string()]);
			if let Some(ref md) = main_dir {
				v.extend(["--main-dir".to_string(), md.clone()]);
			}
			v
		})
	};
	let mut cmd = Command::new(&program);
	cmd.args(&base_args);
	cmd.envs(std::env::vars().filter(|(k, _)| k != "PIZZA_BIN"));
	cmd.env(
		"PIZZA_GATEWAY_SOCKET",
		socket_path.to_string_lossy().to_string(),
	);
	cmd.stdin(Stdio::null());
	cmd.stdout(Stdio::null());
	cmd.stderr(Stdio::null());
	// On Windows, detach the child from this console so it survives exit.
	#[cfg(windows)]
	{
		use std::os::windows::process::CommandExt;
		// DETACHED_PROCESS = 0x00000008; CREATE_NEW_PROCESS_GROUP = 0x00000200.
		cmd.creation_flags(0x00000008 | 0x00000200);
	}
	let child = cmd
		.spawn()
		.map_err(|e| format!("Failed to spawn gateway: {e}"))?;
	// Detach so it outlives the desktop process.
	let _ = child.id();
	// Wait for the socket/pipe to respond.
	let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
	while std::time::Instant::now() < deadline {
		std::thread::sleep(std::time::Duration::from_millis(100));
		if gateway_ready(socket_path) {
			return Ok(());
		}
	}
	Err(format!(
		"Gateway failed to start within 15s (socket: {})",
		socket_path.display()
	))
}

/// True if the gateway is listening and answers a ping. On Unix the socket
/// file must exist first (cheap stat); on Windows a named pipe has no
/// filesystem entry, so we probe by connecting directly.
#[cfg(unix)]
fn gateway_ready(socket_path: &PathBuf) -> bool {
	socket_path.exists() && ping_gateway(socket_path).unwrap_or(false)
}

#[cfg(windows)]
fn gateway_ready(socket_path: &PathBuf) -> bool {
	ping_gateway(socket_path).unwrap_or(false)
}

/// Ping the gateway; true if it answers pong. Runs the probe on a background
/// thread with a 2s deadline so a hung/nonexistent gateway can't stall the
/// caller (named-pipe reads have no portable per-op timeout on Windows, and
/// this keeps the Unix and Windows paths uniform).
fn ping_gateway(socket_path: &PathBuf) -> Result<bool, String> {
	let path = socket_path.clone();
	let (tx, rx) = std::sync::mpsc::channel();
	thread::spawn(move || {
		let result = open_gateway_stream(&path).and_then(ping_with_stream);
		let _ = tx.send(result);
	});
	match rx.recv_timeout(std::time::Duration::from_secs(2)) {
		Ok(Ok(pong)) => Ok(pong),
		// A connect/read error means "not ready yet" → not a hard failure.
		Ok(Err(_)) => Ok(false),
		// Timeout or sender dropped (thread panicked) → treat as not ready.
		Err(_) => Ok(false),
	}
}

/// Open a fresh read+write stream to the gateway for a ping. One connection
/// per probe; the long-lived channel uses `GatewayChannel::connect`.
#[cfg(unix)]
fn open_gateway_stream(
	socket_path: &PathBuf,
) -> Result<Box<dyn ReadWrite + Send>, String> {
	let stream = UnixStream::connect(socket_path).map_err(|e| e.to_string())?;
	stream
		.set_read_timeout(Some(std::time::Duration::from_secs(2)))
		.map_err(|e| e.to_string())?;
	Ok(Box::new(stream))
}

#[cfg(windows)]
fn open_gateway_stream(
	socket_path: &PathBuf,
) -> Result<Box<dyn ReadWrite + Send>, String> {
	let pipe_name = socket_path.to_string_lossy().to_string();
	let file = windows_connect_pipe(&pipe_name)?;
	Ok(Box::new(file))
}

/// Send `{"type":"ping"}` and check for a `pong` reply on a single stream.
fn ping_with_stream(mut stream: Box<dyn ReadWrite + Send>) -> Result<bool, String> {
	let payload = serde_json::to_string(&json!({ "type": "ping" })).map_err(|e| e.to_string())?;
	stream
		.write_all(payload.as_bytes())
		.map_err(|e| e.to_string())?;
	stream.write_all(b"\n").map_err(|e| e.to_string())?;
	stream.flush().map_err(|e| e.to_string())?;
	let mut reader = BufReader::new(stream);
	let mut line = String::new();
	reader.read_line(&mut line).map_err(|e| e.to_string())?;
	let parsed: Value = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
	Ok(parsed.get("type").and_then(|t| t.as_str()) == Some("pong"))
}

/// Connect to a Windows named pipe (e.g. `\\.\pipe\gateway`) and return it as
/// a `File`, which implements `Read`/`Write`/`try_clone` just like `UnixStream`.
#[cfg(windows)]
fn windows_connect_pipe(pipe_name: &str) -> Result<std::fs::File, String> {
	use std::os::windows::io::{FromRawHandle, RawHandle};
	use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
	use windows_sys::Win32::Storage::FileSystem::{
		CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, GENERIC_READ,
		GENERIC_WRITE, OPEN_EXISTING,
	};
	let mut wide: Vec<u16> = pipe_name.encode_utf16().collect();
	wide.push(0);
	let handle = unsafe {
		CreateFileW(
			wide.as_ptr(),
			GENERIC_READ | GENERIC_WRITE,
			FILE_SHARE_READ | FILE_SHARE_WRITE,
			std::ptr::null(),
			OPEN_EXISTING,
			FILE_ATTRIBUTE_NORMAL,
			core::ptr::null(),
		)
	};
	if handle == INVALID_HANDLE_VALUE {
		return Err(format!(
			"Failed to connect to gateway pipe {}: {}",
			pipe_name,
			std::io::Error::last_os_error()
		));
	}
	// SAFETY: CreateFileW returned a valid, owned HANDLE; wrapping it as a
	// File transfers ownership (File::drop closes the handle).
	Ok(unsafe { std::fs::File::from_raw_handle(handle as RawHandle) })
}

#[cfg(not(any(unix, windows)))]
mod _unsupported_stub {
	//! No gateway transport on this platform. Keeps the crate compiling.
	use super::*;
	impl GatewayChannel {
		pub fn connect(_socket_path: &PathBuf) -> Result<Self, String> {
			Err("gateway channel is not implemented on this platform".into())
		}
	}
	pub fn ensure_gateway(
		_socket_path: &PathBuf,
		_pizza_cmd: (&str, &[String]),
	) -> Result<(), String> {
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
		GatewayChannel::dispatch(
			&json!({ "type": "error", "message": "boom" }),
			&pending,
			&inbox,
		);
		assert!(inbox
			.lock()
			.unwrap()
			.iter()
			.any(|m| matches!(m, ChannelMessage::AttachOk { .. })));
		assert!(inbox
			.lock()
			.unwrap()
			.iter()
			.any(|m| matches!(m, ChannelMessage::Error(_))));
	}

	#[cfg(unix)]
	mod live_tests {
		use super::*;
		use std::os::unix::net::UnixListener;
		use std::path::PathBuf;
		use std::thread;

		fn tmp_sock() -> PathBuf {
			let p = std::env::temp_dir().join(format!(
				"pizza-gw-test-{}-{}-{}.sock",
				std::process::id(),
				line!(),
				random_u32()
			));
			let _ = std::fs::remove_file(&p);
			p
		}

		fn random_u32() -> u32 {
			use std::time::SystemTime;
			let dur = SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap();
			dur.subsec_nanos().wrapping_mul(2654435761)
		}

		/// A scripted step: optionally wait for one incoming line, then send a reply.
		struct Step {
			consume_input: bool,
			reply: String,
		}

		/// A fake gateway: accept one connection, then play a scripted conversation.
		fn spawn_fake_server(sock: PathBuf, script: Vec<Step>) {
			thread::spawn(move || {
				let listener = match UnixListener::bind(&sock) {
					Ok(l) => l,
					Err(_) => return,
				};
				let (mut stream, _) = match listener.accept() {
					Ok(s) => s,
					Err(_) => return,
				};
				let reader = BufReader::new(stream.try_clone().unwrap());
				let mut lines = reader.lines();
				for step in script {
					if step.consume_input {
						let _ = lines.next();
					}
					let _ = writeln!(stream, "{}", step.reply);
					let _ = stream.flush();
				}
				thread::sleep(std::time::Duration::from_millis(200));
			});
			thread::sleep(std::time::Duration::from_millis(50));
		}

		#[test]
		fn connect_attach_rpc_and_event_over_real_socket() {
			let sock = tmp_sock();
			// Script: reply to attach with attach_ok, to rpc with an id-matched
			// response, then push a fanned-out event.
			spawn_fake_server(
				sock.clone(),
				vec![
					Step { consume_input: true, reply: r#"{"type":"attach_ok","workspace":"/proj"}"#.to_string() },
					Step { consume_input: true, reply: r#"{"type":"rpc","workspace":"/proj","frame":{"id":"r1","type":"response","command":"get_state","success":true}}"#.to_string() },
					Step { consume_input: false, reply: r#"{"type":"rpc","workspace":"/proj","frame":{"type":"AGENT_MESSAGE","text":"hi"}}"#.to_string() },
				],
			);

			let client = GatewayChannel::connect(&sock).expect("connect");
			let cwd = client.attach("/proj").expect("attach");
			assert_eq!(cwd, "/proj");

			let resp = client
				.rpc("/proj", json!({ "id": "r1", "type": "get_state" }))
				.expect("rpc");
			assert_eq!(resp.get("id").and_then(|v| v.as_str()), Some("r1"));
			assert_eq!(resp.get("type").and_then(|v| v.as_str()), Some("response"));

			// The event should land in the inbox.
			let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
			let mut got_event = false;
			while std::time::Instant::now() < deadline {
				let drained = client.drain_events();
				if drained
					.iter()
					.any(|m| matches!(m, ChannelMessage::Event { frame, .. } if frame.get("type").and_then(|v| v.as_str()) == Some("AGENT_MESSAGE")))
				{
					got_event = true;
					break;
				}
				std::thread::sleep(std::time::Duration::from_millis(20));
			}
			assert!(got_event, "fan-out event should reach the inbox");
		}

		#[test]
		fn connect_error_on_missing_socket() {
			let sock = tmp_sock();
			assert!(GatewayChannel::connect(&sock).is_err());
		}
	}
}
