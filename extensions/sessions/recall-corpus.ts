/**
 * Local recall corpus helpers: git log + gh PRs (no ExtensionAPI / typebox).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function recallGitLog(
  cwd: string,
  query: string,
  limit = 20,
): Promise<string> {
  const baseArgs = [
    "log",
    `--max-count=${Math.min(100, Math.max(1, limit))}`,
    "--oneline",
    "--decorate",
    "--all",
  ];
  const args = query.trim()
    ? [...baseArgs, "--grep", query, "-i", "-E"]
    : baseArgs;
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, timeout: 15_000 });
    return (stdout || stderr || "(no git log hits)").trim();
  } catch (err) {
    return `git log unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function recallGhPrs(
  cwd: string,
  query: string,
  limit = 10,
): Promise<string> {
  // Prefer gh when on PATH; fail soft.
  try {
    await execFileAsync("gh", ["--version"], { cwd, timeout: 5_000 });
  } catch {
    return "(gh not available — skipped PR corpus)";
  }
  const q = query.trim() || "sort:updated-desc";
  try {
    const { stdout, stderr } = await execFileAsync(
      "gh",
      [
        "pr",
        "list",
        "--limit",
        String(Math.min(50, Math.max(1, limit))),
        "--search",
        q,
        "--json",
        "number,title,state,updatedAt,url,headRefName",
      ],
      { cwd, timeout: 30_000 },
    );
    if (stderr && !stdout) return stderr.trim();
    const rows = JSON.parse(stdout || "[]") as Array<{
      number: number;
      title: string;
      state: string;
      updatedAt: string;
      url: string;
      headRefName: string;
    }>;
    if (!rows.length) return "(no matching PRs)";
    return rows
      .map(
        (r) =>
          `#${r.number} [${r.state}] ${r.title} (${r.headRefName}) ${r.updatedAt} ${r.url}`,
      )
      .join("\n");
  } catch (err) {
    return `gh pr list failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

