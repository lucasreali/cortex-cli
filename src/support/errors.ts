export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function errnoCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}
