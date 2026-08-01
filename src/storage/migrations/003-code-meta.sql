-- 'extraction_version': the content axis of code.db — the schema migrates in
-- place, but content extracted by an older version is only corrected by a
-- rebuild (see src/indexer/extraction-version.ts).
CREATE TABLE meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
