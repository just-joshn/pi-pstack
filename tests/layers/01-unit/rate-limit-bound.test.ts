import { expect, test } from "vitest";
import { DEFAULT_MAX_BUCKETS, createRateLimiter } from "../../../services/worker/rate-limit.mjs";

test("createRateLimiter keeps the table at or below the bound under a spray of distinct keys", () => {
  const limiter = createRateLimiter();
  let allowed = 0;
  for (let index = 0; index < DEFAULT_MAX_BUCKETS * 5; index = index + 1) {
    if (limiter.check(`spray-${index}`).allowed) allowed = allowed + 1;
  }
  expect(limiter.size() <= DEFAULT_MAX_BUCKETS, `table grew to ${limiter.size()}`).toBeTruthy();
  expect(limiter.size()).toBe(DEFAULT_MAX_BUCKETS);
  expect(allowed).toBe(DEFAULT_MAX_BUCKETS);
});

test("createRateLimiter reclaims expired buckets at the bound and refuses new keys while it is full", () => {
  let at = 0;
  const limiter = createRateLimiter({ maxRequests: 5, windowMs: 10, maxBuckets: 8, now: () => at });
  for (let index = 0; index < 8; index = index + 1) {
    at = index;
    expect(limiter.check(`live-${index}`).allowed).toBe(true);
  }
  expect(limiter.size()).toBe(8);
  at = 8;
  expect(limiter.check("refused")).toEqual({ allowed: false, limit: 5, remaining: 0, retryAfterSeconds: 1 });
  expect(limiter.size()).toBe(8);
  at = 10;
  expect(limiter.check("reclaimed").allowed).toBe(true);
  expect(limiter.size()).toBe(8);
});

test("createRateLimiter still rejects a client at its limit after a spray of other keys", () => {
  let at = 0;
  const limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000, maxBuckets: 64, now: () => at });
  expect(limiter.check("client").allowed).toBe(true);
  expect(limiter.check("client").allowed).toBe(true);
  expect(limiter.check("client").allowed).toBe(false);
  for (let index = 0; index < 5000; index = index + 1) {
    at = index + 1;
    limiter.check(`spray-${index}`);
  }
  expect(limiter.check("client")).toEqual({ allowed: false, limit: 2, remaining: 0, retryAfterSeconds: 55 });
  expect(limiter.size() <= 64, `table grew to ${limiter.size()}`).toBeTruthy();
});
