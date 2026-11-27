import { extname, isAbsolute } from "node:path";

export function piCommand(bin: string, args: string[]): [file: string, args: string[]] {
	if (isAbsolute(bin) && /^(?:\.cjs|\.mjs|\.js)$/i.test(extname(bin))) return [process.execPath, ["--", bin, ...args]];
	return [bin, args];
}
