fn main() {
    // Cargo reruns a build script only for the paths the script names, and
    // tauri_build names tauri.conf.json and capabilities/ — not the icon. So a
    // new icon.ico left the script untouched, the previously generated Windows
    // resource was linked back in, and the freshly built exe silently kept the
    // old icon. Watching the file is the whole fix.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
