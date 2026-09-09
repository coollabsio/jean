use rand::Rng;

/// Generate a cryptographically random token (32 bytes, base64url-encoded).
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill(&mut bytes);
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
}

/// Validate a token against the expected value (constant-time comparison).
pub fn validate_token(provided: &str, expected: &str) -> bool {
    let provided_bytes = provided.as_bytes();
    let expected_bytes = expected.as_bytes();
    let mut diff = (provided_bytes.len() ^ expected_bytes.len()) as u8;
    let max_len = provided_bytes.len().max(expected_bytes.len());
    for i in 0..max_len {
        let a = provided_bytes.get(i).copied().unwrap_or(0);
        let b = expected_bytes.get(i).copied().unwrap_or(0);
        diff |= a ^ b;
    }
    diff == 0
}
