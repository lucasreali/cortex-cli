-- Symbol-name suggestions for a near miss: the full name, its last segment, or
-- any member of the named owner. $file scopes the search to one file; NULL
-- searches the whole index.
--
-- The three name parameters arrive as normalized keys (src/support/symbol-key.ts),
-- while `name` holds the stored form with its case intact — LIKE is what bridges
-- the two, since SQLite's LIKE ignores ASCII case. A suggestion is a hint, so an
-- approximate bridge is the right amount of machinery here; the exact question
-- ("does this symbol exist?") is answered by comparing keys, never by this query.
--
-- Every term is guarded against the empty string: a name that normalizes away
-- entirely leaves LIKE '%%', which matches every symbol in the index and turns
-- a suggestion list into a random sample. The terms also arrive escaped, because
-- a symbol key keeps the `_` that LIKE would otherwise read as a wildcard.
SELECT DISTINCT name FROM symbols
WHERE ($file IS NULL OR file_path = $file)
  AND (($full != '' AND name LIKE '%' || $full || '%' ESCAPE '\')
    OR ($last != '' AND name LIKE '%' || $last || '%' ESCAPE '\')
    OR ($owner != '' AND name LIKE $owner || '.%' ESCAPE '\'))
ORDER BY name LIMIT $limit
