// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;

use tauri::{Manager, WindowEvent};

fn main() {
	env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
	tauri::Builder::default()
		.plugin(tauri_plugin_shell::init())
		.plugin(tauri_plugin_dialog::init())
		.invoke_handler(tauri::generate_handler![
			bridge::init_sidecar,
			bridge::stop_sidecar,
			bridge::rpc_command,
		])
		.setup(|_app| {
			{
				let mut g = bridge::APP_HANDLE.lock().unwrap();
				*g = Some(_app.handle().clone());
			}
			#[cfg(debug_assertions)]
			{
				if let Some(window) = _app.get_webview_window("main") {
					window.open_devtools();
				}
			}
			Ok(())
		})
		.on_window_event(|window, event| {
			if let WindowEvent::CloseRequested { .. } = event {
				if window.label() == "main" {
					log::info!("main window closed, stopping sidecar");
					let _ = bridge::stop_sidecar();
				}
			}
		})
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
