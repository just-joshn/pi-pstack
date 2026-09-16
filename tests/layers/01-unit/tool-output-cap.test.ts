import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { capToolOutput } from "../../../extensions/lib/tool-output.ts";

const CAP = 51200;
const TRAILER = "\n\n[Output truncated:";

const BODIES: Record<string, string> = {
  "60KB single-line ascii": "a".repeat(60000),
  "astral emoji single line": "\u{1F600}".repeat(20000),
  "near-cap multi-line": Array.from(
    { length: 1200 },
    (_unused, index) => `line-${String(index).padStart(4, "0")}-${"y".repeat(40)}`,
  ).join("\n"),
  "one byte over the cap": "b".repeat(CAP + 1),
};

const SINGLE_LINE = new Set(["60KB single-line ascii", "astral emoji single line", "one byte over the cap"]);

function frameOf(text: string): { content: string; trailer: string } {
  const at = text.indexOf(TRAILER);
  return { content: text.slice(0, at), trailer: text.slice(at) };
}

for (const keep of ["head", "tail"] as const) {
  for (const [name, body] of Object.entries(BODIES)) {
    test(`capToolOutput keeps ${name} within ${CAP} bytes (${keep})`, () => {
      const out = capToolOutput(body, { keep, label: `cap-${keep}` });
      const bytes = Buffer.byteLength(out.text, "utf8");
      assert.equal(out.truncated, true);
      assert.ok(bytes <= CAP, `${name}/${keep} returned ${bytes} bytes against the ${CAP}-byte cap`);
      assert.ok(
        bytes >= (SINGLE_LINE.has(name) ? CAP - 8 : CAP - 64),
        `${name}/${keep} returned ${bytes} bytes and left the budget unfilled`,
      );
      const { content, trailer } = frameOf(out.text);
      assert.ok(trailer.startsWith(TRAILER), `${name}/${keep} lost the truncation trailer`);
      assert.equal(typeof out.outputPath, "string");
      assert.ok(
        trailer.includes(out.outputPath as string),
        `${name}/${keep} trailer does not name the full-output file`,
      );
      assert.equal(readFileSync(out.outputPath as string, "utf8"), body);
      assert.equal(content.includes("\uFFFD"), false, `${name}/${keep} split a UTF-8 sequence`);
    });
  }
}

test("capToolOutput fills the byte budget exactly when the body is ascii", () => {
  const out = capToolOutput("a".repeat(60000), { keep: "head", label: "cap-exact" });
  assert.equal(Buffer.byteLength(out.text, "utf8"), CAP);
});

test("capToolOutput returns a body at or under the cap untouched", () => {
  assert.deepEqual(capToolOutput("small", { keep: "head", label: "cap-small" }), {
    text: "small",
    truncated: false,
  });
  const exact = "c".repeat(CAP);
  assert.deepEqual(capToolOutput(exact, { keep: "head", label: "cap-exact-ok" }), {
    text: exact,
    truncated: false,
  });
});
