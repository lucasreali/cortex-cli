export function tildify(path: string, home: string): string {
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
