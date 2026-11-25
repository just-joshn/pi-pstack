import assert from "node:assert/strict";

import { test } from "vitest";

import { pool } from "../lib/pool.ts";

test("parallel pool limits concurrency, keeps input order and isolates failures", async () => {
  let active = 0,
    peak = 0,
    calls = 0;
  const output = await pool([1, 2, 3, 4, 5], 2, async (n) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 3));
    active--;
    if (n === 3) throw Error("bad");
    return n * 2;
  });
  assert.equal(peak, 2);
  assert.equal(calls, 5);
  assert.deepEqual(
    output.map((x) => (x.status === "fulfilled" ? x.value : x.reason)),
    [2, 4, "bad", 8, 10],
  );
});
