import type { Message, Part } from "../ir.ts";
import { linesOf, parseState } from "./dot.ts";

const START = /@!@!@STARTMSG (\d+):(\d+) @!@!@$/;
const END = /^@!@!@ENDMSG \d+ @!@!@$/;

const isCutMarker = (lastLine: string) => lastLine.startsWith("@!@!@");

function cutMessage(open: Message[]) {
	for (let i = open.length - 1; i > 0 && !open[i]?.body.length; i--) open[i - 1]?.body.pop();
	return open[0]?.body.length ? open[0] : undefined;
}

export function* readMessages(tlcOut: string | Iterable<string>): Generator<Part> {
	const lines = linesOf(tlcOut)[Symbol.iterator]();
	const open: Message[] = [];
	try {
		for (let next = lines.next(); !next.done; ) {
			const line = next.value;
			next = lines.next();
			if (next.done && (!line || isCutMarker(line))) break;
			const start = START.exec(line);
			if (start) {
				const message: Message = { code: Number(start[1]), level: Number(start[2]), body: [] };
				if (start.index) message.beforeMarker = line.slice(0, start.index);
				open.at(-1)?.body.push(message);
				open.push(message);
			} else if (END.test(line)) {
				const done = open.pop();
				if (done && !open.length) yield done;
			} else {
				const parent = open.at(-1);
				if (parent) parent.body.push(line);
				else yield line;
			}
		}
	} finally {
		lines.return?.();
	}
	const cut = cutMessage(open);
	if (cut) yield cut;
}

export const textOf = ({ body }: Message) => body.filter((part) => typeof part === "string").join("\n");

export const actionOf = (m: Message) => /^\d+: (?:Back to state: )?<([^\s>]+)/.exec(textOf(m))?.[1];

export const messageState = (m: Message) => {
	const lines = textOf(m).split("\n");
	const body: string[] = [];
	for (const line of lines.slice(1)) {
		if (!line.trim()) break;
		body.push(line);
	}
	return parseState(body.join("\n"));
};
