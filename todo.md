# Cortex — TODO de implementação (para execução por agente)

> **Como usar:** execute as tarefas **em ordem**, uma seção por vez. Marque `[x]` apenas quando o **critério de aceite** passar. Não pule para a fase seguinte com tarefas abertas. Toda decisão técnica está tomada em `cortex-spec.md` — em dúvida, a spec é a fonte da verdade; **não** reabra decisões arquiteturais (descartadas na §7 da spec). Tarefas **[HUMANO]** exigem confirmação do dono do projeto: pare e pergunte.

**Stack fixa:** TypeScript · Bun · `bun:sqlite` (WAL) · `@huggingface/transformers` v4 (WASM) · `web-tree-sitter` · Zod · `@modelcontextprotocol/sdk`.

**Estrutura de diretórios alvo:**

```
src/
  app/            # composition root (runtime) + casos de uso compartilhados cli/mcp
  cli/            # entrypoints dos comandos
  storage/        # conexão, migrations, repositórios (decisions.db e code.db)
  embedding/      # provider, subprocess worker, prefixos de tarefa
  indexer/        # tree-sitter, queries TS/JS, resolução de imports
  mcp/            # servidor stdio + as 4 tools
  git/            # utilidades (root, remote, HEAD, dirty)
  domain/         # tipos, schemas Zod
tests/
.cortex/          # criado em runtime pelo init
```

## Decisões herdadas da fase 0 (concluída em 2026-07-16 — não retestar, não reabrir)

| Decisão | Detalhe |
|---|---|
| Modelo titular | **EmbeddingGemma-300m q8** @ 256 dims (MRL) — ranking 5/5 top-1, margens 0.040–0.218; licença Gemma **aprovada pelo humano**. Plano B validado: e5-small (5/5, margens finas) |
| Arquitetura de embed | **Subprocess Bun dedicado** com spawn lazy, IPC stdin/stdout JSON, **idle-kill** — heap WASM do onnxruntime não devolve RSS ao SO (1.5–2.2 GB medidos in-process) |
| Limitações Bun (medidas) | WASM roda **single-thread** (`numThreads=1`; pthread workers via blob URL não resolvem); dtype **q8 obrigatório** (q4 usa operador inexistente no EP wasm); forçar caminho web do transformers.js via `process.release.name` — workarounds documentados em `scripts/smoke-embedding.ts` |
| Latência aceita | ~600 ms/texto do Gemma OK: escrita é assíncrona; na query, é imperceptível numa tool call MCP |
| Gramática tree-sitter | TSX do **release oficial** `tree-sitter-typescript v0.23.2`, cache `~/.cortex/grammars/`, sha256 pinado (pacote `tree-sitter-wasms` descartado: formato dylink incompatível) — `scripts/smoke-treesitter.ts` |
| Deps nativas | `.node` pré-compilados em `node_modules` são transitivos e nunca carregados (caminho WASM forçado); postinstalls bloqueados; nada compila no install |

Os dois scripts de smoke ficam em `scripts/` até a tarefa 1.4 absorver o código e o contexto — depois disso podem ser removidos.

---

## FASE 1 — Núcleo de decisões

### 1.1 Domínio e validação
- [x] Criar `src/domain/`: tipos `Decision`, `Session`, `Project`, `Anchor`, enums de `edge kind` e `provenance`; schemas Zod. O schema de criação de decisão exige: `title` (min 8 chars), `body` (min 30 chars), `keywords` (array, **mínimo 5**, describe instruindo misturar PT/EN com termos de busca), `module` opcional, `anchors` opcional (`{file_path, symbol?}`), `depends_on` opcional (ids), `replaces` opcional (id).
  - **Aceite:** testes de unidade cobrindo aceitação/rejeição de cada regra.

### 1.2 Storage — conexão e migrations
- [x] `src/storage/connection.ts`: abre `.cortex/decisions.db` via `bun:sqlite` com `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`.
- [x] `src/storage/migrations.ts`: migrations idempotentes (tabela `_migrations`; cada uma em transação). Migration 001 = DDL do `decisions.db` da spec §3.1 **exatamente** — incluindo `anchors.symbol NOT NULL DEFAULT ''`, `idx_edges_reverse`, FTS5 **sem** external content com `tokenize='unicode61 remove_diacritics 2'`.
  - **Aceite:** teste em dir temporário: migrations 2× (idempotência); tabelas/índices via `sqlite_master`; busca "decisao" encontra registro com "decisão".

