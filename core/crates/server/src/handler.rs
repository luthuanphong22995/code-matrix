//! The stdio request loop: `initialize` / `shutdown` lifecycle, `graph/*`, `flow/*` and
//! `index/*` routing.

use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, PoisonError};
use std::thread::JoinHandle;

use rpc::framing::read_message;
use rpc::message::{Message, Notification, Request, Response};
use rpc::protocol::{
    IndexCancelParams, IndexCancelResult, IndexFilesChangedParams, IndexRunParams, IndexRunResult,
    InitializeParams, InitializeResult, LogLevel, LogParams, FLOW_RETRACE, FLOW_TRACE,
    GRAPH_EXPAND, GRAPH_FILES, GRAPH_NEIGHBOURHOOD, GRAPH_NODE, INDEX_CANCEL, INDEX_FILES_CHANGED,
    INDEX_RUN, INITIALIZE, INVALID_PARAMS, INVALID_REQUEST, INVALID_ROOTS, LOG, METHOD_NOT_FOUND,
    NOT_INITIALIZED, PARSE_ERROR, SHUTDOWN,
};
use serde_json::Value;

use crate::flow;
use crate::graph::{self, Live, Out};

#[derive(Default)]
enum State {
    #[default]
    Uninitialized,
    Initialized,
}

/// The latest `index/run`; its thread may already have finished.
struct CurrentRun {
    id: u64,
    cancel: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

#[derive(Default)]
pub struct Server {
    state: State,
    live: Arc<Live>,
    next_run_id: u64,
    run: Option<CurrentRun>,
}

impl Server {
    /// Serves until `shutdown` (returns 0) or EOF / a framing error (returns 1).
    pub fn run(&mut self, reader: &mut impl BufRead, writer: impl Write + Send + 'static) -> i32 {
        match self.serve(reader, &graph::out(writer)) {
            Ok(true) => 0,
            Ok(false) => {
                eprintln!("code-matrix-server: stdin closed without shutdown");
                1
            }
            Err(e) => {
                eprintln!("code-matrix-server: {e}");
                1
            }
        }
    }

    /// `Ok(true)` once `shutdown` has been answered, `Ok(false)` on EOF.
    fn serve(&mut self, reader: &mut impl BufRead, out: &Out) -> io::Result<bool> {
        while let Some(body) = read_message(reader)? {
            match serde_json::from_slice::<Message>(&body) {
                Ok(Message::Request(req)) => {
                    if self.handle_request(req, out)? {
                        return Ok(true);
                    }
                }
                Ok(Message::Notification(note)) => {
                    if matches!(self.state, State::Initialized)
                        && note.method == INDEX_FILES_CHANGED
                    {
                        self.files_changed(note.params, out);
                    }
                }
                Err(e) => {
                    // Well-formed JSON that is not a request/notification is -32600.
                    let code = if e.is_data() {
                        INVALID_REQUEST
                    } else {
                        PARSE_ERROR
                    };
                    respond(out, Response::err(Value::Null, code, e.to_string(), None))?;
                }
            }
        }
        Ok(false)
    }

    /// Answers one request; `Ok(true)` means `shutdown` was answered.
    fn handle_request(&mut self, req: Request, out: &Out) -> io::Result<bool> {
        let Request {
            id, method, params, ..
        } = req;
        let response = match (&self.state, method.as_str()) {
            (State::Uninitialized, INITIALIZE) => return self.initialize(id, params, out),
            (State::Uninitialized, _) => Response::err(id, NOT_INITIALIZED, "NotInitialized", None),
            (State::Initialized, INITIALIZE) => {
                Response::err(id, INVALID_REQUEST, "already initialized", None)
            }
            (State::Initialized, SHUTDOWN) => {
                // Closing under the same lock drops any later run notification.
                let body = serde_json::to_vec(&Response::ok(id, Value::Null))?;
                graph::send(out, &body, true)?;
                return Ok(true);
            }
            (State::Initialized, GRAPH_FILES | GRAPH_EXPAND | GRAPH_NODE | GRAPH_NEIGHBOURHOOD) => {
                let snapshot = self.live.store.snapshot();
                match graph::handle(&method, params, snapshot.as_deref().map(|s| &s.graph)) {
                    Ok(result) => Response::ok(id, result),
                    Err((code, message)) => Response::err(id, code, message, None),
                }
            }
            (State::Initialized, FLOW_TRACE | FLOW_RETRACE) => {
                match flow::handle(&method, params, self.live.store.snapshot().as_deref()) {
                    Ok(result) => Response::ok(id, result),
                    Err((code, message)) => Response::err(id, code, message, None),
                }
            }
            (State::Initialized, INDEX_RUN) => return self.index_run(id, params, out),
            (State::Initialized, INDEX_CANCEL) => self.index_cancel(id, params),
            (State::Initialized, method) => Response::err(
                id,
                METHOD_NOT_FOUND,
                format!("unknown method: {method}"),
                None,
            ),
        };
        respond(out, response)?;
        Ok(false)
    }

