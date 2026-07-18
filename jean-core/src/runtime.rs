use serde::Serialize;
use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::marker::PhantomData;
use std::ops::Deref;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

type ListenerFn = Arc<dyn Fn(Event) + Send + Sync>;
type EventSink = Arc<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>;

#[derive(Clone)]
pub struct RuntimeContext {
    inner: Arc<RuntimeInner>,
}

struct RuntimeInner {
    app_data_dir: PathBuf,
    resource_dir: PathBuf,
    state: RwLock<HashMap<TypeId, Arc<dyn Any + Send + Sync>>>,
    listeners: Mutex<HashMap<String, HashMap<u64, ListenerFn>>>,
    event_sink: RwLock<Option<EventSink>>,
    next_listener_id: AtomicU64,
}

impl RuntimeContext {
    pub fn new(app_data_dir: PathBuf, resource_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&app_data_dir)
            .map_err(|error| format!("Failed to create app data directory: {error}"))?;
        Ok(Self {
            inner: Arc::new(RuntimeInner {
                app_data_dir,
                resource_dir,
                state: RwLock::new(HashMap::new()),
                listeners: Mutex::new(HashMap::new()),
                event_sink: RwLock::new(None),
                next_listener_id: AtomicU64::new(1),
            }),
        })
    }

    pub fn from_environment() -> Result<Self, String> {
        let app_data_dir = std::env::var_os("JEAN_DATA_DIR")
            .map(PathBuf::from)
            .or_else(|| dirs::data_dir().map(|path| path.join("com.jean.desktop")))
            .ok_or_else(|| "Unable to resolve Jean data directory".to_string())?;
        let resource_dir = std::env::var_os("JEAN_RESOURCE_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::current_exe()
                    .ok()
                    .and_then(|path| path.parent().map(PathBuf::from))
            })
            .unwrap_or_else(|| PathBuf::from("."));
        Self::new(app_data_dir, resource_dir)
    }

    pub fn manage<T: Send + Sync + 'static>(&self, value: T) -> bool {
        self.inner
            .state
            .write()
            .expect("runtime state lock")
            .insert(TypeId::of::<T>(), Arc::new(value))
            .is_none()
    }

    pub fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<'_, T>> {
        let value = self
            .inner
            .state
            .read()
            .expect("runtime state lock")
            .get(&TypeId::of::<T>())?
            .clone();
        let value = Arc::downcast::<T>(value).ok()?;
        Some(State(value, PhantomData))
    }

    pub fn state<T: Send + Sync + 'static>(&self) -> State<'_, T> {
        self.try_state::<T>()
            .unwrap_or_else(|| panic!("managed state missing: {}", std::any::type_name::<T>()))
    }

    pub fn path(&self) -> PathResolver {
        PathResolver(self.clone())
    }

    pub fn asset_protocol_scope(&self) -> AssetProtocolScope {
        AssetProtocolScope
    }

    pub fn listen<F>(&self, event: &str, handler: F) -> u64
    where
        F: Fn(Event) + Send + Sync + 'static,
    {
        let id = self.inner.next_listener_id.fetch_add(1, Ordering::Relaxed);
        self.inner
            .listeners
            .lock()
            .expect("listener lock")
            .entry(event.to_string())
            .or_default()
            .insert(id, Arc::new(handler));
        id
    }

    pub fn unlisten(&self, id: u64) {
        let mut listeners = self.inner.listeners.lock().expect("listener lock");
        for handlers in listeners.values_mut() {
            handlers.remove(&id);
        }
    }

    pub fn set_event_sink<F>(&self, sink: F)
    where
        F: Fn(&str, &str) -> Result<(), String> + Send + Sync + 'static,
    {
        *self.inner.event_sink.write().expect("event sink lock") = Some(Arc::new(sink));
    }

    pub fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<(), String> {
        let payload = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
        if let Some(sink) = self
            .inner
            .event_sink
            .read()
            .expect("event sink lock")
            .clone()
        {
            sink(event, &payload)?;
        }
        let handlers = self
            .inner
            .listeners
            .lock()
            .expect("listener lock")
            .get(event)
            .map(|handlers| handlers.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for handler in handlers {
            handler(Event(payload.clone()));
        }
        Ok(())
    }
}

pub type AppHandle = RuntimeContext;