### 1.3 Storage — repositórios (decisions.db)
- [x] `NodeRepository`: `createDecision` (UUIDv7 via `Bun.randomUUIDv7()`; node + anchors + edges `BELONGS_TO`/`GENERATED_IN`/`DEPENDS_ON` + linha FTS **na mesma transação**), `replaceDecision` (nova decisão + edge `REPLACED_BY` + `status='replaced'` na antiga, mesma transação), `getById`, `listActive` (filtros: module, since_sha), `listModules`.
- [x] `EdgeRepository`: `getImpact(decisionId, maxDepth)` via CTE recursiva sobre `DEPENDS_ON` nas duas direções (PK para from→to, `idx_edges_reverse` para to→from), com `LIMIT` de segurança.
- [x] `SearchRepository`: `searchExact(terms)` via FTS5/BM25 → node_id + rank.
  - **Aceite:** integração contra banco real em dir temporário (nunca mocks): 3 decisões encadeadas por `DEPENDS_ON`, impact nas duas direções; replace exclui do `listActive` mas mantém no `getById`; busca FTS com acento e keyword.

### 1.4 Git utils
- [x] `src/git/`: `getRepoRoot()`, `getCanonicalProjectId()` (remote SSH/HTTPS → `host/user/repo`), `getHead()` (sha + dirty via `git status --porcelain`). Via `Bun.spawnSync`; sem remote → projectId = caminho absoluto normalizado (fallback comentado).
  - **Aceite:** testes com repo git em dir temporário (com/sem remote, limpo/dirty).

### 1.5 Provider de embedding (subprocess)
- [x] `src/embedding/`: interface `EmbeddingProvider { modelId: string; embedQuery(text): Promise<Float32Array>; embedPassages(texts): Promise<Float32Array[]> }`.
- [x] `src/embedding/worker.ts` (subprocess): absorve os workarounds de `scripts/smoke-embedding.ts` (forçar caminho web, 1 thread, q8); carrega Gemma com prefixos de tarefa **hardcoded**; trunca MRL 256 + renormaliza; protocolo JSON por linha via stdin/stdout.
- [x] `GemmaProvider` (processo principal): spawn lazy do worker no primeiro uso; **idle-kill** após N minutos sem uso (timer resetado a cada uso; respawn lazy). Download do modelo para cache global `~/.cortex/models/` (env do transformers.js apontando para lá).
- [x] Fila de embed assíncrona: `enqueue(nodeId)` → embeda e grava em `embeddings` fora do caminho do save; falha → loga e deixa pendente.
  - **Aceite (gated `RUN_MODEL_TESTS=1`):** save → fila → vetor com `model_id` correto; save funciona com provider quebrado (pendente, nada perdido); RSS do processo principal volta ao baseline após idle-kill.

### 1.6 Busca semântica
- [x] `SemanticSearch`: vetores do `model_id` ativo em memória (cache invalidado por write); embeda intent via `embedQuery`; cosine brute-force; top-K com threshold; mescla fallback FTS5 para nodes sem vetor; retorno `{node, score, source: 'vector'|'fts'}`.
  - **Aceite (gated):** 10 decisões, "como autenticamos usuários?" retorna a de JWT no top-3 sem conter "autentica"; provider desligado → degrada para FTS sem erro.

### 1.7 Servidor MCP (stdio) — as 4 tools
- [x] `src/mcp/server.ts` com o SDK, transporte stdio. Sessão implícita por processo (node `session` no primeiro save). Projeto resolvido pelo git remote no startup (cria node `project` se não existir).
- [x] `save_decision`: valida (schema 1.1); âncoras de arquivo checadas contra o working tree (inexistente → aviso, não erro); grava `commit_sha`/`dirty`; suporta `replaces`; enfileira embed; retorna id + avisos.
- [x] `get_context`: `intent?` e `module?`; com intent → busca semântica; sem → decisões ativas recentes + sumários de sessão. Retorno compacto.
- [x] `get_impact`: `decision_id` → árvore de decisões afetadas (ambas direções, profundidade limitada) + âncoras.
- [x] `search`: `terms` + flag `exact`; descrição instrui o agente a passar múltiplos termos e variações PT/EN.
- [x] Passada de revisão dedicada só nas descrições das tools (são a interface real com o agente): quando usar, o que passar, exemplos.
  - **Aceite:** e2e via client MCP do SDK contra servidor em subprocess: save → get_context encontra → impact retorna cadeia → replace → antiga some do get_context.

### 1.8 Comandos CLI
- [x] `cortex init`: cria `.cortex/`, migrations, `.cortex/config` (JSON: `model_id`, versão do schema), adiciona `.cortex/code.db*` ao `.gitignore` (perguntando), imprime próximos passos. Idempotente.
- [x] `cortex serve --mcp`
- [x] `cortex log [--module M] [--since SHA]`
- [x] `cortex why <path>`: âncora no caminho (prefix match p/ diretórios), cronológico.
- [x] `cortex search <texto...> [--exact]`: com score e origem.
- [x] `cortex impact <id>`: árvore indentada.
- [x] `cortex embed --missing | --rebuild` (rebuild confirma e atualiza `model_id` se o config mudou).
- [x] `cortex doctor`: âncoras órfãs; decisões sem embedding; keywords < 5; modelo não baixado; versão de schema.
  - **Aceite:** cada comando com teste de integração mínimo (exit code + saída) em repo git temporário.

