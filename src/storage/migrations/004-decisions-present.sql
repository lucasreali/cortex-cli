-- `present` is a working-tree fact (does this decision's file exist on the
-- branch checked out right now?), orthogonal to `status`, which is a product
-- fact (was it superseded?). A decision can be both at once.
ALTER TABLE nodes ADD COLUMN present INTEGER NOT NULL DEFAULT 1;

-- SQLite cannot extend an index in place. (kind, status) stays the leading
-- prefix, so every lookup that predates this migration keeps its index.
DROP INDEX idx_nodes_kind_status;

CREATE INDEX idx_nodes_kind_status ON nodes (kind, status, present);
