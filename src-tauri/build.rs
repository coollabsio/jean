fn main() {
    tauri_build::build();

    // Embed Common Controls v6 into test binaries on Windows MSVC.
    //
    // `tauri_build` embeds the app manifest for the main binary via winres, but
    // `cargo test --lib` produces a separate test harness that does not get that
    // resource. Without the manifest, linking Tauri window/test APIs makes the
    // harness fail to start with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139).
    //
    // See: https://github.com/tauri-apps/tauri/pull/4383#issuecomment-1212221864
    //      https://github.com/orgs/tauri-apps/discussions/11179
    embed_windows_manifest_for_tests();
}

fn embed_windows_manifest_for_tests() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        return;
    }

    let manifest =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());

    let Some(manifest) = manifest.to_str() else {
        println!("cargo:warning=Windows app manifest path is not valid UTF-8; skipping test manifest embed");
        return;
    };

    // Apply only to test/bench harnesses so we don't double-embed on the app binary
    // (which already receives the manifest from tauri-build/winres).
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{manifest}");
    println!("cargo:rustc-link-arg-benches=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-benches=/MANIFESTINPUT:{manifest}");
}
