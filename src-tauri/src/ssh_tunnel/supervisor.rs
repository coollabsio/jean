//! Supervises `ssh -N` local forwards: health, bounded reconnect, and cleanup.
//!
//! The child is spawned with [`jean_core::silent_command`] so Windows does not
//! open a console window. Tokens are loaded from the secret store only for the
//! loopback health check and are removed from every error string.

use super::args::{
    build_exec_args, build_forward_args, classify_health_failure, classify_ssh_failure,
    decide_after_failure, failure_message, redact, sanitize_detail, AfterFailure, FailureClass,
    ForwardSpec, DEFAULT_REMOTE_HOST, DEFAULT_REMOTE_PORT, DEFAULT_SSH_PORT,
};
use super::hostkey::{
    parse_keyscan, parse_ssh_g, trusted_fingerprint_matches, upsert_trusted_key, ScannedKey,
};
use super::secrets::{identity_file_path, validate_profile_id, SecretStore};
use jean_core::kill_and_reap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPreview {
    pub host: String,
    pub canonical_host: String,
    pub port: u16,
    pub key_type: String,
    pub public_key: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustHostKeyInput {
    pub host: String,
    pub canonical_host: String,
    pub port: u16,
    pub key_type: String,
    pub public_key: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone)]
pub struct TunnelSpec {
    pub profile_id: String,
    pub user: String,
    pub host: String,
    pub ssh_port: u16,
    pub identity_file: Option<PathBuf>,
    pub remote_host: String,
    pub remote_port: u16,
    pub local_port: Option<u16>,
    pub host_key_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatusPayload {
    pub profile_id: String,
    pub status: String,
    pub local_url: Option<String>,
    pub local_port: Option<u16>,
    pub error: Option<String>,
    pub attempt: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedSshSecret {
    pub profile_id: String,
    pub token: String,
}

#[derive(Clone)]
struct Timing {
    port_wait: Duration,
    health_attempts: u32,
    health_interval: Duration,
    /// `None` keeps retrying retryable failures. Tests set a bound.
    max_retryable_attempts: Option<u32>,
    backoff_ms: Arc<dyn Fn(u32) -> u64 + Send + Sync>,
}

impl Timing {
    fn production() -> Self {
        Self {
            port_wait: Duration::from_secs(15),
            health_attempts: 8,
            health_interval: Duration::from_millis(500),
            max_retryable_attempts: None,
            backoff_ms: Arc::new(super::args::backoff_delay_ms),
        }
    }
}

struct Shared {
    dir: PathBuf,
    program: std::ffi::OsString,
    secrets: SecretStore,
    emit: Arc<dyn Fn(TunnelStatusPayload) + Send + Sync>,
    timing: Timing,
}

struct Running {
    generation: u64,
    spec_key: String,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

struct Inner {
    shared: Arc<Shared>,
    tunnels: HashMap<String, Running>,
    statuses: HashMap<String, TunnelStatusPayload>,
    next_generation: u64,
    shutting_down: bool,
}

struct Prepared {
    profile_id: String,
    key: String,
    forward: ForwardSpec,
}

enum OnceOutcome {
    Exited { class: FailureClass, detail: String },
    Stopped,
}

#[derive(Clone)]
pub struct SshTunnelSupervisor {
    inner: Arc<Mutex<Inner>>,
}

impl SshTunnelSupervisor {
    pub fn new(app: AppHandle, dir: PathBuf) -> Self {
        let emit_app = app.clone();
        Self::from_parts(
            dir.clone(),
            std::ffi::OsString::from("ssh"),
            SecretStore::with_os_fallback(dir),
            Arc::new(move |payload| {
                let _ = emit_app.emit("ssh-tunnel:status", &payload);
            }),
            Timing::production(),
        )
    }

    fn from_parts(
        dir: PathBuf,
        program: std::ffi::OsString,
        secrets: SecretStore,
        emit: Arc<dyn Fn(TunnelStatusPayload) + Send + Sync>,
        timing: Timing,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                shared: Arc::new(Shared {
                    dir,
                    program,
                    secrets,
                    emit,
                    timing,
                }),
                tunnels: HashMap::new(),
                statuses: HashMap::new(),
                next_generation: 0,
                shutting_down: false,
            })),
        }
    }

    pub fn known_hosts_path(&self) -> PathBuf {
        self.lock().shared.dir.join("known_hosts")
    }

    pub fn store_secret(&self, profile_id: &str, token: &str) -> Result<(), String> {
        self.lock().shared.secrets.set(profile_id, token)
    }

    pub fn delete_secret(&self, profile_id: &str) -> Result<(), String> {
        self.lock().shared.secrets.delete(profile_id)
    }

    pub fn load_secrets(&self, profile_ids: &[String]) -> Result<Vec<LoadedSshSecret>, String> {
        let secrets = self.lock().shared.secrets.clone();
        let mut loaded = Vec::new();
        for profile_id in profile_ids {
            if let Some(token) = secrets.get(profile_id)? {
                loaded.push(LoadedSshSecret {
                    profile_id: profile_id.clone(),
                    token,
                });
            }
        }
        Ok(loaded)
    }

    pub fn preview(&self, user: &str, host: &str, port: u16) -> Result<HostKeyPreview, String> {
        let (user, host, port) = validate_endpoint(user, host, port)?;
        let (canonical_host, canonical_port) = resolve_endpoint(&user, &host, port);
        let scanned = scan_host_key(&canonical_host, canonical_port)?;
        Ok(HostKeyPreview {
            host,
            canonical_host,
            port: canonical_port,
            key_type: scanned.key_type,
            public_key: scanned.public_key,
            fingerprint: scanned.fingerprint,
        })
    }

    pub fn trust(&self, input: &TrustHostKeyInput) -> Result<(), String> {
        validate_endpoint(&input.host, &input.host, input.port)?;
        crate::remote_install::validate_host(&input.canonical_host)?;
        if !matches!(
            input.key_type.as_str(),
            "ssh-ed25519"
                | "ssh-rsa"
                | "ecdsa-sha2-nistp256"
                | "ecdsa-sha2-nistp384"
                | "ecdsa-sha2-nistp521"
        ) {
            return Err("Unsupported SSH host key type.".to_string());
        }
        let mut hosts = vec![(input.host.as_str(), input.port)];
        if input.canonical_host != input.host {
            hosts.push((input.canonical_host.as_str(), input.port));
        }
        upsert_trusted_key(
            &self.known_hosts_path(),
            &hosts,
            &input.key_type,
            &input.public_key,
            &input.fingerprint,
        )
    }

    pub fn test_auth(
        &self,
        user: &str,
        host: &str,
        port: u16,
        identity_file: Option<&str>,
        fingerprint: &str,
    ) -> Result<String, String> {
        let (user, host, port) = validate_endpoint(user, host, port)?;
        let identity = identity_file_path(identity_file)?;
        self.ensure_pinned(&host, port, fingerprint)?;
        let args = build_exec_args(
            &user,
            &host,
            port,
            identity.as_deref(),
            &self.known_hosts_path(),
            &["echo JEAN_SSH_OK && uname -sm"],
        );
        let program = self.lock().shared.program.clone();
        let output = jean_core::silent_command(&program)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(spawn_error)?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = sanitize_detail(&String::from_utf8_lossy(&output.stderr));
        if !output.status.success() {
            let class = classify_ssh_failure(&stderr);
            return Err(failure_message(class, &stderr));
        }
        stdout
            .lines()
            .map(str::trim)
            .find(|line| *line == "JEAN_SSH_OK")
            .map(|_| {
                stdout
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty() && *line != "JEAN_SSH_OK")
                    .unwrap_or("SSH connection OK")
                    .to_string()
            })
            .ok_or_else(|| "SSH connected, but the test command gave no reply.".to_string())
    }

    pub fn start(&self, spec: TunnelSpec) -> Result<(), String> {
        {
            let guard = self.lock();
            if let Some(running) = guard.tunnels.get(&spec.profile_id) {
                if !running.stop.load(Ordering::SeqCst) && same_forward(&running.spec_key, &spec) {
                    return Ok(());
                }
            }
        }
        let prepared = self.prepare(spec)?;
        let old_join = {
            let mut guard = self.lock();
            if guard.shutting_down {
                return Err("Jean is shutting down.".to_string());
            }
            if let Some(running) = guard.tunnels.get(&prepared.profile_id) {
                if running.spec_key == prepared.key && !running.stop.load(Ordering::SeqCst) {
                    return Ok(());
                }
            }
            guard.next_generation = guard.next_generation.saturating_add(1);
            let generation = guard.next_generation;
            let stop = Arc::new(AtomicBool::new(false));
            let previous = guard.tunnels.insert(
                prepared.profile_id.clone(),
                Running {
                    generation,
                    spec_key: prepared.key.clone(),
                    stop: stop.clone(),
                    join: None,
                },
            );
            let old_join = previous.and_then(|running| {
                running.stop.store(true, Ordering::SeqCst);
                running.join
            });
            let inner = self.inner.clone();
            let stop_thread = stop.clone();
            let profile_id = prepared.profile_id.clone();
            let join = thread::Builder::new()
                .name(format!(
                    "ssh-tunnel-{}",
                    &profile_id[..8.min(profile_id.len())]
                ))
                .spawn(move || supervise(inner, prepared, stop_thread, generation));
            let join = match join {
                Ok(join) => join,
                Err(error) => {
                    guard.tunnels.remove(&profile_id);
                    return Err(format!(
                        "Failed to start the SSH tunnel supervisor: {error}"
                    ));
                }
            };
            if let Some(running) = guard.tunnels.get_mut(&profile_id) {
                if running.generation == generation {
                    running.join = Some(join);
                } else {
                    stop.store(true, Ordering::SeqCst);
                }
            } else {
                stop.store(true, Ordering::SeqCst);
            }
            old_join
        };
        if let Some(join) = old_join {
            let _ = join.join();
        }
        Ok(())
    }

    pub fn start_and_wait_ready(
        &self,
        spec: TunnelSpec,
        timeout: Duration,
    ) -> Result<TunnelStatusPayload, String> {
        let profile_id = spec.profile_id.clone();
        self.start(spec)?;
        let deadline = Instant::now() + timeout;
        loop {
            let status = self.status(&profile_id);
            if let Some(status) = status {
                if status.status == "ready" {
                    return Ok(status);
                }
                if status.status == "failed" || status.status == "stopped" {
                    return Err(status
                        .error
                        .unwrap_or_else(|| "SSH tunnel failed.".to_string()));
                }
            }
            if Instant::now() >= deadline {
                return Err("Timed out waiting for the SSH tunnel.".to_string());
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn stop(&self, profile_id: &str) -> Result<(), String> {
        let join = {
            let mut guard = self.lock();
            let Some(running) = guard.tunnels.remove(profile_id) else {
                return Ok(());
            };
            running.stop.store(true, Ordering::SeqCst);
            running.join
        };
        if let Some(join) = join {
            let _ = join.join();
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        let joins: Vec<JoinHandle<()>> = {
            let mut guard = self.lock();
            guard.shutting_down = true;
            guard
                .tunnels
                .drain()
                .filter_map(|(_, running)| {
                    running.stop.store(true, Ordering::SeqCst);
                    running.join
                })
                .collect()
        };
        for join in joins {
            let _ = join.join();
        }
    }

    pub fn list_status(&self) -> Vec<TunnelStatusPayload> {
        self.lock().statuses.values().cloned().collect()
    }

    fn status(&self, profile_id: &str) -> Option<TunnelStatusPayload> {
        self.lock().statuses.get(profile_id).cloned()
    }

    fn prepare(&self, mut spec: TunnelSpec) -> Result<Prepared, String> {
        validate_profile_id(&spec.profile_id)?;
        let (user, host, port) = validate_endpoint(&spec.user, &spec.host, spec.ssh_port)?;
        spec.user = user;
        spec.host = host;
        spec.ssh_port = port;
        crate::remote_install::validate_host(&spec.remote_host)?;
        crate::remote_install::validate_port(spec.remote_port, "Jean port")?;
        if spec.host_key_fingerprint.trim().is_empty() {
            return Err("Confirm the SSH host key fingerprint first.".to_string());
        }
        self.ensure_pinned(&spec.host, spec.ssh_port, spec.host_key_fingerprint.trim())?;
        let (canonical_host, canonical_port) =
            resolve_endpoint(&spec.user, &spec.host, spec.ssh_port);
        if canonical_host != spec.host || canonical_port != spec.ssh_port {
            let _ = self.ensure_pinned(
                &canonical_host,
                canonical_port,
                spec.host_key_fingerprint.trim(),
            );
        }
        let local_port = choose_local_port(spec.local_port)?;
        let identity = spec.identity_file.clone();
        let key = spec_key(&spec, local_port);
        Ok(Prepared {
            profile_id: spec.profile_id,
            key,
            forward: ForwardSpec {
                user: spec.user,
                host: spec.host,
                ssh_port: spec.ssh_port,
                identity_file: identity,
                remote_host: spec.remote_host,
                remote_port: spec.remote_port,
                local_port,
                known_hosts_file: self.known_hosts_path(),
            },
        })
    }

    fn ensure_pinned(&self, host: &str, port: u16, fingerprint: &str) -> Result<(), String> {
        if trusted_fingerprint_matches(&self.known_hosts_path(), host, port, fingerprint) {
            Ok(())
        } else {
            Err(
                "SSH host key is not trusted yet. Confirm the server fingerprint before connecting."
                    .to_string(),
            )
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|err| err.into_inner())
    }
}

impl Drop for SshTunnelSupervisor {
    fn drop(&mut self) {
        if Arc::strong_count(&self.inner) == 1 {
            self.shutdown();
        }
    }
}

fn supervise(inner: Arc<Mutex<Inner>>, prepared: Prepared, stop: Arc<AtomicBool>, generation: u64) {
    let profile_id = prepared.profile_id.clone();
    let mut attempt = 0u32;
    loop {
        if stop.load(Ordering::SeqCst) {
            publish(&inner, &prepared, generation, "stopped", None, attempt);
            break;
        }
        let label = if attempt == 0 {
            "connecting"
        } else {
            "reconnecting"
        };
        publish(&inner, &prepared, generation, label, None, attempt);
        match run_once(&inner, &prepared, &stop, generation, &mut attempt) {
            OnceOutcome::Stopped => {
                publish(&inner, &prepared, generation, "stopped", None, attempt);
                break;
            }
            OnceOutcome::Exited { class, detail } => {
                let message = failure_message(class, &detail);
                match decide_after_failure(class, attempt.saturating_add(1)) {
                    AfterFailure::Stop => {
                        publish(
                            &inner,
                            &prepared,
                            generation,
                            "failed",
                            Some(message),
                            attempt,
                        );
                        break;
                    }
                    AfterFailure::Retry { .. } => {
                        attempt = attempt.saturating_add(1);
                        let timing = inner
                            .lock()
                            .unwrap_or_else(|err| err.into_inner())
                            .shared
                            .timing
                            .clone();
                        let give_up = timing
                            .max_retryable_attempts
                            .is_some_and(|max| attempt >= max);
                        if give_up {
                            publish(
                                &inner,
                                &prepared,
                                generation,
                                "failed",
                                Some(message),
                                attempt,
                            );
                            break;
                        }
                        publish(
                            &inner,
                            &prepared,
                            generation,
                            "reconnecting",
                            Some(message),
                            attempt,
                        );
                        let delay_ms = (timing.backoff_ms)(attempt);
                        if !sleep_interruptible(Duration::from_millis(delay_ms), &stop) {
                            publish(&inner, &prepared, generation, "stopped", None, attempt);
                            break;
                        }
                    }
                }
            }
        }
    }
    let mut guard = inner.lock().unwrap_or_else(|err| err.into_inner());
    if let Some(running) = guard.tunnels.get(&profile_id) {
        if running.generation == generation {
            guard.tunnels.remove(&profile_id);
        }
    }
}

fn run_once(
    inner: &Arc<Mutex<Inner>>,
    prepared: &Prepared,
    stop: &AtomicBool,
    generation: u64,
    attempt: &mut u32,
) -> OnceOutcome {
    let (program, timing, token) = {
        let guard = inner.lock().unwrap_or_else(|err| err.into_inner());
        let token = match guard.shared.secrets.get(&prepared.profile_id) {
            Ok(Some(token)) => token,
            Ok(None) => {
                return OnceOutcome::Exited {
                    class: FailureClass::Auth,
                    detail: "Access token is not stored for this SSH profile.".into(),
                };
            }
            Err(error) => {
                return OnceOutcome::Exited {
                    class: FailureClass::Auth,
                    detail: error,
                };
            }
        };
        (
            guard.shared.program.clone(),
            guard.shared.timing.clone(),
            token,
        )
    };

    let args = build_forward_args(&prepared.forward);
    let mut child = match spawn_program(&program, &args) {
        Ok(child) => child,
        Err(message) => {
            return OnceOutcome::Exited {
                class: if message.contains("not installed") {
                    FailureClass::MissingBinary
                } else {
                    FailureClass::Retryable
                },
                detail: message,
            };
        }
    };
    let mut stderr = collect_stderr(child.stderr.take());

    if !wait_for_local_port(
        prepared.forward.local_port,
        stop,
        &mut child,
        timing.port_wait,
    ) {
        kill_and_reap(&mut child);
        if stop.load(Ordering::SeqCst) {
            return OnceOutcome::Stopped;
        }
        let detail = stderr.finish();
        let class = classify_ssh_failure(&detail);
        return OnceOutcome::Exited { class, detail };
    }

    let mut last_health = String::new();
    let mut healthy = false;
    for _ in 0..timing.health_attempts {
        if stop.load(Ordering::SeqCst) {
            kill_and_reap(&mut child);
            return OnceOutcome::Stopped;
        }
        match check_health(prepared.forward.local_port, &token) {
            Ok(()) => {
                healthy = true;
                break;
            }
            Err(error) => {
                last_health = error;
                if matches!(classify_health_failure(&last_health), FailureClass::Auth) {
                    kill_and_reap(&mut child);
                    return OnceOutcome::Exited {
                        class: FailureClass::Auth,
                        detail: last_health,
                    };
                }
                if !sleep_interruptible(timing.health_interval, stop) {
                    kill_and_reap(&mut child);
                    return OnceOutcome::Stopped;
                }
            }
        }
    }
    if !healthy {
        kill_and_reap(&mut child);
        let detail = if last_health.is_empty() {
            stderr.finish()
        } else {
            last_health
        };
        return OnceOutcome::Exited {
            class: FailureClass::Retryable,
            detail,
        };
    }

    *attempt = 0;
    publish(inner, prepared, generation, "ready", None, 0);
    loop {
        if stop.load(Ordering::SeqCst) {
            kill_and_reap(&mut child);
            return OnceOutcome::Stopped;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let detail = stderr.finish();
                let class = if status.success() {
                    FailureClass::Retryable
                } else {
                    classify_ssh_failure(&detail)
                };
                return OnceOutcome::Exited { class, detail };
            }
            Ok(None) => thread::sleep(Duration::from_millis(200)),
            Err(error) => {
                kill_and_reap(&mut child);
                return OnceOutcome::Exited {
                    class: FailureClass::Retryable,
                    detail: error.to_string(),
                };
            }
        }
    }
}

fn publish(
    inner: &Arc<Mutex<Inner>>,
    prepared: &Prepared,
    generation: u64,
    status: &str,
    error: Option<String>,
    attempt: u32,
) {
    let payload = TunnelStatusPayload {
        profile_id: prepared.profile_id.clone(),
        status: status.to_string(),
        local_url: Some(format!("http://127.0.0.1:{}", prepared.forward.local_port)),
        local_port: Some(prepared.forward.local_port),
        error,
        attempt,
    };
    log::info!(
        "SSH tunnel {} status={status} attempt={attempt}",
        prepared.profile_id
    );
    let emit = {
        let mut guard = inner.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(running) = guard.tunnels.get(&payload.profile_id) {
            if running.generation != generation {
                return;
            }
        }
        guard
            .statuses
            .insert(payload.profile_id.clone(), payload.clone());
        guard.shared.emit.clone()
    };
    emit(payload);
}

fn check_health(local_port: u16, token: &str) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{local_port}");
    crate::remote_install::check_remote_ready(&url, token).map_err(|error| redact(&error, token))
}

fn spawn_program(program: &std::ffi::OsStr, args: &[String]) -> Result<Child, String> {
    jean_core::silent_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(spawn_error)
}

fn spawn_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        "ssh is not installed on this computer. Install the OpenSSH client and try again."
            .to_string()
    } else {
        format!("Failed to start ssh: {error}")
    }
}

