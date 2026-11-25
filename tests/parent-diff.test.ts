import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { saveParentDiff } from "../src/parent-diff.ts";
import { double } from "./support.ts";

const ran = (code: number, stdout: string) => ({
  code,
  stdout,
  stderr: "",
  killed: false,
  truncated: false,
});

async function capture(t: TestContext, tracked: string, patches: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "parent-diff-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const visited: string[] = [];
  const pi = double<ExtensionAPI>({
    exec: async (_command, args) => {
      if (args[0] === "rev-parse") return ran(0, dir + "\n");
      if (args[0] === "ls-files") return ran(0, Object.keys(patches).join("\0"));
      if (!args.includes("--no-index")) return ran(0, tracked);
      const file = args.at(-1) ?? "";
      visited.push(file);
      return ran(1, patches[file] ?? "");
    },
  });
  const diff = await saveParentDiff(pi, dir, dir);
  assert(diff);
  return { bytes: await readFile(diff.path), omitted: diff.omitted, visited };
}

await describe("parent diff", async () => {
  await test("the diff budget counts UTF-8 bytes and keeps later whole patches that fit", async (t) => {
    const text = "界".repeat(350000);
    const { bytes, omitted } = await capture(t, text, {
      small: "+ok\n",
      oversized: text,
      later: "+end\n",
    });
    assert.deepEqual(omitted, ["oversized"]);
    assert(bytes.equals(Buffer.from(text + "+ok\n+end\n")));
  });
  await test("a full artifact omits the remaining files without reading every patch", async (t) => {
    const patch = "x".repeat(256 * 1024);
    const files = Array.from({ length: 32 }, (_, i) => `file${i}`);
    const { bytes, omitted, visited } = await capture(
      t,
      "",
      Object.fromEntries(files.map((file) => [file, patch])),
    );
    assert.equal(bytes.length, 2 * 1024 * 1024);
    assert.deepEqual(omitted, files.slice(8));
    assert(visited.length < files.length);
  });
});
