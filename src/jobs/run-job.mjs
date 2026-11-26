// tsconfig.json covers TypeScript only, so this script names its types for the linter.
/// <reference types="node" />
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, open, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { mcpExtensions, mcpTools } from "../lib/mcp-access.ts";
import { aliases } from "../lib/models.ts";
import { isRecord } from "../lib/validation.ts";
import { deleteRef, fetchBranch, projectSkills } from "./job-check.ts";
import { isMcp, planRun, readEvent, readJob } from "./job-input.ts";
const srcDir = fileURLToPath(new URL("../", import.meta.url));

const [flag, jobFile, eventFile] = process.argv.slice(2);
if (flag !== "--run" || !jobFile)
  throw Error(
    "Usage: node src/jobs/run-job.mjs --run <reviewed enabled job.json> [signed-event.json]",
  );
const job = await readJob(jobFile);
const event = await readEvent(job, eventFile, process.env.PSTACK_EVENT_SECRET);
const benny = job.kind === "custom" ? undefined : job.config;
const repository = await realpath(job.cwd);
const dir = join(dirname(resolve(jobFile)), "runs");
await mkdir(dir, { recursive: true, mode: 0o700 });
const { prompt, key, eventId } = planRun(resolve(jobFile), job, event);
const runDir = join(dir, key);
await mkdir(runDir, { mode: 0o700 });
const cwd = benny ? join(runDir, "checkout") : repository;
const log = join(runDir, "stdout.txt");
const errorLog = join(runDir, "stderr.txt");
const piBin = process.env.PSTACK_PI_BIN ?? "pi";
const env = { ...process.env };
delete env.PSTACK_EVENT_SECRET;
delete env.PSTACK_SLACK_TRIGGER_TOKEN;

const mcp = job.tools.some(isMcp);
const args = [
  "--print",
  "--approve",
  "--no-extensions",
  ...(mcp ? mcpExtensions.flatMap((extension) => ["-e", extension]) : ["--no-mcp"]),
  ...(benny ? [] : ["--skill", join(srcDir, "skills")]),
  "--tools",
  [...new Set([...job.tools, ...(mcp ? mcpTools : [])])].join(","),
  "--session-dir",
  runDir,
];
if (job.tools.some((t) => t.startsWith("pstack_"))) args.push("-e", join(srcDir, "index.ts"));
if (job.model && !aliases.includes(job.model)) args.push("--model", job.model);
if (job.thinking) args.push("--thinking", job.thinking);

const git = promisify(execFile);
/** @param {string} branch */
async function checkout(branch) {
  const ref = `refs/pstack/runs/${key}`;
  await fetchBranch(repository, branch, ref);
  try {
    await git("git", ["-C", repository, "worktree", "add", "--quiet", "--detach", cwd, ref]);
  } finally {
    await deleteRef(repository, ref);
  }
}

/** @param {unknown} error */
const errorCode = (error) =>
  isRecord(error) && typeof error.code === "string" ? error.code : "unknown error";
/** @param {string} error */
const notStarted = (error) => ({ status: "not-started", code: 1, error });

/** @param {Map<string, string>} files */
function listSkillFilesInSystemPrompt(files) {
  // Pi leaves skills marked disable-model-invocation out of the model's skill list.
  const listed = [...files].map(([skill, file]) => `- ${skill}: ${file}`).join("\n");
  args.splice(
    args.indexOf("--tools"),
    0,
    "--append-system-prompt",
    `Your instructions name these pstack skills. Pi does not list them for you; read each one from its file when the instructions call for it:\n${listed}`,
  );
}

async function sharedSkillFilesOrFailure() {
  try {
    const { files, unresolved } = await projectSkills(cwd, piBin, env);
    return unresolved.length
      ? notStarted(`pstack skills not in the checkout's project scope: ${unresolved.join(", ")}`)
      : files;
  } catch (error) {
    return notStarted(`Unable to start Pi (${errorCode(error)}); check PSTACK_PI_BIN`);
  }
}

async function prepareBennyRunOrFailure() {
  if (!benny) return undefined;
  try {
    await checkout(benny.defaultBranch);
  } catch {
    return notStarted(`Could not check out origin/${benny.defaultBranch} in ${repository}`);
  }
  const files = await sharedSkillFilesOrFailure();
  if (!(files instanceof Map)) return files;
  listSkillFilesInSystemPrompt(files);
  return undefined;
}

const stopGraceMs = 5000;

/** @param {boolean} launched @param {string} reason */
const launchFailure = (launched, reason) =>
  launched
    ? {
        status: "unconfirmed",
        code: 1,
        error: `Pi run failed after launch (${reason}); inspect ${runDir}`,
      }
    : {
        status: "not-started",
        code: 1,
        error: `Unable to start Pi (${reason}); check PSTACK_PI_BIN`,
      };

/** @type {ReturnType<typeof spawn> | undefined} */
let child;
let stopped = false;
const stop = () => {
  stopped = true;
  child?.kill("SIGTERM");
  setTimeout(() => child?.kill("SIGKILL"), stopGraceMs).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function runPi() {
  let out, err;
  try {
    out = await open(log, "wx", 0o600);
    err = await open(errorLog, "wx", 0o600);
    child = spawn(piBin, args, {
      cwd,
      env,
      stdio: ["pipe", out.fd, err.fd],
    });
    const stdin = child.stdin;
    if (!stdin) throw Error("Pi started without a prompt stream");
    const exited = once(child, "exit");
    const sent = finished(stdin).then(
      () => true,
      () => false,
    );
    stdin.end(prompt);
    await exited;
    const code = child.exitCode ?? 1;
    if (code === 0 && !(await sent))
      return { status: "exited", code: 1, error: "Pi exited before receiving the job prompt" };
    return { status: stopped ? "stopped" : "exited", code };
  } catch (error) {
    return launchFailure(child?.pid !== undefined, errorCode(error));
  } finally {
    await Promise.all([out?.close(), err?.close()]);
  }
}

const prepared = await prepareBennyRunOrFailure();
const outcome = stopped
  ? { status: "stopped", code: 1, error: "Stopped before Pi started" }
  : (prepared ?? (await runPi()));
await writeFile(
  join(runDir, "result.json"),
  JSON.stringify({ ...outcome, eventId, cwd, log, errorLog }, null, 2),
  { flag: "wx", mode: 0o600 },
);
if (outcome.error) process.stderr.write(`${outcome.error}\n`);
process.stdout.write(`${JSON.stringify({ code: outcome.code, runDir, log })}\n`);
process.exitCode = outcome.code;
