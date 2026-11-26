/// <reference types="node" />
import { dirname, join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { errorMessage } from "../lib/validation.ts";
import { claimState, pollOnce, slackHistory, startRun, watchedJobs } from "./slack-watch.ts";

const usage =
  "Usage: node src/jobs/watch-slack.mjs [--once] [--interval <seconds>] <enabled Benny job.json>...";
const argv = process.argv.slice(2);
const once = argv.includes("--once");
const at = argv.indexOf("--interval");
const interval = at < 0 ? 30 : Number(argv[at + 1]);
const paths = argv.filter((arg, i) => !arg.startsWith("--") && (at < 0 || i !== at + 1));
const token = process.env.PSTACK_SLACK_TRIGGER_TOKEN;
const secret = process.env.PSTACK_EVENT_SECRET;
if (!paths.length || !Number.isInteger(interval) || interval < 5) throw Error(usage);
if (!token || !secret) throw Error("Set PSTACK_SLACK_TRIGGER_TOKEN and PSTACK_EVENT_SECRET");

const jobs = await watchedJobs(paths.map((path) => resolve(path)));
const statePath = join(dirname(resolve(paths[0])), "watch-state.json");
await claimState(statePath);
const io = { history: slackHistory(token), dispatch: startRun(secret), now: Date.now };
const log = (value) =>
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`);

for (;;) {
  try {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each poll starts after the last one ends.
    const started = await pollOnce(jobs, statePath, io);
    if (started.length) log({ started });
  } catch (error) {
    log({ error: errorMessage(error) });
    if (once) process.exitCode = 1;
  }
  if (once) break;
  // oxlint-disable-next-line eslint/no-await-in-loop -- Poll on a fixed interval.
  await wait(interval * 1000);
}
