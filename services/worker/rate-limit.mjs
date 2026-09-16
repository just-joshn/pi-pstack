/**
 * Fixed-window per-client request limiter shared by the hosted services.
 *
 * A client is the peer address plus a SHA-256 fingerprint of the credential it
 * presented, so a raw token is never held and two tenants behind one NAT do not
 * share a bucket. The bucket table is an immutable cell: every check publishes a
 * new map instead of mutating the live one, so a rejected request never observes
 * a half-written counter. Expired buckets are swept once the table crosses a
 * bound so a spray of distinct keys cannot grow it without limit.
 *
 * The window resets on the first request at or past `resetAt`. That makes the
 * cap a hard bucket per window rather than a sliding one, which is cheap and
 * predictable for an operator.
 */
import { createHash } from "node:crypto";

export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_MAX_REQUESTS = 120;
const SWEEP_THRESHOLD = 4096;

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

function sweepExpired(buckets, at) {
  return new Map([...buckets].filter(([_key, bucket]) => at < bucket.resetAt));
}

export function createRateLimiter(options = {}) {
  const windowMs = positiveNumber(options.windowMs, DEFAULT_WINDOW_MS);
  const maxRequests = positiveInteger(options.maxRequests, DEFAULT_MAX_REQUESTS);
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  let buckets = new Map();

  function check(key) {
    const at = now();
    const existing = buckets.get(key);
    if (!existing || at >= existing.resetAt) {
      const fresh = { count: 1, resetAt: at + windowMs };
      buckets = new Map(buckets).set(key, fresh);
      return { allowed: true, limit: maxRequests, remaining: maxRequests - 1, retryAfterSeconds: 0 };
    }
    if (existing.count >= maxRequests) {
      return {
        allowed: false,
        limit: maxRequests,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - at) / 1000)),
      };
    }
    const counted = { ...existing, count: existing.count + 1 };
    const grown = new Map(buckets).set(key, counted);
    buckets = grown.size > SWEEP_THRESHOLD ? sweepExpired(grown, at) : grown;
    return { allowed: true, limit: maxRequests, remaining: maxRequests - counted.count, retryAfterSeconds: 0 };
  }

  return { check, windowMs, maxRequests, size: () => buckets.size };
}

/** Read the cap from the process environment so a deployed service needs no code edit. */
export function rateLimitFromEnv(env, names) {
  const maxRequests = positiveInteger(Number.parseInt(env[names.maxRequests] ?? "", 10), DEFAULT_MAX_REQUESTS);
  const windowMs = positiveInteger(Number.parseInt(env[names.windowMs] ?? "", 10), DEFAULT_WINDOW_MS);
  return { maxRequests, windowMs };
}
