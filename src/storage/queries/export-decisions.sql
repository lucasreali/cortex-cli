-- Rebuilds the versioned form of every decision in the store, for the one-time
-- export of a store that predates `.cortex/decisions/`. The two link columns
-- come back as JSON arrays, ordered so the exported files are byte-stable.
--
-- `replaces` inverts the edge on purpose: REPLACED_BY points from the old
-- decision to the new one, but the file records the link on the new one, which
-- is what keeps decision files write-once.
SELECT
	n.id,
	n.title,
	n.body,
	n.keywords,
	n.module,
	n.commit_sha,
	n.commit_dirty,
	n.provenance,
	n.created_at,
	(
		SELECT e.from_id FROM edges e
		WHERE e.to_id = n.id AND e.kind = 'REPLACED_BY'
		ORDER BY e.from_id
		LIMIT 1
	) AS replaces,
	(
		SELECT json_group_array(target) FROM (
			SELECT e.to_id AS target FROM edges e
			WHERE e.from_id = n.id AND e.kind = 'DEPENDS_ON'
			ORDER BY e.to_id
		)
	) AS depends_on,
	(
		SELECT json_group_array(anchor) FROM (
			SELECT
				CASE
					WHEN a.symbol = '' THEN a.file_path
					ELSE a.file_path || '#' || a.symbol
				END AS anchor
			FROM anchors a
			WHERE a.node_id = n.id
			ORDER BY a.file_path, a.symbol
		)
	) AS anchors
FROM nodes n
WHERE n.kind = 'decision'
ORDER BY n.id;
