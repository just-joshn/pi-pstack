import type * as fs from "node:fs/promises";
import { basename } from "node:path";
import { expect, test, vi } from "vitest";
import { host, notARepository, readResult } from "./host.ts";

const { opened, publish, started } = vi.hoisted(() => ({
	opened: Promise.withResolvers<void>(),
	publish: Promise.withResolvers<void>(),
	started: Promise.withResolvers<void>(),
}));

const workerTemporary = (path: unknown) =>
	typeof path === "string" && basename(path).startsWith("worker.json.") && path.endsWith(".tmp");

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		async writeFile(...args: Parameters<typeof fs.writeFile>) {
			const [path, , options] = args;
			if (typeof path === "string" && basename(path) === "worker.json") {
				await actual.writeFile(path, "", options);
				opened.resolve();
				await publish.promise;
			}
			return actual.writeFile(...args);
		},
		async open(...args: Parameters<typeof fs.open>) {
			const file = await actual.open(...args);
			if (workerTemporary(args[0])) {
				opened.resolve();
				await publish.promise;
			}
			return file;
		},
		async stat(...args: Parameters<typeof fs.stat>) {
			if (workerTemporary(args[0])) {
				publish.resolve();
				await started.promise;
			}
			return actual.stat(...args);
		},
	};
});

test("listing workers tolerates a record being published during the scan", async () => {
	const h = host({
		execute: async (bin) => {
			if (bin === "git") return notARepository;
			started.resolve();
			return { code: 0, stdout: "report", stderr: "" };
		},
	});
	await h.call("pstack_delegate", { mode: "single", tasks: ["review"], background: true });
	await opened.promise;
	const list = async () => readResult(await h.call("pstack_workers", { action: "list" }));
	try {
		await expect(list()).resolves.toEqual([expect.objectContaining({ id: expect.any(String) })]);
	} finally {
		publish.resolve();
		await started.promise;
	}
	await expect(list()).resolves.toEqual([expect.objectContaining({ model: expect.any(String) })]);
});
