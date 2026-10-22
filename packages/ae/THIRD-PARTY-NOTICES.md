# Bundled runtime libraries

AE distributes the following unmodified libraries inside its npm archive. Their
complete license and notice files remain in the corresponding dependency folder.

| Library | Version | License | Shipped license and notices |
| --- | --- | --- | --- |
| [Pele](https://github.com/obsidianmd/pele) | 1.8.0 | MIT | `node_modules/pele/LICENSE` |
| [D2 JavaScript/WASM](https://github.com/d2lang/d2) | 0.1.34 | MPL-2.0 | `node_modules/@d2lang/d2/LICENSE.txt`, `node_modules/@d2lang/d2/THIRD_PARTY_NOTICES.txt` |
| [yaml](https://github.com/eemeli/yaml) | See bundled package manifest | ISC | `node_modules/yaml/LICENSE` |

The D2 package includes its upstream worker, WebAssembly, runtime and third-party
notices. Source for the bundled release is available from the D2 upstream project
and its published npm package. AE does not modify those library files.

Optional tree-sitter packages retain their own upstream licenses. They are not
required for the bundled diagram renderers.
