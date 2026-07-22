function supportsColor(stream: { isTTY?: boolean }): boolean {
	if (process.env.NO_COLOR) return false;
	if (process.env.FORCE_COLOR) return true;
	return stream.isTTY === true;
}

function createPalette(enabled: boolean) {
	const wrap = (code: string) => (text: string) =>
		enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
	return {
		bold: wrap("1"),
		dim: wrap("2"),
		red: wrap("31"),
		green: wrap("32"),
		yellow: wrap("33"),
		magenta: wrap("35"),
		cyan: wrap("36"),
	};
}

export const style = createPalette(supportsColor(process.stdout));

const stderrStyle = createPalette(supportsColor(process.stderr));

export function success(message: string): string {
	return `${style.green("✓")} ${message}`;
}

export function warning(message: string): string {
	return `${style.yellow("⚠")} ${message}`;
}

export function failure(message: string): string {
	return `${stderrStyle.red("✗")} ${message}`;
}
