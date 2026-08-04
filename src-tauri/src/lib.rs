/// Listing installed fonts from Rust rather than the web `queryLocalFonts()`,
/// whose permission prompt is unreliable inside Tauri's custom protocol origin.
/// Rendering still happens in the webview via plain `font-family`.
#[tauri::command]
fn system_fonts() -> Vec<String> {
    let mut families = font_kit::source::SystemSource::new()
        .all_families()
        .unwrap_or_default();
    families.sort_by_key(|f| f.to_lowercase());
    families
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![system_fonts])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
