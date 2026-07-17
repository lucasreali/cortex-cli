WITH RECURSIVE impact (node_id, depth) AS (
	SELECT $id, 0
	UNION
	SELECT
		CASE WHEN e.from_id = i.node_id THEN e.to_id ELSE e.from_id END,
		i.depth + 1
	FROM edges e
	JOIN impact i ON i.node_id IN (e.from_id, e.to_id)
	WHERE e.kind = 'DEPENDS_ON'
	  AND i.depth < $maxDepth
	LIMIT $limit
)
SELECT node_id, MIN(depth) AS depth
FROM impact
WHERE node_id <> $id
GROUP BY node_id
ORDER BY depth, node_id;
