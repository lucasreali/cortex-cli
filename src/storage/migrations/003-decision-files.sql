CREATE TABLE decision_files (
	file_name TEXT PRIMARY KEY,                      -- '<uuid>.md' dentro de .cortex/decisions/
	hash      TEXT NOT NULL,                         -- hash do conteúdo na última sincronização
	node_id   TEXT NOT NULL                          -- sem FK: bookkeeping do sync, não parte do grafo
);
