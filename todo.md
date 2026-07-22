# Cortex CLI — Backlog de melhorias

Origem: revisão comparativa com o projeto irmão `codegraph` (2026-07-22).
Ordenado por alavancagem; cada item diz o que construir, por quê, e onde
fica a implementação de referência no codegraph.

---

## Alta prioridade

### 1. Prompt hook com gate de confiança

**Feito (2026-07-22).** `cortex prompt-hook` (comando oculto) + gate em
`src/app/prompt-gate.ts`: HIGH = termo bate na coluna `keywords` do FTS,
MEDIUM = bate só em `title`, corpo nunca gateia. Store aberto read-only via
walk-up do cwd; sem dependência do item 5 (importa o storage direto).
~110ms medidos; aceite coberto em `tests/cli/cli.test.ts` e
`tests/app/prompt-gate.test.ts`.

Tornar a recuperação de decisões passiva: um comando `cortex prompt-hook`
plugado como hook `UserPromptSubmit` do Claude Code que lê `{prompt, cwd}`
do stdin, confronta os termos do prompt com keywords/FTS das decisões e só
injeta um bloco `<cortex_context>` quando há match verificado.

- Gate em tiers, seguindo o codegraph (`src/bin/codegraph.ts:1220`):
  - **HIGH** — termo do prompt bate direto no FTS/keywords → injeta as
    decisões encontradas (título + corpo, tamanho limitado).
  - **MEDIUM** — match fraco → injeta só títulos/ids; o agente decide se
    chama `get_context`.
  - **Sem match** — no-op silencioso (saída vazia), nunca injetar ruído.
- O campo `keywords` (mín. 5, mistura PT/EN) é o análogo já existente do
  `name_segment_vocab` do codegraph — não precisa de tabela nova para
  começar.
- Depende do item 5 (saída `--json`) se o hook chamar a CLI em vez de
  importar o runtime diretamente.
- Aceite: hook responde em ~200ms com embeddings desabilitados (caminho
  FTS puro); nenhuma injeção em prompts não relacionados; injeção com
  tamanho limitado.

### 2. MCP multi-projeto: `projectPath` por chamada

**Feito (2026-07-22).** `projectPath` opcional nas quatro tools
(`src/mcp/tools/project-scope.ts`) + `RuntimeRegistry`
(`src/mcp/runtime-registry.ts`): re-resolve por walk-up a cada chamada,
runtime cacheado por raiz **resolvida** (nunca pelo path de entrada),
config/`model_id` isolados por raiz. Sem projeto default o campo vira
obrigatório no schema; path não inicializado retorna
`{status: "not_initialized", guidance}` sem `isError` (antecipa o item 3).
`serve` não auto-cria mais `.cortex/` — init é sempre explícito. A
preocupação de memória já estava coberta: o `GemmaProvider` faz spawn lazy
do worker e o mata após 5 min ocioso. Aceite em
`tests/mcp/multi-project.test.ts`.

Servir todos os repos com `.cortex/` a partir de um único registro MCP no
nível do usuário, em vez de um `claude mcp add` por projeto.

- Adicionar `projectPath` opcional às quatro tools; resolver o `.cortex/`
  mais próximo subindo a partir do path a cada chamada (stat walk barato);
  cachear o runtime/conexão aberto por raiz resolvida.
  Referência: codegraph `src/mcp/tools.ts:1030` (`getCodeGraph`) e `:766`
  (`withRequiredProjectPath` — schema reescrito para tornar o campo
  obrigatório quando o servidor sobe sem projeto default).
- Manter o isolamento de config por raiz: cada runtime pina seu próprio
  `model_id`.
- Atenção à memória: cada runtime cacheado pode segurar um subprocess de
  embedding — considerar spawn lazy do provider por raiz e descarte por
  ociosidade (relaciona com o item 7).
- Aceite: uma instância do servidor responde tools para dois repos
  diferentes na mesma sessão; path desconhecido/não inicializado retorna
  orientação, não erro (item 3).

### 3. Disciplina de resultado no MCP: `readOnlyHint` + orientação em vez de erro

**Feito (2026-07-22).** `READ_ONLY_ANNOTATIONS` compartilhadas
(`src/mcp/tools/annotations.ts`: readOnly/idempotent/não-destrutivo/closed-world,
como o codegraph) nas três tools de leitura; `guidanceResult(status, guidance)`
em `src/mcp/tools/results.ts` generaliza o formato-sucesso-com-orientação:
`get_impact` com id desconhecido e `save_decision` com `replaces`/`depends_on`
inexistentes (antes estourava FK crua do SQLite como `isError`) retornam
`{status: "not_found", guidance}`; `search`/`get_context` vazios ganham
`guidance` no payload. `errorResult` ficou só para falha genuína
(catch do `save_decision`). Aceite coberto: harness e2e extraído para
`tests/mcp/harness.ts`; `tests/mcp/result-discipline.test.ts` prova ausência
de `isError` com `code.db` corrompido (get_impact → `code_warning`,
save_decision → warning); caminho não inicializado já coberto em
`tests/mcp/multi-project.test.ts`.

