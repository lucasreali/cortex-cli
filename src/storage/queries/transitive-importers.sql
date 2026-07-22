WITH RECURSIVE importers (path, depth, provenance) AS (
	SELECT i.from_path, 1, i.provenance
	FROM imports i
	WHERE i.to_path IN (SELECT value FROM json_each($seeds))
	UNION
	SELECT
		i.from_path,
		importers.depth + 1,
		CASE
			WHEN i.provenance = 'heuristic' OR importers.provenance = 'heuristic'
				THEN 'heuristic'
			ELSE 'exact'
		END
	FROM imports i
	JOIN importers ON i.to_path = importers.path
	WHERE importers.depth < $maxDepth
	LIMIT $limit
)
SELECT path, MIN(depth) AS depth, MIN(provenance) AS provenance
FROM importers
WHERE path NOT IN (SELECT value FROM json_each($seeds))
GROUP BY path
ORDER BY depth, path;
