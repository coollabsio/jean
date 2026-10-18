/// Run a test in its own process when it uses process-global state (CLI routing,
/// active chat registries). Other tests may replace or clear that state.
/// Returns true only in the child; the parent checks its result and returns.
pub(crate) fn in_isolated_process(test_name: &str) -> bool {
    const CHILD_TEST: &str = "JEAN_ISOLATED_TEST";
    if std::env::var(CHILD_TEST).as_deref() == Ok(test_name) {
        return true;
    }

    let output = crate::platform::silent_command(std::env::current_exe().unwrap())
        .args(["--exact", test_name, "--nocapture"])
        .env(CHILD_TEST, test_name)
        .output()
        .expect("start isolated test process");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success() && stdout.contains("1 passed; 0 failed"),
        "Isolated test {test_name} failed or did not run: {}\n{stdout}\n{stderr}",
        output.status,
    );
    false
}
