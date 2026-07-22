// Content version of code.db, the second axis next to the schema version:
// the schema migrates in place, but rows written by an older extractor are
// silently missing whatever a newer extractor would produce — only a full
// rebuild fixes that. Bump on any change to the output of the extractor or
// the import resolver; a stale (or absent) stamp forces a full re-index on
// the next reconcile.
export const EXTRACTION_VERSION = 1;
