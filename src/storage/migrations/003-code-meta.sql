-- Metadados do índice, um registro por chave.
-- 'extraction_version': eixo de conteúdo do code.db — o schema migra in
-- place, mas conteúdo extraído por versão antiga só se corrige com rebuild
-- (ver src/indexer/extraction-version.ts).
CREATE TABLE meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
