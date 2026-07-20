#[tokio::main]
async fn main() {
    // Product version for self-update / --version must be jean-server's, not jean-core's.
    jean_core::set_app_version(env!("CARGO_PKG_VERSION"));
    std::env::set_var("JEAN_HEADLESS", "1");
    if let Err(error) = jean_core::run_server().await {
        eprintln!("Jean server failed: {error}");
        std::process::exit(1);
    }
}
