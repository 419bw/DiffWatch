// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod commands;
mod git_ops;
mod watcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(watcher::WatcherState::new())
        .invoke_handler(tauri::generate_handler![
            commands::get_git_status,
            commands::get_file_content,
            commands::read_directory,
            commands::stage_file,
            commands::discard_file,
            commands::unstage_file,
            commands::get_staged_diff,
            commands::execute_commit,
            commands::read_workspace_file,
            commands::open_in_vscode,
            watcher::start_watching,
            watcher::stop_watching,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}