#[tokio::main]
async fn main() {
    std::env::set_var("JEAN_HEADLESS", "1");
    if let Err(error) = jean_core::run_server().await {
        eprintln!("Jean server failed: {error}");
        std::process::exit(1);
    }
}
