-- $limit caps the rows the recursion may produce; `scanned` reports how many it
-- actually produced so the caller can say the walk was cut short instead of
-- presenting a depth-biased slice as the whole answer.
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
-- One row per path, taken whole from the shortest chain that reaches it, so
-- depth and provenance always describe a chain that exists; 'exact' sorts
-- before 'heuristic', which breaks ties towards the trustworthy chain.
SELECT path, depth, provenance, scanned
FROM (
	SELECT
		path,
		depth,
		provenance,
		ROW_NUMBER() OVER (PARTITION BY path ORDER BY depth, provenance) AS chain,
		COUNT(*) OVER () AS scanned
	FROM importers
)
WHERE chain = 1 AND path NOT IN (SELECT value FROM json_each($seeds))
ORDER BY depth, path;
