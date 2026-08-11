mod client;
mod commands;
mod config;
mod gateway;
mod job_index;
mod types;

pub use job_index::{HermesJobLink, HermesJobOutput};

pub use client::HermesClient;
pub use commands::*;
pub use config::{
    connection_config_from_prefs, selected_model_from_prefs, DEFAULT_API_BASE_URL, DEFAULT_MODEL,
};
pub use gateway::{ensure_gateway_always_on, ensure_gateway_running};
pub use types::*;
