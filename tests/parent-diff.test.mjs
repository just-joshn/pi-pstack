import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { saveParentDiff } from "../src/parent-diff.ts";

async function capture(t, tracked, patches) {
  const dir = await mkdtemp(join(tmpdir(), "parent-diff-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const visited = [];
  const pi = {
    exec: async (_, args) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: dir + "\n" };
      if (args[0] === "ls-files") return { code: 0, stdout: Object.keys(patches).join("\0") };
      if (!args.includes("--no-index")) return { code: 0, stdout: tracked };
      const file = args.at(-1);
      visited.push(file);
      return { code: 1, stdout: patches[file] };
    },
  };
  const { path, omitted } = await saveParentDiff(pi, dir, dir);
  return { bytes: await readFile(path), omitted, visited };
}

void test("the diff budget counts UTF-8 bytes and keeps later whole patches that fit", async (t) => {
  const text = "界".repeat(350000);
  const { bytes, omitted } = await capture(t, text, { oversized: text, small: "+ok\n" });
  assert.deepEqual(omitted, ["oversized"]);
  assert(bytes.equals(Buffer.from(text + "+ok\n")));
});

void test("a full artifact omits the remaining files without reading every patch", async (t) => {
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
