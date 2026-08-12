fn main() {
    // Tauri embeds frontend files at Rust compile time. Vite regenerates dist/
    // immediately before `tauri build`, so Cargo must invalidate the native
    // shell whenever the desktop entrypoint or emitted assets change. Without
    // these watches an incremental Windows build can retain a prior web-only
    // `dashboard.html` asset map and launch with "asset not found: index.html".
    println!("cargo:rerun-if-changed=../dist/index.html");
    println!("cargo:rerun-if-changed=../dist/settings.html");
    println!("cargo:rerun-if-changed=../dist/live-channels.html");
    println!("cargo:rerun-if-changed=../dist/mcp-grant.html");
    println!("cargo:rerun-if-changed=../dist/assets");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