Duas mudanças baratas com efeito desproporcional no comportamento do
agente, ambas vindas do codegraph (`src/mcp/tools.ts:35-52`, `:520`):

- Anotar `get_context`, `search` e `get_impact` com `readOnlyHint: true`
  para clientes com gating de permissão executarem sem perguntar.
- Reservar `isError: true` para falhas genuínas. Estados recuperáveis —
  projeto sem init, índice de código indisponível, resultado vazio —
  retornam payload em formato de sucesso com orientação (o que rodar, ex.:
  `cortex init`). Um `isError` cedo ensina o agente que o toolset está
  quebrado e ele para de chamar. O `code_warning` do `get_impact` já segue
  esse padrão; generalizar.
- Aceite: testes do MCP garantem ausência de `isError` nos caminhos de
  projeto não inicializado e índice indisponível.

### 4. Versionamento de conteúdo do `code.db` (dois eixos)

**Feito (2026-07-22).** `EXTRACTION_VERSION` em
`src/indexer/extraction-version.ts`, gravada na tabela `meta` do `code.db`
(migration id 2 `code-meta`, `003-code-meta.sql` — a primeira de evolução
real; upgrade in place coberto em `tests/storage/code-db.test.ts`).
`CodeIndexer.run` trata stamp ausente ou antigo como full index e re-stampa
após o rebuild, então CLI e `LazyCodeIndex` se auto-corrigem no próximo
reconcile (aceite em `tests/indexer/code-indexer.test.ts` e
`tests/indexer/lazy-code-index.test.ts`). `doctor` mostra o par
`schema v2, extraction v1` e alerta stamp desatualizado recomendando
`cortex index` (`tests/cli/cli.test.ts`). Validado no próprio repo: o
`code.db` pré-feature veio unstamped e o `cortex index` seguinte fez
rebuild completo sem `--force`.

O banco de decisões já tem os dois eixos: `schema_version` (migrável) e o
`model_id` pinado (mismatch → re-embed, falha alto). O `code.db` só tem o
eixo de schema: se o `tsx-extractor.ts` mudar o que extrai, índices
existentes ficam stale silenciosamente.

- Adicionar uma constante `EXTRACTION_VERSION` gravada no `code.db`;
  incrementar em qualquer mudança de saída do extractor/resolver.
  Referência: codegraph `src/extraction/extraction-version.ts` e
  `isIndexStale` (`src/index.ts:1123`) — schema migra in place, versão de
  conteúdo só pode recomendar rebuild.
- Em mismatch: o `LazyCodeIndex` dispara (ou recomenda) re-index completo;
  o `doctor` reporta explicitamente.
- Já mexendo em migrations: escrever a primeira migration real de evolução
  de schema (002+ alterando tabela existente) para o caminho de upgrade do
  runner deixar de ser teórico.
- Aceite: incrementar a constante com `code.db` populado causa rebuild
  completo no próximo reconcile; `doctor` mostra o par de versões.

---

## Média prioridade

### 5. Flags de CLI: `--version`, `--help`, `--json`

**Feito (2026-07-22).** `version` no `package.json` como fonte única, exposta
por `src/version.ts` (`CORTEX_VERSION`) e usada pela CLI e pelo servidor MCP
(fim do `0.1.0` hardcoded). `--version`/`-v` e `--help`/`-h` interceptados em
`src/cli/main.ts` antes do dispatch; o usage ganhou seção `flags` e a versão
no cabeçalho. `--json` nos cinco comandos de leitura via `printJson`
(`src/cli/json.ts`): `log`/`search` serializam os resultados direto,
`impact` emite o `DecisionImpact` inteiro, `why` virou report tipado por
`matchedBy` (path/symbol/null) renderizado depois, e o `DoctorReport` passou
a acumular checks para emitir `{checks, issues}` mantendo o exit code.
Dispatch continua hand-rolled com `parseArgs`. Aceite em
`tests/cli/cli.test.ts` (flags, JSON parseável por comando, versão do MCP
igual à do pacote).

- Adicionar campo `version` ao `package.json` como fonte única da verdade;
  ler na CLI e no servidor MCP (substitui o `0.1.0` hardcoded em
  `src/mcp/server.ts:10`).
- Interceptar `--version`/`-v` e `--help`/`-h` antes do dispatch em
  `src/cli/main.ts` (o codegraph intercepta pré-parser,
  `src/bin/codegraph.ts:151`).
- Adicionar `--json` aos comandos de leitura (`log`, `search`, `why`,
  `impact`, `doctor`) para scripting e para o prompt hook (item 1).
- Manter o dispatch hand-rolled com `parseArgs` — não precisa de
  framework.

### 6. Harness de avaliação da busca

