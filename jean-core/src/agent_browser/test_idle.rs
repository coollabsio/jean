#[cfg(test)]
mod test_idle_shutdown {
    use super::*;
    #[test]
    fn test_heartbeat_constants_defined() {
        assert_eq!(HEARTBEAT_FILE, "agent-browser-heartbeat");
        assert_eq!(IDLE_TIMEOUT_MS, "900000");
    }
}