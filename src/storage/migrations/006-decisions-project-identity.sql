-- A project node is this machine's identity for one repository, so two rows
-- carrying the same canonical id are never both right: sessions and decisions
-- split their BELONGS_TO edges across two identities with nothing to merge
-- them back. Two processes opening the same repository at once used to produce
-- exactly that, and the store could not even notice. Existing duplicates are
-- collapsed onto the oldest row here, and the index below is what keeps the
-- second one from being written again.

UPDATE OR REPLACE edges
SET to_id = (
	SELECT MIN(keeper.id)
	FROM nodes keeper, nodes current
	WHERE current.id = edges.to_id
	  AND keeper.kind = 'project'
	  AND keeper.title = current.title
)
WHERE to_id IN (
	SELECT id FROM nodes WHERE kind = 'project' AND title IS NOT NULL
);

DELETE FROM nodes
WHERE kind = 'project'
  AND title IS NOT NULL
  AND id <> (
	SELECT MIN(other.id) FROM nodes other
	WHERE other.kind = 'project' AND other.title = nodes.title
  );

-- Partial, because only a project's title is an identity: two decisions may
-- legitimately share one. A project with no title keeps the SQL default of
-- distinct NULLs, which is what a row predating canonical ids needs.
CREATE UNIQUE INDEX idx_nodes_project_title ON nodes (title)
	WHERE kind = 'project';
