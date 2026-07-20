//! Product version for the running host binary.
//!
//! `env!("CARGO_PKG_VERSION")` inside jean-core always reflects the **library**
//! crate version, not jean-server / desktop Jean. Server self-update compared
//! that library version against `server-latest.json` and got stuck offering
//! "0.1.68" forever while the binary still reported "0.1.67".
//!
//! Host binaries must call [`set_app_version`] once at startup with their own
//! `env!("CARGO_PKG_VERSION")`.

use std::sync::OnceLock;

static APP_VERSION: OnceLock<&'static str> = OnceLock::new();

/// Record the host binary's product version. Safe to call more than once; the
/// first value wins.
pub fn set_app_version(version: &'static str) {
    let _ = APP_VERSION.set(version);
}

/// Product version of the running binary (host override or jean-core fallback).
pub fn app_version() -> &'static str {
    APP_VERSION
        .get()
        .copied()
        .unwrap_or(env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_to_cargo_pkg_version_when_unset() {
        // Other tests in this process may have set the override; only assert
        // the fallback path when still empty.
        if APP_VERSION.get().is_none() {
            assert_eq!(app_version(), env!("CARGO_PKG_VERSION"));
        }
    }
}
