export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function parseJson(source: string, label: string): unknown {
	try {
		return JSON.parse(source);
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		// Do not include parser errors, which can quote the input.
		throw new Error(`Invalid JSON in ${label}`);
	}
}
