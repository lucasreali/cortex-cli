export interface RankingScore {
	recall: number;
	reciprocalRank: number;
}

export function scoreRanking(
	expectedIds: string[],
	rankedIds: string[],
): RankingScore {
	const found = expectedIds.filter((id) => rankedIds.includes(id));
	const firstHit = rankedIds.findIndex((id) => expectedIds.includes(id));
	return {
		recall: found.length / expectedIds.length,
		reciprocalRank: firstHit === -1 ? 0 : 1 / (firstHit + 1),
	};
}

export function meanScore(scores: RankingScore[]): RankingScore {
	if (scores.length === 0) return { recall: 0, reciprocalRank: 0 };
	const sum = scores.reduce(add, { recall: 0, reciprocalRank: 0 });
	return {
		recall: sum.recall / scores.length,
		reciprocalRank: sum.reciprocalRank / scores.length,
	};
}

function add(left: RankingScore, right: RankingScore): RankingScore {
	return {
		recall: left.recall + right.recall,
		reciprocalRank: left.reciprocalRank + right.reciprocalRank,
	};
}