struct StderrCapture {
    buffer: Arc<Mutex<String>>,
    reader: Option<JoinHandle<()>>,
}

impl StderrCapture {
    fn finish(&mut self) -> String {
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        sanitize_detail(&self.buffer.lock().unwrap_or_else(|err| err.into_inner()))
    }
}

fn collect_stderr(stderr: Option<impl Read + Send + 'static>) -> StderrCapture {
    let buffer = Arc::new(Mutex::new(String::new()));
    let Some(stderr) = stderr else {
        return StderrCapture {
            buffer,
            reader: None,
        };
    };
    let writer = buffer.clone();
    let reader = thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let mut guard = writer.lock().unwrap_or_else(|err| err.into_inner());
                    if guard.len() < 8_000 {
                        guard.push_str(&line);
                    }
                }
            }
        }
    });
    StderrCapture {
        buffer,
        reader: Some(reader),
    }
}

fn wait_for_local_port(port: u16, stop: &AtomicBool, child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    while Instant::now() < deadline {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        match child.try_wait() {
            Ok(Some(_)) => return false,
            Ok(None) => {}
            Err(_) => return false,
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let slice = remaining.min(Duration::from_millis(200));
        if std::net::TcpStream::connect_timeout(&address, slice).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(50).min(remaining));
    }
    false
}

