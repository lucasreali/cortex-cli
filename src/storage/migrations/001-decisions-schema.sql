CREATE TABLE nodes (
	id           TEXT PRIMARY KEY,                 -- UUIDv7 (Bun.randomUUIDv7())
	kind         TEXT NOT NULL CHECK (kind IN ('decision', 'session', 'project')),
	title        TEXT,                             -- nullable: session/project podem não ter
	body         TEXT,                             -- nullable: idem
	keywords     TEXT NOT NULL DEFAULT '[]',       -- JSON array; min 5 p/ decision (validado no app)
	module       TEXT,
	status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'replaced')),
	commit_sha   TEXT,
	commit_dirty INTEGER NOT NULL DEFAULT 0,
	provenance   TEXT NOT NULL DEFAULT 'agent' CHECK (provenance IN ('agent', 'human')),
	props        TEXT,                             -- JSON: extras não indexados
	created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_nodes_kind_status ON nodes (kind, status);

CREATE TABLE anchors (
	node_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
	file_path TEXT NOT NULL,
	symbol    TEXT NOT NULL DEFAULT '',            -- '' = âncora de arquivo (NULL quebraria a PK)
	PRIMARY KEY (node_id, file_path, symbol)
);

CREATE INDEX idx_anchors_file_path ON anchors (file_path);

CREATE TABLE edges (
	from_id TEXT NOT NULL REFERENCES nodes(id),
	to_id   TEXT NOT NULL REFERENCES nodes(id),
	kind    TEXT NOT NULL CHECK (kind IN ('BELONGS_TO', 'GENERATED_IN', 'DEPENDS_ON', 'REPLACED_BY')),
	PRIMARY KEY (from_id, kind, to_id)             -- ordem (from,kind,to) aceita: melhor p/ scan por kind
);

CREATE INDEX idx_edges_reverse ON edges (to_id, kind, from_id);

CREATE TABLE embeddings (
	node_id    TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
	model_id   TEXT NOT NULL,                      -- 'embeddinggemma-300m-q@256'
	dims       INTEGER NOT NULL,
	vector     BLOB NOT NULL,                      -- Float32Array
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE VIRTUAL TABLE nodes_fts USING fts5(
	node_id UNINDEXED,
	title,
	body,
	keywords,
	tokenize = 'unicode61 remove_diacritics 2'
);
