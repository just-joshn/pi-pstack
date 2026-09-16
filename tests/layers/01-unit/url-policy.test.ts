import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyIpLiteral,
  fetchFollowingSafeRedirects,
  ipv4ToInt,
  isPrivateIPv4,
  validateProbeTarget,
  type HostResolver,
  type ProbeTarget,
  type UrlPolicyOptions,
} from "../../../extensions/lib/url-policy.ts";

const NON_HTTP_URLS = [
  "file:///etc/passwd",
  "gopher://127.0.0.1/",
  "ftp://127.0.0.1/secrets",
  "ws://example.com/",
  "javascript:alert(1)",
  "data:text/html,x",
];

const PRIVATE_URLS = [
  "http://127.0.0.1:1/",
  "http://10.0.0.1/",
  "http://172.16.0.1/",
  "http://192.168.1.1/",
  "http://169.254.169.254/latest/meta-data/",
  "http://0.0.0.0/",
  "http://100.64.0.1/",
  "http://224.0.0.1/",
  "http://255.255.255.255/",
  "http://[::1]/",
  "http://[::]/",
  "http://[fc00::1]/",
  "http://[fd00::1]/",
  "http://[fe80::1]/",
  "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:10.0.0.1]/",
  "http://[64:ff9b::127.0.0.1]/",
  "http://[2001:db8::1]/",
  "http://[ff02::1]/",
  "http://[2002:7f00:1::]/",
];

const PUBLIC_URLS = [
  "http://8.8.8.8/",
  "https://1.1.1.1/",
  "http://[2606:4700:4700::1111]/",
  "http://[2001:4860:4860::8888]/",
];

const METADATA_URLS = [
  "http://metadata.google.internal/",
  "http://metadata.goog/",
  "http://service.internal/",
  "http://printer.local/",
];

const IPV4_TABLE: Array<[string, boolean]> = [
  ["0.0.0.0", true],
  ["0.255.255.255", true],
  ["10.0.0.0", true],
  ["10.255.255.255", true],
  ["100.64.0.0", true],
  ["100.127.255.255", true],
  ["127.0.0.1", true],
  ["127.255.255.255", true],
  ["169.254.0.1", true],
  ["172.16.0.0", true],
  ["172.31.255.255", true],
  ["192.168.0.0", true],
  ["192.168.255.255", true],
  ["224.0.0.1", true],
  ["240.0.0.1", true],
  ["8.8.8.8", false],
  ["1.1.1.1", false],
  ["172.32.0.1", false],
  ["100.128.0.1", false],
  ["9.255.255.255", false],
];

const IPV6_TABLE: Array<[string, "private" | "public"]> = [
  ["::", "private"],
  ["::1", "private"],
  ["fc00::1", "private"],
  ["fd00::1", "private"],
  ["fe80::1", "private"],
  ["ff02::1", "private"],
  ["::ffff:127.0.0.1", "private"],
  ["::ffff:10.0.0.1", "private"],
  ["64:ff9b::7f00:1", "private"],
  ["2001:db8::1", "private"],
  ["2002:7f00:1::", "private"],
  ["2606:4700:4700::1111", "public"],
  ["2001:4860:4860::8888", "public"],
];

function resolverFor(addresses: Record<string, string[]>): HostResolver {
  return async (hostname) => addresses[hostname] ?? [];
}

function failingResolver(): HostResolver {
  return async () => {
    throw new Error("ENOTFOUND");
  };
}

async function refusalReason(url: string, options: UrlPolicyOptions = {}): Promise<string> {
  const result = await validateProbeTarget(url, options);
  if (result.ok) throw new Error(`${url} was allowed but should be refused`);
  return result.reason;
}

async function assertAllowed(url: string, options: UrlPolicyOptions = {}): Promise<void> {
  const result = await validateProbeTarget(url, options);
  assert.equal(result.ok, true, result.ok ? "" : `${url}: ${result.reason}`);
}

async function requireTarget(url: string): Promise<ProbeTarget> {
  const result = await validateProbeTarget(url);
  if (!result.ok) throw new Error(`expected ${url} to be allowed: ${result.reason}`);
  return result.target;
}

type StubResponse = { status: number; location?: string; body?: string };

function stubRequest(responses: StubResponse[]) {
  let calls: string[] = [];
  const request = async (url: string) => {
    calls = [...calls, url];
    const index = Math.min(calls.length - 1, responses.length - 1);
    const spec = responses[index];
    return {
      status: spec.status,
      headers: {
        get: (name: string) => (name.toLowerCase() === "location" ? (spec.location ?? null) : null),
      },
      text: async () => spec.body ?? "",
    };
  };
  return { request, calls: () => calls };
}

test("url-policy refuses non-http(s) schemes", async () => {
  for (const url of NON_HTTP_URLS) {
    assert.match(await refusalReason(url), /scheme/);
  }
});

