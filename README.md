# code-matrix

## Build and test

Prerequisites: Rust stable (with `clippy`, `rustfmt`) and Node 20.

Core (`code-matrix-server`):

```sh
cd core
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --all --check
```

Extension:

```sh
cd extension
npm ci
npm run lint              # tsc --noEmit
npm run build             # dist/extension.js, dist/webview.js
npm run test:unit         # vitest
npm run test:integration  # VS Code 1.90.0; on headless Linux: xvfb-run -a npm run test:integration
```

## Packaging

The .vsix is platform-specific: it carries one `code-matrix-server` at
`bin/<platform>-<arch>/`, built natively (no cross-compilation).

```sh
cd extension
npm run bundle-server                       # debug build into bin/<host-key>/ for development and tests
npm run package                             # release build + vsce package --target <host-key>
npm run package -- --target darwin-arm64    # must equal the host key, or the script refuses
```

Targets: `win32-x64`, `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`.
`.github/workflows/package.yml` builds all five on native runners (on `v*` tags or manually)
and attaches them to the GitHub release for a tag.

To run the extension against an unbundled server, set `CODE_MATRIX_SERVER_PATH` to the binary;
the integration tests do this with `core/target/debug/code-matrix-server`.
