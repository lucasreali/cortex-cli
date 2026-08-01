-- Symbol-name suggestions for a near miss: the full name, its last segment, or
-- any member of the named owner. $file scopes the search to one file; NULL
-- searches the whole index.
SELECT DISTINCT name FROM symbols
WHERE ($file IS NULL OR file_path = $file)
  AND (name LIKE '%' || $full || '%'
    OR name LIKE '%' || $last || '%'
    OR ($owner != '' AND name LIKE $owner || '.%'))
ORDER BY name LIMIT $limit