test("url-policy refuses private, loopback, and link-local literals", async () => {
  for (const url of PRIVATE_URLS) {
    assert.match(await refusalReason(url), /private, loopback, or link-local/);
  }
});

test("url-policy allows public IP literals without DNS", async () => {
  for (const url of PUBLIC_URLS) await assertAllowed(url);
});

test("url-policy refuses metadata and local-only hostnames", async () => {
  for (const url of METADATA_URLS) {
    assert.match(await refusalReason(url), /metadata or local-only/);
  }
});

test("url-policy refuses credentials and malformed input", async () => {
  assert.match(await refusalReason("http://user:pass@8.8.8.8/"), /credentials/);
  assert.match(await refusalReason("not a url"), /not a valid absolute URL/);
  assert.match(await refusalReason("   "), /non-empty string/);
  const nonString = await validateProbeTarget(42);
  assert.equal(nonString.ok, false);
});

test("ipv4 classification table covers every private range", () => {
  for (const [address, expected] of IPV4_TABLE) {
    const value = ipv4ToInt(address);
    assert.equal(value === undefined ? undefined : isPrivateIPv4(value), expected, address);
  }
});

test("ipv6 literals classify by range and embedded IPv4", () => {
  for (const [address, expected] of IPV6_TABLE) {
    assert.equal(classifyIpLiteral(address), expected, address);
  }
});

test("url-policy refuses a public name that resolves to a private address", async () => {
  const resolve = resolverFor({ "evil.example.com": ["127.0.0.1"] });
  assert.match(
    await refusalReason("http://evil.example.com/", { resolve }),
    /private, loopback, or link-local/,
  );
});

test("url-policy refuses when any resolved address is private", async () => {
  const resolve = resolverFor({ "mixed.example.com": ["8.8.8.8", "10.0.0.1"] });
  assert.match(await refusalReason("http://mixed.example.com/", { resolve }), /private/);
});

test("url-policy refuses when lookup fails or returns nothing", async () => {
  assert.match(
    await refusalReason("http://missing.example.com/", { resolve: failingResolver() }),
    /could not be resolved/,
  );
  const empty = resolverFor({ "empty.example.com": [] });
  assert.match(await refusalReason("http://empty.example.com/", { resolve: empty }), /private/);
});

test("url-policy allows an explicitly allowlisted private host", async () => {
  await assertAllowed("http://localhost:5173/", { allowHosts: ["localhost"] });
  await assertAllowed("http://127.0.0.1:3000/", { allowHosts: ["127.0.0.1"] });
});

test("url-policy keeps metadata hosts and local suffixes blocked even when allowlisted", async () => {
  assert.match(
    await refusalReason("http://metadata.google.internal/", {
      allowHosts: ["metadata.google.internal"],
    }),
    /metadata or local-only/,
  );
  assert.match(
    await refusalReason("http://printer.local/", { allowHosts: ["printer.local"] }),
    /metadata or local-only/,
  );
});

test("url-policy matches allowHosts exactly, not by suffix", async () => {
  const resolve = resolverFor({
    "evil.example.com": ["127.0.0.1"],
    "sub.evil.example.com": ["127.0.0.1"],
  });
  await assertAllowed("http://evil.example.com/", { resolve, allowHosts: ["evil.example.com"] });
  assert.match(
    await refusalReason("http://sub.evil.example.com/", {
      resolve,
      allowHosts: ["evil.example.com"],
    }),
    /private/,
  );
});

test("url-policy re-validates redirects and never requests a refused hop", async () => {
  const initial = await requireTarget("http://8.8.8.8/");
  const stub = stubRequest([
    { status: 302, location: "http://169.254.169.254/latest/meta-data/" },
  ]);
  await assert.rejects(
    () => fetchFollowingSafeRedirects(stub.request, initial),
    /redirect target refused/,
  );
  assert.deepEqual(stub.calls(), ["http://8.8.8.8/"]);
});

test("url-policy follows a redirect chain that stays public", async () => {
  const initial = await requireTarget("http://8.8.8.8/");
  const stub = stubRequest([
    { status: 302, location: "https://1.1.1.1/ok" },
    { status: 200, body: "fine" },
  ]);
  const response = await fetchFollowingSafeRedirects(stub.request, initial);
  assert.equal(response.status, 200);
  assert.deepEqual(stub.calls(), ["http://8.8.8.8/", "https://1.1.1.1/ok"]);
});

test("url-policy refuses a redirect without Location and an over-long chain", async () => {
  const initial = await requireTarget("http://8.8.8.8/");
  await assert.rejects(
    () => fetchFollowingSafeRedirects(stubRequest([{ status: 302 }]).request, initial),
    /without a Location/,
  );
  const loop = stubRequest([{ status: 302, location: "http://8.8.8.8/" }]);
  await assert.rejects(
    () => fetchFollowingSafeRedirects(loop.request, initial, { maxRedirects: 2 }),
    /refused after 2 redirects/,
  );
});