### 1.9 Qualidade de fase
- [x] Cobertura sobre `storage/`, `embedding/`, `domain/`; `bun run check` limpo; README de uso (init → `claude mcp add cortex -- cortex serve --mcp` → fluxo básico). Remover `scripts/smoke-*.ts` (contexto já absorvido pela 1.5/2.2).
- [x] **[HUMANO] Dogfooding:** daqui em diante, toda decisão das fases seguintes vira `save_decision` no próprio Cortex.

---

## FASE 2 — Índice de código próprio (TS/JS)

### 2.1 Storage do code.db
- [x] Conexão separada para `.cortex/code.db` (WAL) + migration com o DDL da spec §3.2 (`files`, `symbols`, `imports` com `provenance`). Repositório com `wipeAndRebuild()` e upserts incrementais por arquivo.
  - **Aceite:** deletar `code.db` e reindexar produz resultado idêntico (regenerabilidade em teste).

### 2.2 Extração TS/JS
- [x] `src/indexer/`: gramática TSX de `~/.cortex/grammars/` (download lazy do release oficial + sha256, padrão da fase 0); walker respeitando `.gitignore` (`git ls-files` quando repo git) + exclusões fixas (`node_modules`, `dist`, `build`, `.cortex`, > 1 MB); queries: imports (`import`/`export from`/`require`) e símbolos (funções, classes, métodos, arrows nomeadas) com nome qualificado `Classe.metodo`.
  - **Aceite:** fixture ~10 arquivos (default export, re-export, require, classe c/ métodos, arrow const); snapshot test.

### 2.3 Resolução de imports (heurística assumida)
- [x] Specifier → arquivo: relativos com extensões omitidas (`./x` → `x.ts|.tsx|.js|/index.*`), aliases básicos de `tsconfig.json` (`paths`/`baseUrl`); npm/não resolvido → `to_path = NULL`. `provenance`: `exact` (relativo com extensão explícita) | `heuristic` (resto).
  - **Aceite:** fixture com `paths`; taxa de resolução medida e registrada (meta ≥ 85 %); nenhum throw em specifier estranho.

### 2.4 Incremental + reconciliação lazy
- [x] `cortex index`: full na primeira vez; depois diff `(size, mtime)` + hash — reprocessa só mudados/novos, remove deletados. No MCP: reconciliação na primeira query da sessão que toque o code.db (catch-up de edições com servidor desligado).
  - **Aceite:** editar 1 arquivo de fixture de 50 → reindex de exatamente 1; benchmark do full index no próprio repo registrado.

### 2.5 Integração com o grafo de decisões
- [x] Âncora de símbolo validada no `save_decision` e no `doctor` (não encontrado → aviso com sugestões aproximadas).
- [x] `cortex why <symbol>`: símbolo → arquivo → decisões ancoradas (arquivo ou símbolo exato).
- [x] `get_impact` expandido: decisão → arquivos ancorados → importadores transitivos via CTE em `imports` (profundidade default 3, configurável) → decisões ancoradas neles. Resposta separa impacto por `DEPENDS_ON` vs. por código (imports), com `provenance` visível.
  - **Aceite:** e2e — decisão em `src/auth/service.ts`; importado por `src/api/login.ts` com outra decisão; impact da primeira retorna a segunda via caminho de código.

### 2.6 Qualidade de fase
- [x] `doctor` cobre o code.db (desatualizado vs. working tree; taxa de imports não resolvidos). Documentar degradação (linguagem não suportada → âncora de arquivo). Registrar as decisões da fase no próprio Cortex.

---

## Regras permanentes para o agente executor

1. **Nunca** adicionar dependência nativa ou que exija compilação — se parecer necessário, parar e reportar.
2. **Nunca** fazer chamada de rede em runtime fora dos downloads lazy (modelo, gramáticas) — sempre com cache global e verificação de hash.
3. Testes de storage/busca contra SQLite **real** em dir temporário; testes que carregam modelo atrás de `RUN_MODEL_TESTS=1`.
4. Escrita de decisão + âncoras + edges + FTS é **uma** transação — parcial nunca.
5. Dúvida de design não coberta pela spec: registrar, propor 2 opções com trade-offs, perguntar — não decidir sozinho em ponto arquitetural.