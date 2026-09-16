/**
 * Fixed-window per-client request limiter shared by the hosted services.
 *
 * A client is the peer address plus a SHA-256 fingerprint of the credential it
 * presented, so a raw token is never held and two tenants behind one NAT do not
 * share a bucket. The bucket table is an immutable cell: every check publishes a
 * new map instead of mutating the live one, so a rejected request never observes
 * a half-written counter.
 *
 * The table is hard-bounded to `maxBuckets` entries so a spray of distinct keys
 * cannot grow it without limit. At the bound, expired buckets are reclaimed from
 * the front and a key that holds no live bucket is refused until one expires.
 * Live buckets are never evicted: reclaiming a live counter would hand that
 * client a fresh budget inside its current window.
 *
 * The window resets on the first request at or past `resetAt`. That makes the
 * cap a hard bucket per window rather than a sliding one, which is cheap and
 * predictable for an operator.
 */
import { createHash } from "node:crypto";

export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_MAX_REQUESTS = 120;
export const DEFAULT_MAX_BUCKETS = 4096;

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** `credential` is the presented bearer token; it is hashed, never stored. */
export function clientKeyOf(req, credential) {
  const address = req.socket?.remoteAddress ?? "unknown";
  const secret = typeof credential === "string" && credential.length > 0 ? credential : "anonymous";
  const fingerprint = createHash("sha256").update(secret).digest("hex").slice(0, 16);
  return `${address}|${fingerprint}`;
}

function allowed(maxRequests, count) {
  return { allowed: true, limit: maxRequests, remaining: maxRequests - count, retryAfterSeconds: 0 };
}

function denied(maxRequests, retryAfterSeconds) {
  return { allowed: false, limit: maxRequests, remaining: 0, retryAfterSeconds };
}

function waitSeconds(buckets, at) {
  const first = buckets.entries().next();
  if (first.done) return 1;
  return Math.max(1, Math.ceil((first.value[1].resetAt - at) / 1000));
}

/** Drops the front run of closed buckets; Map order is insertion order. */
function dropExpired(buckets, at) {
  const kept = new Map(buckets);
  for (const [key, bucket] of buckets) {
    if (at < bucket.resetAt) break;
    kept.delete(key);
  }
  return kept;
}

function hasExpiredFront(buckets, at) {
  const first = buckets.entries().next();
  return !first.done && at >= first.value[1].resetAt;
}

function withFreshBucket(buckets, key, at, windowMs) {
  const next = new Map(buckets);
  next.delete(key);
  next.set(key, { count: 1, resetAt: at + windowMs });
  return next;
}

function admitFresh(buckets, key, at, windowMs, maxBuckets) {
  if (buckets.has(key)) return withFreshBucket(buckets, key, at, windowMs);
  if (buckets.size < maxBuckets) return withFreshBucket(buckets, key, at, windowMs);
  const reclaimed = hasExpiredFront(buckets, at) ? dropExpired(buckets, at) : buckets;
  return reclaimed.size < maxBuckets ? withFreshBucket(reclaimed, key, at, windowMs) : null;
}

export function createRateLimiter(options = {}) {
  const windowMs = positiveNumber(options.windowMs, DEFAULT_WINDOW_MS);
  const maxRequests = positiveInteger(options.maxRequests, DEFAULT_MAX_REQUESTS);
  const maxBuckets = positiveInteger(options.maxBuckets, DEFAULT_MAX_BUCKETS);
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  let buckets = new Map();

  function check(key) {
    const at = now();
    const existing = buckets.get(key);
    if (existing && at < existing.resetAt) {
      if (existing.count >= maxRequests) {
        return denied(maxRequests, Math.max(1, Math.ceil((existing.resetAt - at) / 1000)));
      }
      const counted = { ...existing, count: existing.count + 1 };
      buckets = new Map(buckets).set(key, counted);
      return allowed(maxRequests, counted.count);
    }
    const admitted = admitFresh(buckets, key, at, windowMs, maxBuckets);
    if (admitted === null) return denied(maxRequests, waitSeconds(buckets, at));
    buckets = admitted;
    return allowed(maxRequests, 1);
  }

  return { check, windowMs, maxRequests, maxBuckets, size: () => buckets.size };
}

/** Read the cap from the process environment so a deployed service needs no code edit. */
export function rateLimitFromEnv(env, names) {
  const maxRequests = positiveInteger(Number.parseInt(env[names.maxRequests] ?? "", 10), DEFAULT_MAX_REQUESTS);
  const windowMs = positiveInteger(Number.parseInt(env[names.windowMs] ?? "", 10), DEFAULT_WINDOW_MS);
  return { maxRequests, windowMs };
}
