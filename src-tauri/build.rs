use std::path::PathBuf;
use std::process::Command;

fn main() {
    let manifest_dir = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR"),
    );
    let repo_root = manifest_dir
        .parent()
        .expect("src-tauri should live under the repo root");
    let script_path = repo_root.join("scripts/prune-tauri-dist.mjs");
    let dist_path = repo_root.join("dist");

    let status = Command::new("node")
        .arg(&script_path)
        .arg(&dist_path)
        .status()
        .expect("failed to run scripts/prune-tauri-dist.mjs");

    assert!(
        status.success(),
        "scripts/prune-tauri-dist.mjs exited with status {status}",
    );

    tauri_build::build()
}
