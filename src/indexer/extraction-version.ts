// Content version of code.db, the second axis next to the schema version:
// the schema migrates in place, but rows written by an older extractor are
// silently missing whatever a newer extractor would produce — only a full
// rebuild fixes that. Bump on any change to the output of the extractor, the
// import resolver, or the normalization the index writer applies before it
// stores a symbol name; a stale (or absent) stamp forces a full re-index on
// the next reconcile.
//
// 2: symbol names are stored canonicalized (src/support/symbol-key.ts). Rows
// written by version 1 keep whatever spelling the source used, so a ligature
// or a decomposed accent in an identifier would match neither the suggestion
// query nor a fresh row for the same symbol.
//
// 3: `.ts` sources are parsed with the TypeScript grammar instead of the TSX
// one, so a file holding a `<T>expr` assertion no longer collapses into an
// ERROR node that swallows every symbol after it; interfaces, type aliases,
// enums, abstract classes, generators, namespaces, ambient signatures, class
// fields and exported bindings are extracted; accessors are distinguished from
// methods; and dynamic `import()` and `import x = require()` produce edges.
// Rows written by version 2 are missing all of it.
export const EXTRACTION_VERSION = 3;