pub struct State<'a, T>(Arc<T>, PhantomData<&'a T>);

impl<T> Clone for State<'_, T> {
    fn clone(&self) -> Self {
        Self(self.0.clone(), PhantomData)
    }
}

impl<T> Deref for State<'_, T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

pub struct PathResolver(RuntimeContext);

impl PathResolver {
    pub fn app_data_dir(&self) -> Result<PathBuf, String> {
        Ok(self.0.inner.app_data_dir.clone())
    }

    pub fn app_log_dir(&self) -> Result<PathBuf, String> {
        Ok(self.0.inner.app_data_dir.join("logs"))
    }

    pub fn resource_dir(&self) -> Result<PathBuf, String> {
        Ok(self.0.inner.resource_dir.clone())
    }
}

pub struct AssetProtocolScope;

impl AssetProtocolScope {
    pub fn allow_directory<P: AsRef<std::path::Path>>(
        &self,
        _path: P,
        _recursive: bool,
    ) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Clone)]
pub struct Event(String);

impl Event {
    pub fn payload(&self) -> &str {
        &self.0
    }
}

pub trait Manager {}
impl Manager for RuntimeContext {}

pub trait Emitter {}
impl Emitter for RuntimeContext {}

pub trait Listener {}
impl Listener for RuntimeContext {}

pub mod async_runtime {
    use std::future::Future;
    use std::sync::{Mutex, OnceLock};

    static HANDLE: OnceLock<Mutex<Option<tokio::runtime::Handle>>> = OnceLock::new();

    fn handle() -> tokio::runtime::Handle {
        HANDLE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .expect("async runtime handle lock")
            .clone()
            .or_else(|| tokio::runtime::Handle::try_current().ok())
            .expect("Jean async runtime is not initialized")
    }

    pub fn spawn<F>(future: F) -> tokio::task::JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        handle().spawn(future)
    }

    pub fn spawn_blocking<F, R>(function: F) -> tokio::task::JoinHandle<R>
    where
        F: FnOnce() -> R + Send + 'static,
        R: Send + 'static,
    {
        handle().spawn_blocking(function)
    }

    pub fn block_on<F: Future>(future: F) -> F::Output {
        handle().block_on(future)
    }

    pub fn set(handle: tokio::runtime::Handle) {
        *HANDLE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .expect("async runtime handle lock") = Some(handle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_state_is_shared_across_clones() {
        let temp = tempfile::tempdir().unwrap();
        let context = RuntimeContext::new(temp.path().into(), temp.path().into()).unwrap();
        context.manage(String::from("shared"));

        assert_eq!(&*context.clone().state::<String>(), "shared");
    }

    #[test]
    fn events_are_delivered_without_tauri() {
        let temp = tempfile::tempdir().unwrap();
        let context = RuntimeContext::new(temp.path().into(), temp.path().into()).unwrap();
        let received = Arc::new(Mutex::new(String::new()));
        let output = received.clone();
        context.listen("test", move |event| {
            *output.lock().unwrap() = event.payload().to_string();
        });

        context
            .emit("test", serde_json::json!({ "ok": true }))
            .unwrap();

        assert_eq!(&*received.lock().unwrap(), r#"{"ok":true}"#);
    }

    #[test]
    fn event_sink_forwards_events_to_an_adapter() {
        let temp = tempfile::tempdir().unwrap();
        let context = RuntimeContext::new(temp.path().into(), temp.path().into()).unwrap();
        let received = Arc::new(Mutex::new(None));
        let output = received.clone();
        context.set_event_sink(move |event, payload| {
            *output.lock().unwrap() = Some((event.to_string(), payload.to_string()));
            Ok(())
        });

        context
            .emit("chat:done", serde_json::json!({ "id": 7 }))
            .unwrap();

        assert_eq!(
            *received.lock().unwrap(),
            Some(("chat:done".to_string(), r#"{"id":7}"#.to_string()))
        );
    }

    #[tokio::test]
    async fn async_runtime_can_spawn_from_background_threads() {
        async_runtime::set(tokio::runtime::Handle::current());

        let task = std::thread::spawn(|| async_runtime::spawn(async { 7 }))
            .join()
            .expect("background thread should access the runtime");

        assert_eq!(task.await.unwrap(), 7);
    }
}
