use tauri::Manager;

/// Get the BrainstormServer URL.
/// Phase 1: returns localhost URL for the sidecar server.
#[tauri::command]
fn get_server_url() -> String {
    "http://localhost:3100".to_string()
}

/// Get app version info.
#[tauri::command]
fn get_app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "Brainstorm Desktop",
        "version": env!("CARGO_PKG_VERSION"),
        "phase": 1,
        "description": "Multi-Model Agent OS"
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_server_url, get_app_info])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            // macOS: make title bar transparent for custom drag region
            #[cfg(target_os = "macos")]
            {
                use tauri::TitleBarStyle;
                let _ = window.set_title_bar_style(TitleBarStyle::Overlay);
            }

            println!("Brainstorm Desktop v{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
