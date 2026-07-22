import type { Decision } from "@/domain";
import type { NodeRepository } from "@/storage/node-repository";
import type {
	SearchColumn,
	SearchRepository,
} from "@/storage/search-repository";

export interface PromptGateStore {
	nodes: NodeRepository;
	fts: SearchRepository;
}

export type PromptGate =
	| { tier: "high" | "medium"; decisions: Decision[] }
	| { tier: "none" };

const MAX_TERMS = 24;
const MAX_HIGH_DECISIONS = 3;
const MAX_MEDIUM_DECISIONS = 5;
const OVERSCAN = 4;

// Tiers are precision-first: a false injection costs trust on every
// unrelated prompt, a miss costs nothing (the agent can still call
// get_context). Curated keywords (min 5 per decision, PT+EN) are the
// store's declared vocabulary — a prompt term landing there is the strong
// signal. A title hit is weaker: worth naming, not worth injecting bodies.
// Body text never gates — it is prose, and sharing one word with any
// decision body would fire the hook on nearly every prompt.
export function gatePrompt(store: PromptGateStore, prompt: string): PromptGate {
	const terms = promptTerms(prompt);
	if (terms.length === 0) return { tier: "none" };
	const strong = matchColumn(store, "keywords", terms, MAX_HIGH_DECISIONS);
	if (strong.length > 0) return { tier: "high", decisions: strong };
	const weak = matchColumn(store, "title", terms, MAX_MEDIUM_DECISIONS);
	if (weak.length > 0) return { tier: "medium", decisions: weak };
	return { tier: "none" };
}

export function promptTerms(prompt: string): string[] {
	const terms = new Map<string, string>();
	for (const token of tokenize(prompt)) {
		if (terms.size === MAX_TERMS) break;
		if (token.length < 3) continue;
		const folded = fold(token);
		if (STOPWORDS.has(folded) || terms.has(folded)) continue;
		terms.set(folded, token);
	}
	return [...terms.values()];
}

function matchColumn(
	store: PromptGateStore,
	column: SearchColumn,
	terms: string[],
	limit: number,
): Decision[] {
	return store.fts
		.searchColumn(column, terms, limit * OVERSCAN)
		.flatMap((hit) => activeDecision(store.nodes, hit.nodeId))
		.slice(0, limit);
}

function activeDecision(nodes: NodeRepository, nodeId: string): Decision[] {
	const node = nodes.getById(nodeId);
	if (node?.status !== "active") return [];
	return [node];
}

function tokenize(prompt: string): string[] {
	return prompt.toLowerCase().split(/[^\p{L}\p{N}]+/u);
}

function fold(term: string): string {
	return term.normalize("NFD").replace(/\p{M}+/gu, "");
}

// Folded (diacritic-stripped) PT/EN function words, generic task verbs and
// prompt furniture ("passo 2", "esse arquivo"). Topical nouns stay out even
// when common ("erro", "teste"): if the store curates them as keywords,
// matching them is the point.
const STOPWORDS = new Set(
	`agora ainda algo alguem algum alguma algumas alguns antes aqui assim ate
	bem cada com como contra dela delas dele deles depois desde dessa desse
	desta deste deve devem deveria disso ela elas ele eles enquanto entao
	entre era eram essa essas esse esses esta estao estas este estes estou
	faca faz fazendo fazer fez ficou foi for foram isso isto mais mas melhor
	mesma mesmo meu meus minha minhas muito muitos nao nas nem nessa nesse
	nesta neste nos nossa nosso num numa onde outra outras outro outros para
	pela pelo pode podem poderia pois por porque posso pra precisa preciso
	primeiro qual quais qualquer quando quanto que quem quer queria quero sao
	sem sempre sendo ser sera seria seu seus sobre sou sua suas tambem tem
	tenho ter teve tinha toda todas todo todos tudo uma umas uns vai vamos
	vao vez voce vou
	about above after again all also and any are back because been before
	being below between both but can cannot could did does doing done down
	during each else ever every few first for from get gets got had has have
	having her here him his how into its just keep let lets like made make
	makes making many may maybe might more most much must need needs never
	new next not now off once one only onto other others our out over own
	per please same she should since some still such than that the their
	them then there these they this those through too two under until upon
	very want wants was way well were what when where which while who whose
	why will with without would yes yet you your
	add added adding adicionando adicionar adicione alterar altere arquivo
	arquivos change changed changes changing code codigo codigos corrija
	corrigir create criar crie execute executar file files fix fixed fixing
	funciona funcionam funcionar implement implementar implemente item itens
	items mudar mude passo passos project projeto projetos remova remove
	remover roda rodar rode run running step steps usando usar use used
	using work working works`
		.trim()
		.split(/\s+/),
);
