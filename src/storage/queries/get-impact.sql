-- Two directed walks from one decision, never one undirected one: an
-- undirected walk steps from a decision to what it builds on and from there to
-- every sibling that builds on the same thing, which is not impact at all.
--
--   dependent  — decisions that build on this one, transitively: what a change
--                here can break.
--   dependency — decisions this one builds on, transitively: what it assumes.
--
-- A replaced decision is walked through to its successor at the same depth,
-- because the successor is what now carries the link. The walk crosses
-- decisions that are off this branch — the link is still a fact — but only
-- active decisions present here are returned.
WITH RECURSIVE
dependents (node_id, depth) AS (
	SELECT $id, 0
	UNION
	SELECT e.from_id, d.depth + 1
	FROM edges e
	JOIN dependents d ON e.to_id = d.node_id
	WHERE e.kind = 'DEPENDS_ON' AND d.depth < $maxDepth
	UNION
	SELECT e.to_id, d.depth
	FROM edges e
	JOIN dependents d ON e.from_id = d.node_id
	WHERE e.kind = 'REPLACED_BY' AND d.depth > 0
	LIMIT $limit
),
dependencies (node_id, depth) AS (
	SELECT $id, 0
	UNION
	SELECT e.to_id, d.depth + 1
	FROM edges e
	JOIN dependencies d ON e.from_id = d.node_id
	WHERE e.kind = 'DEPENDS_ON' AND d.depth < $maxDepth
	UNION
	SELECT e.to_id, d.depth
	FROM edges e
	JOIN dependencies d ON e.from_id = d.node_id
	WHERE e.kind = 'REPLACED_BY' AND d.depth > 0
	LIMIT $limit
),
walked (node_id, depth, relation) AS (
	SELECT node_id, depth, 'dependent' FROM dependents
	UNION ALL
	SELECT node_id, depth, 'dependency' FROM dependencies
)
SELECT w.node_id, MIN(w.depth) AS depth, w.relation
FROM walked w
JOIN nodes n ON n.id = w.node_id
WHERE w.node_id <> $id AND n.status = 'active' AND n.present = 1
GROUP BY w.node_id, w.relation
ORDER BY depth, w.relation DESC, w.node_id;
