-- Symbol-name suggestions for a near miss: the full name, its last segment, or
-- any member of the named owner. $file scopes the search to one file; NULL
-- searches the whole index. The three patterns arrive escaped, because a symbol
-- key keeps the `_` that LIKE would otherwise read as a wildcard.
SELECT DISTINCT name FROM symbols
WHERE ($file IS NULL OR file_path = $file)
  AND (name LIKE '%' || $full || '%' ESCAPE '\'
    OR name LIKE '%' || $last || '%' ESCAPE '\'
    OR ($owner != '' AND name LIKE $owner || '.%' ESCAPE '\'))
ORDER BY name LIMIT $limit
