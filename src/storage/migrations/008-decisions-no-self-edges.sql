-- An edge from a decision to itself states nothing and derives a lie: a file
-- naming its own id under `replaces` used to retire the decision it *is*,
-- taking it out of search, get_context and prompt-hook with a clean report and
-- no undo — the files are immutable. The reconciler drops such an edge before
-- it is ever offered here; this CHECK is what makes it unrepresentable for
-- anything else that writes. SQLite cannot alter a CHECK, so the table is
-- rebuilt: the runner turns foreign keys off around this migration and
-- verifies the result with foreign_key_check before committing.

CREATE TABLE edges_rebuilt (
	from_id TEXT NOT NULL REFERENCES nodes(id),
	to_id   TEXT NOT NULL REFERENCES nodes(id),
	kind    TEXT NOT NULL CHECK (kind IN ('BELONGS_TO', 'GENERATED_IN', 'DEPENDS_ON', 'REPLACED_BY', 'CONFLICTS_WITH', 'ARCHIVED_BY')),
	PRIMARY KEY (from_id, kind, to_id),            -- (from,kind,to) order on purpose: better for scanning by kind
	CHECK (from_id <> to_id)
);

INSERT INTO edges_rebuilt (from_id, to_id, kind)
SELECT from_id, to_id, kind FROM edges WHERE from_id <> to_id;

DROP TABLE edges;
ALTER TABLE edges_rebuilt RENAME TO edges;

CREATE INDEX idx_edges_reverse ON edges (to_id, kind, from_id);
