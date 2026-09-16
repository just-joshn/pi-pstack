import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_BUCKETS, createRateLimiter } from "../../../services/worker/rate-limit.mjs";

test("createRateLimiter keeps the table at or below the bound under a spray of distinct keys", () => {
  const limiter = createRateLimiter();
  let allowed = 0;
  for (let index = 0; index < DEFAULT_MAX_BUCKETS * 5; index = index + 1) {
    if (limiter.check(`spray-${index}`).allowed) allowed = allowed + 1;
  }
  assert.ok(limiter.size() <= DEFAULT_MAX_BUCKETS, `table grew to ${limiter.size()}`);
  assert.equal(limiter.size(), DEFAULT_MAX_BUCKETS);
  assert.equal(allowed, DEFAULT_MAX_BUCKETS);
});

test("createRateLimiter reclaims expired buckets at the bound and refuses new keys while it is full", () => {
  let at = 0;
  const limiter = createRateLimiter({ maxRequests: 5, windowMs: 10, maxBuckets: 8, now: () => at });
  for (let index = 0; index < 8; index = index + 1) {
    at = index;
    assert.equal(limiter.check(`live-${index}`).allowed, true);
  }
  assert.equal(limiter.size(), 8);
  at = 8;
  assert.deepEqual(limiter.check("refused"), { allowed: false, limit: 5, remaining: 0, retryAfterSeconds: 1 });
  assert.equal(limiter.size(), 8);
  at = 10;
  assert.equal(limiter.check("reclaimed").allowed, true);
  assert.equal(limiter.size(), 8);
});

test("createRateLimiter still rejects a client at its limit after a spray of other keys", () => {
  let at = 0;
  const limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000, maxBuckets: 64, now: () => at });
  assert.equal(limiter.check("client").allowed, true);
  assert.equal(limiter.check("client").allowed, true);
  assert.equal(limiter.check("client").allowed, false);
  for (let index = 0; index < 5000; index = index + 1) {
    at = index + 1;
    limiter.check(`spray-${index}`);
  }
  assert.deepEqual(limiter.check("client"), { allowed: false, limit: 2, remaining: 0, retryAfterSeconds: 55 });
  assert.ok(limiter.size() <= 64, `table grew to ${limiter.size()}`);
});
