# Bundled parser assets

These unmodified JavaScript and WebAssembly files are the parser-only asset closure from the npm packages recorded in `manifest.json`. The manifest records exact versions, original tarball URLs, verified npm SHA-512 integrity, and per-file SHA-256 hashes. `../grammars.lock` is the runtime integrity authority. Each package directory retains its upstream MIT LICENSE.

Included packages:

- web-tree-sitter 0.25.10 — https://github.com/tree-sitter/tree-sitter
- tree-sitter-javascript 0.23.1 — https://github.com/tree-sitter/tree-sitter-javascript
- tree-sitter-typescript 0.23.2 — https://github.com/tree-sitter/tree-sitter-typescript
- tree-sitter-python 0.23.6 — https://github.com/tree-sitter/tree-sitter-python
- tree-sitter-java 0.23.5 — https://github.com/tree-sitter/tree-sitter-java

No native Node bindings, grammar compiler, install script, browser, service or package manager is invoked by the runtime. Updates are maintainer work: retrieve the exact upstream tarballs without lifecycle scripts, verify their integrity, copy the loader/runtime/grammars and LICENSE files, and update both manifests deliberately. Ordinary installation uses these shipped bytes even when optional dependencies are omitted.
