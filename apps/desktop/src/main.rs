// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;

use tauri::{Manager, WindowEvent};

fn main() {
	env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
	tauri::Builder::default()
		.plugin(tauri_plugin_shell::init())
		.plugin(tauri_plugin_dialog::init())
		.manage(bridge::BridgeState::default())
		.invoke_handler(tauri::generate_handler![
			bridge::init_sidecar,
			bridge::stop_sidecar,
			bridge::rpc_command,
			bridge::new_workspace,
			bridge::list_workspaces,
			bridge::delete_workspace,
			bridge::reveal_workspace,
			bridge::list_providers,
			bridge::set_provider_api_key,
			bridge::remove_provider_api_key,
			bridge::restart_sidecar,
			bridge::set_window_background,
			bridge::transcribe_audio,
			bridge::list_dir,
			bridge::read_file,
			bridge::open_in_editor,
			bridge::reveal_path,
			bridge::fetch_skills_sh,
		])
		.setup(|app| {
			bridge::start_scheduler_sidecar_guard(app.handle().clone());
			#[cfg(debug_assertions)]
			{
				if let Some(window) = app.get_webview_window("main") {
					window.open_devtools();
				}
			}
			Ok(())
		})
		.on_window_event(|window, event| {
			if let WindowEvent::CloseRequested { .. } = event {
				let label = window.label().to_string();
				log::info!("window {} closed, stopping its sidecar", label);
				let state = window.app_handle().state::<bridge::BridgeState>();
				bridge::kill_sidecar_for_window(state.inner(), &label);
			}
		})
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