    fn initialize(&mut self, id: Value, params: Value, out: &Out) -> io::Result<bool> {
        let roots: Vec<PathBuf> = match serde_json::from_value::<InitializeParams>(params) {
            Ok(params) => params.roots,
            Err(e) => {
                respond(out, Response::err(id, INVALID_PARAMS, e.to_string(), None))?;
                return Ok(false);
            }
        };
        if let Some(error) = invalid_roots(&id, &roots) {
            respond(out, error)?;
            return Ok(false);
        }
        self.state = State::Initialized;

        let registry = graph::registry(&roots);
        let result = InitializeResult {
            server_version: env!("CARGO_PKG_VERSION").to_owned(),
            languages: registry.languages().into_iter().map(String::from).collect(),
        };
        respond(out, Response::ok(id, serde_json::to_value(result)?))?;
        let log = LogParams {
            level: LogLevel::Info,
            message: format!("initialized with {} roots", roots.len()),
        };
        notify(out, LOG, serde_json::to_value(log)?)?;
        Ok(false)
    }

    /// Supersedes the current run with a new one over `roots`; answers `{ runId }` before
    /// the new run thread exists, so before it sends anything.
    fn index_run(&mut self, id: Value, params: Value, out: &Out) -> io::Result<bool> {
        let params = match serde_json::from_value::<IndexRunParams>(params) {
            Ok(params) => params,
            Err(e) => {
                respond(out, Response::err(id, INVALID_PARAMS, e.to_string(), None))?;
                return Ok(false);
            }
        };
        if let Some(error) = invalid_roots(&id, &params.roots) {
            respond(out, error)?;
            return Ok(false);
        }
        let previous = self.run.take().map(|run| {
            run.cancel.store(true, Ordering::SeqCst);
            run.handle
        });
        self.next_run_id += 1;
        let run_id = self.next_run_id;
        let result = serde_json::to_value(IndexRunResult { run_id })?;
        respond(out, Response::ok(id, result))?;
        let cancel = Arc::new(AtomicBool::new(false));
        // From here until the run thread ends, changes are queued into the run.
        self.live
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .runs += 1;
        let handle = graph::spawn_run(
            graph::registry(&params.roots),
            params.roots,
            params.exclude,
            run_id,
            Arc::clone(&cancel),
            previous,
            Arc::clone(&self.live),
            Arc::clone(out),
        );
        self.run = Some(CurrentRun {
            id: run_id,
            cancel,
            handle,
        });
        Ok(false)
    }

    /// `cancelled: true` only if this swap beat the run's own publish swap.
    fn index_cancel(&self, id: Value, params: Value) -> Response {
        let run_id = match serde_json::from_value::<IndexCancelParams>(params) {
            Ok(params) => params.run_id,
            Err(e) => return Response::err(id, INVALID_PARAMS, e.to_string(), None),
        };
        let cancelled = self
            .run
            .as_ref()
            .is_some_and(|run| run.id == run_id && !run.cancel.swap(true, Ordering::SeqCst));
        Response::ok(id, serde_json::json!(IndexCancelResult { cancelled }))
    }

    /// Queues the paths into a pending run, or re-syncs them on a worker thread. Params
    /// that do not parse are ignored: a notification is never answered.
    fn files_changed(&self, params: Value, out: &Out) {
        let Ok(params) = serde_json::from_value::<IndexFilesChangedParams>(params) else {
            return;
        };
        let paths: Vec<PathBuf> = params.changes.into_iter().map(|c| c.path).collect();
        let mut pending = self
            .live
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if pending.runs > 0 {
            pending.queue.extend(paths);
        } else {
            drop(pending);
            graph::spawn_apply(Arc::clone(&self.live), paths, Arc::clone(out));
        }
    }
}

/// `-32001` naming the first root that is not an existing directory.
fn invalid_roots(id: &Value, roots: &[PathBuf]) -> Option<Response> {
    let bad = roots.iter().find(|root| !root.is_dir())?;
    let data = Value::from(bad.to_string_lossy());
    Some(Response::err(
        id.clone(),
        INVALID_ROOTS,
        "InvalidRoots",
        Some(data),
    ))
}

fn respond(out: &Out, response: Response) -> io::Result<()> {
    graph::send(out, &serde_json::to_vec(&response)?, false)
}

fn notify(out: &Out, method: &str, params: Value) -> io::Result<()> {
    graph::send(
        out,
        &serde_json::to_vec(&Notification::new(method, params))?,
        false,
    )
}
