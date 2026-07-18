// Cross-platform abstractions for shell execution and process management

pub mod cli_detect;
pub mod process;
pub mod shell;
pub mod wsl;

pub use cli_detect::*;
pub use process::*;
pub use shell::*;
pub use wsl::*;