fn sleep_interruptible(duration: Duration, stop: &AtomicBool) -> bool {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        thread::sleep(
            Duration::from_millis(20).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
    !stop.load(Ordering::SeqCst)
}

fn choose_local_port(preferred: Option<u16>) -> Result<u16, String> {
    if let Some(port) = preferred {
        if port > 0 && TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Could not allocate a local tunnel port: {error}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|error| format!("Could not allocate a local tunnel port: {error}"))
}

/// A running tunnel already owns its local port, so binding that port to
/// "check availability" would fail and look like a different tunnel.
fn same_forward(running_key: &str, spec: &TunnelSpec) -> bool {
    let running_parts: Vec<&str> = running_key.split('|').collect();
    let wanted = spec_key(spec, spec.local_port.unwrap_or(0));
    let wanted_parts: Vec<&str> = wanted.split('|').collect();
    if running_parts.len() != wanted_parts.len() || running_parts.len() < 2 {
        return false;
    }
    let port_index = running_parts.len() - 2;
    for (index, (left, right)) in running_parts.iter().zip(&wanted_parts).enumerate() {
        if index == port_index {
            if spec.local_port.is_some() && left != right {
                return false;
            }
            continue;
        }
        if left != right {
            return false;
        }
    }
    true
}

fn spec_key(spec: &TunnelSpec, local_port: u16) -> String {
    let identity = spec
        .identity_file
        .as_ref()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    format!(
        "{}|{}|{}|{identity}|{}|{}|{local_port}|{}",
        spec.user,
        spec.host,
        spec.ssh_port,
        spec.remote_host,
        spec.remote_port,
        spec.host_key_fingerprint.trim()
    )
}

fn validate_endpoint(user: &str, host: &str, port: u16) -> Result<(String, String, u16), String> {
    let user = user.trim().to_string();
    let host = host.trim().to_string();
    crate::remote_install::validate_ssh_user(&user)?;
    crate::remote_install::validate_host(&host)?;
    let port = if port == 0 { DEFAULT_SSH_PORT } else { port };
    crate::remote_install::validate_port(port, "SSH port")?;
    Ok((user, host, port))
}

fn resolve_endpoint(user: &str, host: &str, port: u16) -> (String, u16) {
    let target = format!("{user}@{host}");
    let port_string = port.to_string();
    let Ok(output) = jean_core::silent_command("ssh")
        .args(["-G", "-p", &port_string, &target])
        .output()
    else {
        return (host.to_string(), port);
    };
    if !output.status.success() {
        return (host.to_string(), port);
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let (resolved_host, resolved_port) = parse_ssh_g(&text);
    let host = resolved_host
        .filter(|value| crate::remote_install::validate_host(value).is_ok())
        .unwrap_or(host.to_string());
    (host, resolved_port.unwrap_or(port))
}

fn scan_host_key(host: &str, port: u16) -> Result<ScannedKey, String> {
    let port_string = port.to_string();
    let output = jean_core::silent_command("ssh-keyscan")
        .args([
            "-T",
            "5",
            "-p",
            &port_string,
            "-t",
            "ed25519,ecdsa-sha2-nistp256,rsa",
            "--",
            host,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(spawn_error)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Some(parsed) = parse_keyscan(&stdout) {
        return Ok(parsed);
    }
    let stderr = sanitize_detail(&String::from_utf8_lossy(&output.stderr));
    if stderr.is_empty() {
        Err(format!("Could not read an SSH host key for {host}:{port}."))
    } else {
        Err(format!(
            "Could not read an SSH host key for {host}:{port}. {stderr}"
        ))
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSshTunnelInput {
    pub profile_id: String,
    pub user: String,
    pub host: String,
    pub ssh_port: Option<u16>,
    pub identity_file: Option<String>,
    pub remote_host: Option<String>,
    pub remote_port: Option<u16>,
    pub local_port: Option<u16>,
    pub host_key_fingerprint: String,
}

pub fn normalize_spec(input: &StartSshTunnelInput) -> Result<TunnelSpec, String> {
    let identity = identity_file_path(input.identity_file.as_deref())?;
    let remote_host = input
        .remote_host
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_REMOTE_HOST)
        .to_string();
    let remote_port = input.remote_port.unwrap_or(DEFAULT_REMOTE_PORT);
    Ok(TunnelSpec {
        profile_id: input.profile_id.clone(),
        user: input.user.clone(),
        host: input.host.clone(),
        ssh_port: input.ssh_port.unwrap_or(DEFAULT_SSH_PORT),
        identity_file: identity,
        remote_host,
        remote_port,
        local_port: input.local_port,
        host_key_fingerprint: input.host_key_fingerprint.clone(),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    const SAMPLE_KEY: &str = "amVhbi1zc2gtdHVubmVsLXRlc3Qta2V5LW1hdGVyaWFsLTAx";
    const FINGERPRINT: &str = "SHA256:VXOwYc8SlaNTtvwWXHbY2czg60R6TkMijEdRlhI8wtM";
    const PROFILE: &str = "11111111-2222-4333-8444-555555555555";

    struct Harness {
        supervisor: SshTunnelSupervisor,
        events: Arc<Mutex<Vec<String>>>,
        _dir: tempfile::TempDir,
    }

    fn write_script(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("fake-ssh");
        std::fs::write(&path, body).unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).unwrap();
        path
    }

    fn harness(body: &str) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let script = write_script(dir.path(), body);
        let state = dir.path().join("state");
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = events.clone();
        let supervisor = SshTunnelSupervisor::from_parts(
            state,
            script.into(),
            SecretStore::file_only(dir.path().join("secrets")),
            Arc::new(move |payload| {
                recorded
                    .lock()
                    .unwrap_or_else(|err| err.into_inner())
                    .push(payload.status);
            }),
            Timing {
                port_wait: Duration::from_millis(80),
                health_attempts: 1,
                health_interval: Duration::from_millis(1),
                max_retryable_attempts: Some(3),
                backoff_ms: Arc::new(|_| 0),
            },
        );
        supervisor
            .trust(&TrustHostKeyInput {
                host: "build.example".into(),
                canonical_host: "build.example".into(),
                port: 22,
                key_type: "ssh-ed25519".into(),
                public_key: SAMPLE_KEY.into(),
                fingerprint: FINGERPRINT.into(),
            })
            .unwrap();
        supervisor
            .store_secret(PROFILE, "token-value-1234")
            .unwrap();
        Harness {
            supervisor,
            events,
            _dir: dir,
        }
    }

    fn spec(local_port: Option<u16>) -> TunnelSpec {
        TunnelSpec {
            profile_id: PROFILE.into(),
            user: "ubuntu".into(),
            host: "build.example".into(),
            ssh_port: 22,
            identity_file: None,
            remote_host: "127.0.0.1".into(),
            remote_port: 3456,
            local_port,
            host_key_fingerprint: FINGERPRINT.into(),
        }
    }

    fn wait_for(events: &Mutex<Vec<String>>, pred: impl Fn(&[String]) -> bool) -> Vec<String> {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let current = events.lock().unwrap_or_else(|err| err.into_inner()).clone();
            if pred(&current) || Instant::now() >= deadline {
                return current;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn dropped_tunnel_reconnects_with_bounded_backoff_then_stops() {
        let harness = harness("#!/bin/sh\necho 'Connection refused' >&2\nexit 255\n");
        harness.supervisor.start(spec(None)).unwrap();
        let events = wait_for(&harness.events, |events| {
            events
                .iter()
                .filter(|status| *status == "reconnecting")
                .count()
                >= 1
                && events.iter().any(|status| status == "failed")
        });
        assert!(
            events.contains(&"reconnecting".to_string()),
            "events={events:?}"
        );
        assert!(events.contains(&"failed".to_string()), "events={events:?}");
        let status = harness.supervisor.status(PROFILE).unwrap();
        assert_eq!(status.status, "failed");
        assert!(status.error.unwrap_or_default().contains("Reconnecting") || status.attempt >= 1);
    }

    #[test]
    fn changed_host_key_stops_without_retry_loop() {
        let harness = harness("#!/bin/sh\necho 'Host key verification failed.' >&2\nexit 255\n");
        harness.supervisor.start(spec(None)).unwrap();
        let events = wait_for(&harness.events, |events| {
            events.iter().any(|status| status == "failed")
        });
        assert!(!events.iter().any(|status| status == "reconnecting"));
        let error = harness.supervisor.status(PROFILE).unwrap().error.unwrap();
        assert!(error.contains("host key"));
    }

    #[test]
    fn stop_reaps_a_running_tunnel() {
        let harness = harness("#!/bin/sh\nsleep 30\n");
        harness.supervisor.start(spec(None)).unwrap();
        let started = Instant::now();
        harness.supervisor.stop(PROFILE).unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
        let status = harness.supervisor.status(PROFILE);
        assert_ne!(
            status.as_ref().map(|item| item.status.as_str()),
            Some("ready")
        );
    }

    #[test]
    fn restart_reuses_the_same_spec_without_a_second_supervisor() {
        let harness = harness("#!/bin/sh\nsleep 30\n");
        harness.supervisor.start(spec(None)).unwrap();
        let port = wait_for(&harness.events, |events| !events.is_empty());
        assert!(!port.is_empty());
        let local_port = harness.supervisor.status(PROFILE).unwrap().local_port;
        harness.supervisor.start(spec(local_port)).unwrap();
        harness.supervisor.start(spec(None)).unwrap();
        assert_eq!(harness.supervisor.lock().tunnels.len(), 1);
        harness.supervisor.shutdown();
    }

    #[test]
    fn unavailable_preferred_port_allocates_another() {
        let harness = harness("#!/bin/sh\necho 'Connection refused' >&2\nexit 255\n");
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let occupied = listener.local_addr().unwrap().port();
        harness.supervisor.start(spec(Some(occupied))).unwrap();
        let events = wait_for(&harness.events, |events| !events.is_empty());
        assert!(!events.is_empty());
        let status = harness.supervisor.status(PROFILE).unwrap();
        assert_ne!(status.local_port, Some(occupied));
        drop(listener);
    }

    #[test]
    fn untrusted_host_key_refuses_to_start() {
        let harness = harness("#!/bin/sh\nsleep 30\n");
        let mut spec = spec(None);
        spec.host_key_fingerprint = "SHA256:missing".into();
        let error = harness.supervisor.start(spec).unwrap_err();
        assert!(error.contains("not trusted"));
        assert!(harness.events.lock().unwrap().is_empty());
    }
}
