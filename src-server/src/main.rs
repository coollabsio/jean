fn main() {
    // Product version for self-update / --version must be jean-server's, not jean-core's.
    jean_core::set_app_version(env!("CARGO_PKG_VERSION"));
    std::env::set_var("JEAN_HEADLESS", "1");
    let runtime = jean_core::build_tokio_runtime().expect("failed to create Jean server runtime");
    if let Err(error) = runtime.block_on(jean_core::run_server()) {
        eprintln!("Jean server failed: {error}");
        std::process::exit(1);
    }
}
