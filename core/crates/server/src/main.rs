mod flow;
mod graph;
mod handler;

use std::io;
use std::panic;
use std::process;

/// No arguments or environment variables are read; stdin/stdout are the transport.
fn main() {
    // A panic prints its message to stderr via the default hook; exit 101 instead of hanging.
    let code = panic::catch_unwind(|| {
        // Owned stdout: the index run thread writes through the same shared writer.
        handler::Server::default().run(&mut io::stdin().lock(), io::stdout())
    })
    .unwrap_or(101);
    process::exit(code);
}
