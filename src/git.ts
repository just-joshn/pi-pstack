import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { fail } from "./support.ts";

export function gitIn(pi: ExtensionAPI, cwd: string, signal?: AbortSignal, maxBuffer = 4 * 1024 * 1024) {
	async function probe(args: string[], at = cwd, limit = maxBuffer) {
		const r = await pi.exec("git", args, {
			cwd: at,
			timeout: 30000,
			maxBuffer: limit,
			...(signal && { signal }),
		});
		return r.truncated || r.killed ? undefined : r;
	}
	async function run(args: string[], at = cwd) {
		const r = await probe(args, at);
		if (!r) fail(`git ${args[0]} failed: output truncated or process stopped`);
		if (r.code !== 0) fail(`git ${args[0]} failed: ${r.stderr}`);
		return r.stdout;
	}
	return { probe, run };
}
export type Git = ReturnType<typeof gitIn>;
