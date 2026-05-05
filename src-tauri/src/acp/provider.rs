//! ACP provider definitions and provider-specific wiring.
//!
//! All provider-specific knowledge lives here:
//! - provider identity / wire ids
//! - display names
//! - subprocess launch argv

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcpProvider {
    Claude,
    Codex,
}

impl AcpProvider {
    pub const ALL: &'static [AcpProvider] = &[AcpProvider::Claude, AcpProvider::Codex];

    pub fn as_str(self) -> &'static str {
        match self {
            AcpProvider::Claude => "claude-acp",
            AcpProvider::Codex => "codex-acp",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            AcpProvider::Claude => "Claude Agent",
            AcpProvider::Codex => "Codex CLI",
        }
    }

    pub fn from_wire(s: String) -> Result<Self, String> {
        s.parse()
    }

    pub fn adapter_argv(self) -> &'static [&'static str] {
        match self {
            AcpProvider::Claude => &[
                "npx",
                "--registry",
                "https://registry.npmjs.org",
                "--yes",
                "@agentclientprotocol/claude-agent-acp@0.31.0",
            ],
            AcpProvider::Codex => &[
                "npx",
                "--registry",
                "https://registry.npmjs.org",
                "--yes",
                "@zed-industries/codex-acp@0.12.0",
            ],
        }
    }
}

impl fmt::Display for AcpProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for AcpProvider {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        AcpProvider::ALL
            .iter()
            .copied()
            .find(|p| p.as_str() == s)
            .ok_or_else(|| format!("unknown ACP provider: {s}"))
    }
}
