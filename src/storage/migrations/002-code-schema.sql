CREATE TABLE files (
	path  TEXT PRIMARY KEY,                 -- relative to the repo root
	lang  TEXT NOT NULL,
	hash  TEXT NOT NULL,
	mtime INTEGER NOT NULL,
	size  INTEGER NOT NULL
);

CREATE TABLE symbols (
	id        INTEGER PRIMARY KEY,          -- internal, never referenced from decisions.db
	file_path TEXT NOT NULL REFERENCES files(path),
	name      TEXT NOT NULL,                -- qualified: 'AuthService.validateToken'
	kind      TEXT NOT NULL,                -- 'function' | 'class' | 'method' | ...
	line      INTEGER NOT NULL
);

CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_symbols_file ON symbols(file_path);

CREATE TABLE imports (
	from_path  TEXT NOT NULL,
	to_path    TEXT,                        -- resolved file (NULL = unresolved)
	specifier  TEXT NOT NULL,               -- the import's original text
	provenance TEXT NOT NULL DEFAULT 'heuristic',  -- 'exact' | 'heuristic'
	PRIMARY KEY (from_path, specifier)
);

CREATE INDEX idx_imports_to ON imports(to_path);
