use std::sync::Mutex;
use tauri::Manager;

/// Sidecar state — tracks the BrainstormServer child process.
struct SidecarState {
    child: Option<std::process::Child>,
}

/// Get the BrainstormServer URL.
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
        "description": "Multi-Model Agent OS"
    })
}

/// Start the BrainstormServer sidecar process.
#[tauri::command]
fn start_server(state: tauri::State<'_, Mutex<SidecarState>>) -> Result<String, String> {
    let mut sidecar = state.lock().map_err(|e| e.to_string())?;

    if sidecar.child.is_some() {
        return Ok("Server already running".to_string());
    }

    // Try to find the brainstorm CLI in common locations
    // Try brainstorm serve first
    let result = std::process::Command::new("brainstorm")
        .args(["serve", "--port", "3100", "--cors"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    match result {
        Ok(child) => {
            println!("BrainstormServer sidecar started (PID: {})", child.id());
            sidecar.child = Some(child);
            Ok("Server started on port 3100".to_string())
        }
        Err(e) => {
            // Fallback: try npx
            let npx_result = std::process::Command::new("npx")
                .args(["brainstorm", "serve", "--port", "3100", "--cors"])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn();

            match npx_result {
                Ok(child) => {
                    println!("BrainstormServer sidecar started via npx (PID: {})", child.id());
                    sidecar.child = Some(child);
                    Ok("Server started on port 3100 (via npx)".to_string())
                }
                Err(_) => {
                    Err(format!(
                        "Could not start BrainstormServer: {}. Install brainstorm CLI: npm install -g @brainst0rm/cli",
                        e
                    ))
                }
            }
        }
    }
}

/// Stop the BrainstormServer sidecar process.
#[tauri::command]
fn stop_server(state: tauri::State<'_, Mutex<SidecarState>>) -> Result<String, String> {
    let mut sidecar = state.lock().map_err(|e| e.to_string())?;

    if let Some(mut child) = sidecar.child.take() {
        let _ = child.kill();
        let _ = child.wait();
        println!("BrainstormServer sidecar stopped");
        Ok("Server stopped".to_string())
    } else {
        Ok("No server running".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Mutex::new(SidecarState { child: None }))
        .invoke_handler(tauri::generate_handler![
            get_server_url,
            get_app_info,
            start_server,
            stop_server
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            // macOS: make title bar transparent for custom drag region
            #[cfg(target_os = "macos")]
            {
                use tauri::TitleBarStyle;
                let _ = window.set_title_bar_style(TitleBarStyle::Overlay);
            }

            println!("Brainstorm Desktop v{}", env!("CARGO_PKG_VERSION"));

            // Auto-start the server sidecar
            let state = app.state::<Mutex<SidecarState>>();
            let mut sidecar = state.lock().unwrap();

            // Try to start brainstorm serve
            if let Ok(child) = std::process::Command::new("brainstorm")
                .args(["serve", "--port", "3100", "--cors"])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
            {
                println!("Auto-started BrainstormServer sidecar (PID: {})", child.id());
                sidecar.child = Some(child);
            } else {
                println!("BrainstormServer not found — install with: npm install -g @brainst0rm/cli");
                println!("The app will work in disconnected mode. Start the server manually.");
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Clean up sidecar on window close
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<Mutex<SidecarState>>();
                let mut sidecar = state.lock().unwrap();
                if let Some(mut child) = sidecar.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                    println!("Sidecar cleaned up on window close");
                }
                drop(sidecar);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
