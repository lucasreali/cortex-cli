-- Widens the graph vocabulary: 'archived' joins the status CHECK, and
-- CONFLICTS_WITH / ARCHIVED_BY join the edge-kind CHECK. SQLite cannot alter
-- a CHECK, so both tables are rebuilt; the runner turns foreign keys off
-- around this migration (the rebuild drops a referenced table) and verifies
-- the result with foreign_key_check before committing.

CREATE TABLE nodes_rebuilt (
	id           TEXT PRIMARY KEY,                 -- UUIDv7 (Bun.randomUUIDv7())
	kind         TEXT NOT NULL CHECK (kind IN ('decision', 'session', 'project')),
	title        TEXT,                             -- nullable: sessions and projects may have none
	body         TEXT,
	keywords     TEXT NOT NULL DEFAULT '[]',       -- JSON array; min 5 per decision (enforced in the app)
	module       TEXT,
	status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'replaced', 'archived')),
	commit_sha   TEXT,
	commit_dirty INTEGER NOT NULL DEFAULT 0,
	provenance   TEXT NOT NULL DEFAULT 'agent' CHECK (provenance IN ('agent', 'human')),
	props        TEXT,                             -- JSON: extras, not indexed
	created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	present      INTEGER NOT NULL DEFAULT 1
);

INSERT INTO nodes_rebuilt
	(id, kind, title, body, keywords, module, status,
	 commit_sha, commit_dirty, provenance, props, created_at, present)
SELECT
	id, kind, title, body, keywords, module, status,
	commit_sha, commit_dirty, provenance, props, created_at, present
FROM nodes;

DROP TABLE nodes;
ALTER TABLE nodes_rebuilt RENAME TO nodes;

CREATE INDEX idx_nodes_kind_status ON nodes (kind, status, present);

CREATE TABLE edges_rebuilt (
	from_id TEXT NOT NULL REFERENCES nodes(id),
	to_id   TEXT NOT NULL REFERENCES nodes(id),
	kind    TEXT NOT NULL CHECK (kind IN ('BELONGS_TO', 'GENERATED_IN', 'DEPENDS_ON', 'REPLACED_BY', 'CONFLICTS_WITH', 'ARCHIVED_BY')),
	PRIMARY KEY (from_id, kind, to_id)             -- (from,kind,to) order on purpose: better for scanning by kind
);

INSERT INTO edges_rebuilt (from_id, to_id, kind)
SELECT from_id, to_id, kind FROM edges;

DROP TABLE edges;
ALTER TABLE edges_rebuilt RENAME TO edges;

CREATE INDEX idx_edges_reverse ON edges (to_id, kind, from_id);