**Feito (2026-07-22), incluindo a adoção da fusão.** Harness em
`tests/evaluation/`: ground-truth com 46 perguntas PT/EN validado contra o
store versionado (`ground-truth.test.ts`), estratégias
`current`/`fts`/`vector` reusando `intentTerms`/`dot` de produção, runner
manual `bun run eval:search [--json]` com o modelo real. Evidência medida:
slot-filling 0.913 recall@5 / 0.855 MRR; BM25 puro 0.978 / 0.909 (~0.5 ms);
cosseno sem threshold 0.935 / 0.877; fusão RRF 1.000 / 0.911 — e robusta:
k∈{10,20,60,120} × threshold on/off dão todos o mesmo resultado. Fusão
adotada em produção: `SemanticSearch.search` faz RRF k=60 da perna vetorial
(threshold 0.3 mantido — query irrelevante segue vazia) com a perna BM25
(só decisões ativas), degradando para BM25 puro sem provider/timeout.
Registrada como decisão `019f8c23-56ca` substituindo `019f6dc3-e77a`;
medição pós-adoção reconfirma current = 1.000/0.911. Ressalva na decisão:
BM25 puro quase empata custando ~500× menos — se a latência do embed
(~300 ms/query) doer, medir cascata FTS-primeiro.

A decisão `019f6dc3-e77a` adiou a fusão BM25+cosseno "por falta de
evidência". Construir o gerador de evidência:

- Conjunto ground-truth: perguntas sobre as decisões já dogfooded com ids
  esperados; medir recall/MRR do híbrido atual (slot-filling via FTS) vs.
  fusão de scores.
  Referência: codegraph `__tests__/evaluation/` (scoring) e
  `scripts/agent-eval/` (rig A/B com LLM-as-judge — só se o harness de
  métrica simples se provar insuficiente).
- Critério: a fusão é adotada (ou o adiamento reconfirmado) com base em
  números medidos, registrados como nova decisão.

### 7. Daemon compartilhado para o worker de embedding

Cada sessão MCP hoje sobe seu próprio subprocess com o
EmbeddingGemma-300m. Com várias sessões de agente simultâneas no mesmo
repo, isso duplica um model load pesado por sessão.

- Topologia do codegraph: daemon destacado dono do estado pesado, proxies
  finos por cliente respondendo o handshake MCP localmente e encaminhando
  tool calls via socket Unix; colheita por refcount + idle timeout
  (`src/mcp/index.ts:17-35`, `src/mcp/daemon.ts`).
- Para o cortex o ativo compartilhável é o worker de embedding (e o cache
  de runtimes do item 2), não o handle SQLite.
- Só vale se uso multi-sessão virar rotina — medir antes.

### 8. Distribuição: binário compilado + caminho de instalação

- `bun build --compile` para gerar um executável de arquivo único; tira a
  exigência do runtime Bun da história de instalação.
- Verificar que os workarounds WASM (subprocess do `worker.ts`, download
  de gramática para `~/.cortex/`) sobrevivem à compilação — o entrypoint
  do subprocess provavelmente precisa ser embutido ou distribuído junto.
- Script de instalação mínimo vem depois; self-update/telemetria só se a
  ferramenta ganhar usuários externos.

---

## Manutenção

- [ ] Corrigir typo do model id no comentário do schema:
  `src/storage/migrations/001-decisions-schema.sql:38` diz
  `embeddinggemma-300m-q@256`, o id real é `embeddinggemma-300m-q8@256`.
- [ ] Substituir o `CLAUDE.md` genérico de boilerplate Bun (documenta
  `Bun.serve`/HTML imports que esta CLI não usa) por orientação específica
  do cortex: mapa da arquitetura, fluxo de dogfooding, convenções de
  teste.

---

## Revisão futura — adiado, reabrir só com gatilho

Avaliados explicitamente contra o codegraph e **não** adotados. Não
reabrir sem o gatilho declarado.

- **Kernel nativo em Rust, válvula de checkpoint do WAL, janelas de
  drop/recreate de índices em bulk-load.** São otimizações para indexar
  centenas de milhares de símbolos em disco lento (medições do próprio
  codegraph: rebuild de índices 2.8s→1.1s num conjunto de 224k edges;
  45s vs. 19min de comportamento do WAL em HDD). A escala do cortex — um
  store de decisões mais o índice de código de um único repo (~258ms de
  index completo, medido) — não chega perto de justificar a complexidade.
  **Gatilho para reabrir:** tempo de indexação ou throughput de escrita no
  DB virar gargalo sentido (indexação multi-repo, ordem(ns) de grandeza
  mais símbolos).

- **File watcher.** O modelo de reconciliação lazy — `LazyCodeIndex`
  reconciliando no primeiro uso via MCP mais `cortex index` manual — já
  cobre o caso de uso; um watcher traz tuning de debounce, limites de
  inotify e patologias de WSL sem ganho atual. **Meio-termo se precisar
  antes:** git hooks (post-commit/post-checkout rodando `cortex index`),
  como o codegraph faz em `src/sync/git-hooks.ts`. **Gatilho para
  reabrir:** o índice de código aparecer stale com frequência suficiente
  para causar respostas erradas de `why`/`impact` na prática.

## Fora de plano

- Infra de telemetria — ferramenta pessoal, sem frota para observar.
- Migração para commander (ou qualquer framework de CLI) — a tabela de
  dispatch com `parseArgs` é limpa e suficiente.
