-- Bootstrap for the migration machinery itself, not a numbered migration:
-- it must exist before any migration can be recorded, in both databases.
CREATE TABLE IF NOT EXISTS _migrations (
	id         INTEGER PRIMARY KEY,
	name       TEXT NOT NULL,
	applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
