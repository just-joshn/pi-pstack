/**
 * URL trust policy for the control-ui probe.
 *
 * The validated thing is not a string: it is a parsed target carrying a trust
 * class. A scheme check alone misses `169.254.169.254`; a hostname check alone
 * misses `evil.example.com` that resolves to loopback. Committing a request is
 * gated on the scheme, the host classification, every resolved address, and
 * every redirect hop.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type HostClass = "public" | "private";

export type ProbeTarget = {
  readonly url: URL;
  readonly hostname: string;
  readonly addresses: readonly string[];
  readonly hostClass: HostClass;
  readonly allowlisted: boolean;
};

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export type UrlPolicyOptions = {
  readonly allowHosts?: readonly string[];
  readonly resolve?: HostResolver;
};

export type UrlPolicyResult =
  | { readonly ok: true; readonly target: ProbeTarget }
  | { readonly ok: false; readonly reason: string };

export type ResponseLike = {
  readonly status: number;
  readonly headers?: { readonly get?: (name: string) => string | null };
};

export type RedirectRequest<T extends ResponseLike> = (
  url: string,
  init: { readonly method: string; readonly signal?: AbortSignal | null; readonly redirect: "manual" },
) => Promise<T>;

export type RedirectOptions = UrlPolicyOptions & {
  readonly method?: string;
  readonly signal?: AbortSignal | null;
  readonly maxRedirects?: number;
};

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = Object.freeze([301, 302, 303, 307, 308]);

const METADATA_HOSTNAMES = Object.freeze(["metadata.google.internal", "metadata.goog"]);
const PRIVATE_SUFFIXES = Object.freeze([".internal", ".local"]);

const PRIVATE_V4_RANGES: readonly (readonly [number, number])[] = Object.freeze([
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0a80000, 16],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
]);

function parseIPv4Octets(text: string): readonly [number, number, number, number] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
  const valid = [a, b, c, d].every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
  return valid ? [a, b, c, d] : undefined;
}

export function ipv4ToInt(address: string): number | undefined {
  const octets = parseIPv4Octets(address);
  if (octets === undefined) return undefined;
  const [a, b, c, d] = octets;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function inRange(value: number, base: number, bits: number): boolean {
  const shift = 32 - bits;
  return value >>> shift === base >>> shift;
}

export function isPrivateIPv4(value: number): boolean {
  return PRIVATE_V4_RANGES.some(([base, bits]) => inRange(value, base, bits));
}

function parseHextet(part: string): number | undefined {
  return /^[0-9a-f]{1,4}$/i.test(part) ? Number.parseInt(part, 16) : undefined;
}

function expandGroups(text: string): number[] | undefined {
  if (text === "") return [];
  const parts = text.split(":");
  let groups: number[] = [];
  for (const [index, part] of parts.entries()) {
    const isLast = index === parts.length - 1;
    if (isLast && part.includes(".")) {
      const quad = parseIPv4Octets(part);
      if (quad === undefined) return undefined;
      const [a, b, c, d] = quad;
      groups = [...groups, (a << 8) | b, (c << 8) | d];
      continue;
    }
    const value = parseHextet(part);
    if (value === undefined) return undefined;
    groups = [...groups, value];
  }
  return groups;
}

export function parseIPv6(text: string): number[] | undefined {
  const zone = text.indexOf("%");
  const bare = (zone >= 0 ? text.slice(0, zone) : text).toLowerCase();
  if (!bare.includes(":")) return undefined;
  const doubleIndex = bare.indexOf("::");
  if (doubleIndex >= 0 && bare.indexOf("::", doubleIndex + 2) >= 0) return undefined;
  const head = doubleIndex >= 0 ? bare.slice(0, doubleIndex) : bare;
  const tail = doubleIndex >= 0 ? bare.slice(doubleIndex + 2) : "";
  const headGroups = expandGroups(head);
  const tailGroups = expandGroups(tail);
  if (headGroups === undefined || tailGroups === undefined) return undefined;
  const missing = 8 - headGroups.length - tailGroups.length;
  if (doubleIndex < 0 && missing !== 0) return undefined;
  if (doubleIndex >= 0 && missing < 1) return undefined;
  const groups = [
    ...headGroups,
    ...Array.from({ length: missing }, () => 0),
    ...tailGroups,
  ];
  return groups.flatMap((group) => [(group >> 8) & 0xff, group & 0xff]);
}

function bytesAreZero(bytes: readonly number[], start: number, end: number): boolean {
  return bytes.slice(start, end).every((byte) => byte === 0);
}

function embeddedIPv4(bytes: readonly number[]): number | undefined {
  const mapped = bytesAreZero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = bytesAreZero(bytes, 0, 12);
  const nat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytesAreZero(bytes, 4, 12);
  if (!mapped && !compatible && !nat64) return undefined;
  const tail = bytes.slice(12, 16);
  const [b12, b13, b14, b15] = tail;
  if (b12 === undefined || b13 === undefined || b14 === undefined || b15 === undefined) return undefined;
  return (b12 * 0x1000000 + b13 * 0x10000 + b14 * 0x100 + b15) >>> 0;
}

function isSpecial2001(bytes: readonly number[]): boolean {
  if (bytes[0] !== 0x20 || bytes[1] !== 0x01) return false;
  const third = bytes[2];
  if (third === 0x0d && bytes[3] === 0xb8) return true;
  if (third === 0x00 && (bytes[3] === 0x00 || bytes[3] === 0x02)) return true;
  return third === 0x10 || third === 0x20;
}

export function classifyIPv6(bytes: readonly number[]): HostClass {
  if (bytes.length !== 16) return "private";
  const first = bytes[0];
  const second = bytes[1];
  if (first === undefined || second === undefined) return "private";
  if ((first & 0xfe) === 0xfc) return "private";
  if (first === 0xfe && (second & 0xc0) === 0x80) return "private";
  if (first === 0xff) return "private";
  const embedded = embeddedIPv4(bytes);
  if (embedded !== undefined) return isPrivateIPv4(embedded) ? "private" : "public";
  if (isSpecial2001(bytes)) return "private";
  if (first === 0x20 && second === 0x02) return "private";
  return (first & 0xe0) === 0x20 ? "public" : "private";
}

export function classifyIpLiteral(host: string): HostClass | undefined {
  const version = isIP(host);
  if (version === 4) {
    const value = ipv4ToInt(host);
    return value === undefined || isPrivateIPv4(value) ? "private" : "public";
  }
  if (version === 6) {
    const bytes = parseIPv6(host);
    return bytes === undefined ? "private" : classifyIPv6(bytes);
  }
  return undefined;
}

export function isMetadataHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return METADATA_HOSTNAMES.includes(host) || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export function normalizedHostname(url: URL): string {
  const host = url.hostname.toLowerCase();
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.includes(status);
}

async function defaultResolver(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function parseHttpUrl(raw: string): { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `'${raw}' is not a valid absolute URL` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `scheme '${url.protocol}' is not http or https` };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "url credentials are not allowed" };
  }
  return { ok: true, url };
}

async function classifyHostname(
  hostname: string,
  resolve: HostResolver,
): Promise<{ readonly addresses: readonly string[]; readonly hostClass: HostClass }> {
  const literal = classifyIpLiteral(hostname);
  if (literal !== undefined) return { addresses: [hostname], hostClass: literal };
  const addresses = await resolve(hostname);
  if (addresses.length === 0) return { addresses, hostClass: "private" };
  const hostClass = addresses.some((address) => classifyIpLiteral(address) !== "public")
    ? "private"
    : "public";
  return { addresses, hostClass };
}

export async function validateProbeTarget(
  raw: unknown,
  options: UrlPolicyOptions = {},
): Promise<UrlPolicyResult> {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "url must be a non-empty string" };
  }
  const parsed = parseHttpUrl(raw);
  if (!parsed.ok) return parsed;
  const hostname = normalizedHostname(parsed.url);
  if (isMetadataHostname(hostname)) {
    return { ok: false, reason: `host '${hostname}' is a metadata or local-only host` };
  }
  const allowHosts = (options.allowHosts ?? []).map((host) => host.toLowerCase());
  if (allowHosts.includes(hostname)) {
    return {
      ok: true,
      target: { url: parsed.url, hostname, addresses: [], hostClass: "public", allowlisted: true },
    };
  }
  try {
    const { addresses, hostClass } = await classifyHostname(hostname, options.resolve ?? defaultResolver);
    if (hostClass !== "public") {
      return { ok: false, reason: `host '${hostname}' is a private, loopback, or link-local target` };
    }
    return { ok: true, target: { url: parsed.url, hostname, addresses, hostClass, allowlisted: false } };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `host '${hostname}' could not be resolved (${detail})` };
  }
}

function readLocation(response: ResponseLike): string | undefined {
  const value = response.headers?.get?.("location");
  return value == null || value === "" ? undefined : value;
}

export async function fetchFollowingSafeRedirects<T extends ResponseLike>(
  request: RedirectRequest<T>,
  initial: ProbeTarget,
  options: RedirectOptions = {},
): Promise<T> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const method = options.method ?? "GET";
  let target = initial;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await request(target.url.toString(), { method, signal: options.signal ?? null, redirect: "manual" });
    if (!isRedirectStatus(response.status)) return response;
    const location = readLocation(response);
    if (location === undefined) throw new Error(`redirect ${response.status} without a Location header`);
    const nextRaw = new URL(location, target.url).toString();
    const next = await validateProbeTarget(nextRaw, options);
    if (!next.ok) throw new Error(`redirect target refused: ${next.reason}`);
    target = next.target;
  }
  throw new Error(`refused after ${maxRedirects} redirects`);
}
