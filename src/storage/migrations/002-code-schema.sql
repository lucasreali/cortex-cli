CREATE TABLE files (
	path  TEXT PRIMARY KEY,                 -- relativo à raiz do repo
	lang  TEXT NOT NULL,
	hash  TEXT NOT NULL,                    -- p/ reconciliação incremental
	mtime INTEGER NOT NULL,
	size  INTEGER NOT NULL
);

CREATE TABLE symbols (
	id        INTEGER PRIMARY KEY,          -- interno, nunca referenciado pelo decisions.db
	file_path TEXT NOT NULL REFERENCES files(path),
	name      TEXT NOT NULL,                -- qualificado: 'AuthService.validateToken'
	kind      TEXT NOT NULL,                -- 'function' | 'class' | 'method' | ...
	line      INTEGER NOT NULL
);

CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_symbols_file ON symbols(file_path);

CREATE TABLE imports (
	from_path  TEXT NOT NULL,               -- arquivo que importa
	to_path    TEXT,                        -- arquivo resolvido (NULL = não resolveu)
	specifier  TEXT NOT NULL,               -- o texto original do import
	provenance TEXT NOT NULL DEFAULT 'heuristic',  -- 'exact' | 'heuristic'
	PRIMARY KEY (from_path, specifier)
);

CREATE INDEX idx_imports_to ON imports(to_path);
