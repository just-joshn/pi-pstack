/**
 * Pure deslop scan/apply helpers (no ExtensionAPI / typebox).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export type Severity = "high" | "medium" | "low";

export interface SlopPattern {
  re: RegExp;
  label: string;
  severity: Severity;
  /** If true, match against "+"-prefixed unified-diff line form. */
  lineAnchored?: boolean;
  /** Safe to auto-delete the whole added line when applySafe. */
  safeDelete?: boolean;
  /** Structured suggestion verb. */
  suggestion: "delete-line" | "rewrite-prose" | "remove-emoji" | "tighten-type";
}

export const SLOP_PATTERNS: SlopPattern[] = [
  {
    re: /\b(?:Just|Simply|Easily|Basically|Clearly|Obviously)\b/g,
    label: "hedge/filler adverb",
    severity: "medium",
    suggestion: "rewrite-prose",
  },
  { re: /—/g, label: "long-dash character (unslop)", severity: "medium", suggestion: "rewrite-prose" },
  {
    re: /\/\/\s*(?:Phase|Step|NOTE|TODO|IMPORTANT|FIXME|do not remove)/gi,
    label: "narration / alibi comment",
    severity: "high",
    suggestion: "delete-line",
    safeDelete: true,
  },
  {
    re: /\b(?:in order to|due to the fact|it should be noted|it is worth noting)\b/gi,
    label: "inflated prose",
    severity: "medium",
    suggestion: "rewrite-prose",
  },
  {
    re: /\b(?:leverage|utilize|facilitate|robust|seamless|comprehensive|delve|tapestry)\b/gi,
    label: "AI filler lexicon",
    severity: "high",
    suggestion: "rewrite-prose",
  },
  {
    re: /\b(?:Note that|This ensures that|This allows us to|In this section)\b/g,
    label: "throat-clearing prose",
    severity: "medium",
    suggestion: "rewrite-prose",
  },
  {
    re: /console\.(?:log|debug|info)\(/g,
    label: "debug console in diff",
    severity: "high",
    suggestion: "delete-line",
  },
  {
    re: /^\+\s*\/\/\s*[=-]{3,}/gm,
    label: "banner/separator comment",
    severity: "high",
    lineAnchored: true,
    suggestion: "delete-line",
    safeDelete: true,
  },
  {
    re: /^\+\s*\/\*\s*=+/gm,
    label: "banner block comment",
    severity: "high",
    lineAnchored: true,
    suggestion: "delete-line",
    safeDelete: true,
  },
  {
    re: /^\+\s*#\s*(?:TODO|FIXME|XXX|HACK)\b/gim,
    label: "hash alibi comment",
    severity: "medium",
    lineAnchored: true,
    suggestion: "delete-line",
    safeDelete: true,
  },
  {
    re: /\b(?:as an AI|I hope this helps|Let me know if)\b/gi,
    label: "assistant leftovers",
    severity: "high",
    suggestion: "rewrite-prose",
  },
  {
    re: /(?:✅|❌|🚀|✨|💡|🎉)/g,
    label: "emoji noise in code/prose",
    severity: "low",
    suggestion: "remove-emoji",
    safeDelete: false,
  },
  {
    re: /^\+\s*\/\/\s*$/gm,
    label: "empty comment line",
    severity: "low",
    lineAnchored: true,
    suggestion: "delete-line",
    safeDelete: true,
  },
  {
    re: /\/\*\s*eslint-disable\s*\*\//g,
    label: "blanket eslint-disable",
    severity: "medium",
    suggestion: "delete-line",
  },
  { re: /:\s*any\b/g, label: "TypeScript any in added lines", severity: "medium", suggestion: "tighten-type" },
  // Extra depth beyond Stage-2 counts
  {
    re: /^\+\s*\/\/\s*(?:Import|Export|Define|Create|Return|Handle|Check|Update|Get|Set)\b/gim,
    label: "narrating verb comment",
    severity: "high",
    lineAnchored: true,
    suggestion: "delete-line",
    safeDelete: true,
  },
  {
    re: /^\+\s*\/\/\s*[A-Z][^.]{0,60}\.\s*$/gm,
    label: "full-sentence comment",
    severity: "medium",
    lineAnchored: true,
    suggestion: "delete-line",
    safeDelete: true,
  },
  {
    re: /^\+\s*\/\/\s*(?:Helper|Utility|Wrapper|Hack|Temporary|WIP)\b/gim,
    label: "redundant helper/WIP comment",
    severity: "medium",
    lineAnchored: true,
    suggestion: "delete-line",
    safeDelete: true,
  },
  {
    re: /\b(?:basically|literally|actually|essentially)\b/gi,
    label: "filler intensifier",
    severity: "low",
    suggestion: "rewrite-prose",
  },
];

export interface FixSuggestion {
  file: string;
  line: string;
  label: string;
  severity: Severity;
  action: SlopPattern["suggestion"];
  safeDelete: boolean;
}

export function applySafeDeletes(cwd: string, suggestions: FixSuggestion[]): { applied: number; files: string[] } {
  const byFile = new Map<string, FixSuggestion[]>();
  for (const s of suggestions) {
    if (!s.safeDelete || s.action !== "delete-line") continue;
    if (!s.file || s.file === "(unknown)") continue;
    const list = byFile.get(s.file) ?? [];
    list.push(s);
    byFile.set(s.file, list);
  }
  let applied = 0;
  const touched: string[] = [];
  for (const [file, hits] of byFile) {
    const path = resolve(cwd, file);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    const remove = new Set(hits.map((h) => h.line.trimEnd()));
    const next = lines.filter((ln) => !remove.has(ln.trimEnd()) && !remove.has(ln));
    // Also match exact content without requiring trim identity on whitespace-only
    const next2 = next.filter((ln) => {
      for (const h of hits) {
        if (ln === h.line || ln.trim() === h.line.trim()) return false;
      }
      return true;
    });
    if (next2.length === lines.length) continue;
    writeFileSync(path, next2.join("\n"), "utf8");
    applied += lines.length - next2.length;
    touched.push(file);
  }
  return { applied, files: touched };
}


/** Scan added-line rows for slop; exported for verify scripts. */
export function scanAddedLinesForSlop(
  addedLines: Array<{ file: string; text: string }>,
): { suggestions: FixSuggestion[]; rankedLabels: string[] } {
  const suggestions: FixSuggestion[] = [];
  const labels = new Set<string>();
  for (const row of addedLines) {
    const plusLine = `+${row.text}`;
    for (const pat of SLOP_PATTERNS) {
      pat.re.lastIndex = 0;
      const target = pat.lineAnchored ? plusLine : row.text;
      if (!pat.re.test(target)) continue;
      labels.add(pat.label);
      if (suggestions.length < 80) {
        suggestions.push({
          file: row.file,
          line: row.text,
          label: pat.label,
          severity: pat.severity,
          action: pat.suggestion,
          safeDelete: Boolean(pat.safeDelete),
        });
      }
    }
  }
  return { suggestions, rankedLabels: [...labels] };
}
