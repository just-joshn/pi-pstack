import { join } from "node:path";
import { expect, test } from "vitest";
import { TEST_TOKEN, cleanupDir, startBenny, tempDir } from "./benny-helpers.mjs";

async function probe(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, retryAfter: response.headers.get("retry-after"), text };
}

function startLimitingBenny(dir, rateLimit) {
  return startBenny({
    token: TEST_TOKEN,
    configDir: dir,
    stateDir: join(dir, "state"),
    wakeFile: join(dir, "wake.jsonl"),
    rateLimit,
  });
}

test("benny caps per-client /v1 requests and sends Retry-After", async (t) => {
  const dir = tempDir("pstack-benny-hardening-");
  const benny = await startLimitingBenny(dir, { maxRequests: 3, windowMs: 60_000 });
  t.onTestFinished(async () => {
    await benny.close();
    cleanupDir(dir);
  });
  const probes = await Promise.all(
    [0, 1, 2, 3, 4].map(() =>
      probe(benny.base, "/v1/benny/events", { method: "POST", token: TEST_TOKEN }),
    ),
  );
  expect(probes.map((entry) => entry.status).toSorted()).toEqual([400, 400, 400, 429, 429]);
  const throttled = probes.filter((entry) => entry.status === 429);
  expect(throttled.every((entry) => Number(entry.retryAfter) >= 1)).toBe(true);
});

test("/healthz is exempt from the benny request cap", async (t) => {
  const dir = tempDir("pstack-benny-hardening-");
  const benny = await startLimitingBenny(dir, { maxRequests: 1, windowMs: 60_000 });
  t.onTestFinished(async () => {
    await benny.close();
    cleanupDir(dir);
  });
  const probes = await Promise.all(Array.from({ length: 6 }, () => probe(benny.base, "/healthz")));
  expect(probes.every((entry) => entry.status === 200)).toBe(true);
});
