import { describe, expect, test } from "bun:test";
import { compileSafeRegex, regexMatchesLine } from "./regex-safety.js";

describe("bounded regular expressions", () => {
  test("accepts simple literal and one-repetition notifications", () => {
    expect(regexMatchesLine(compileSafeRegex("^READY.*$", "Await regex"), "READY now")).toBe(true);
    expect(() => compileSafeRegex("READY", "Shell output_notification")).not.toThrow();
  });

  test("rejects nested and adjacent quantifiers", () => {
    expect(() => compileSafeRegex("(a+)+$", "Await regex")).toThrow("nested unbounded quantifiers");
    expect(() => compileSafeRegex("a*a*", "Await regex")).toThrow("adjacent unbounded quantifiers");
    expect(() => compileSafeRegex("(a{0,4}){0,4}", "Await regex")).toThrow("nested quantifiers");
    expect(() => compileSafeRegex("a{0,4}a{0,4}", "Await regex")).toThrow("adjacent quantified atoms");
  });

  test("rejects repeated alternatives, backreferences, and excessive bounds", () => {
    expect(() => compileSafeRegex("(a|aa)+$", "Await regex")).toThrow("alternation groups");
    expect(() => compileSafeRegex("(a)\\1", "Await regex")).toThrow("backreferences");
    expect(() => compileSafeRegex("a{4097}", "Await regex")).toThrow("cannot exceed 4096");
  });

  test("scans no more than 4 KB of each output line", () => {
    const pattern = compileSafeRegex("^.{4096}READY$", "Await regex");
    expect(pattern.test("x".repeat(4096) + "READY")).toBe(true);
    expect(regexMatchesLine(pattern, "x".repeat(4096) + "READY")).toBe(false);
  });
});
