import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord, parseJson } from "../lib/validation.ts";
import { atomicWrite, hasErrorCode } from "../support.ts";
import { readJob, type SlackTrigger } from "./job-input.ts";

export interface SlackMessage {
  ts: string;
  thread_ts?: string;
  subtype?: string;
}
export interface Watched {
  path: string;
  channel: string;
}
export interface WatchIo {
  history: (channel: string, oldest: string) => Promise<SlackMessage[]>;
  dispatch: (job: string, trigger: SlackTrigger) => Promise<void>;
  now: () => number;
}

const isMessage = (value: unknown): value is SlackMessage =>
  isRecord(value) &&
  typeof value["ts"] === "string" &&
  ["thread_ts", "subtype"].every(
    (key) => value[key] === undefined || typeof value[key] === "string",
  );
// Slack gives a person's post no subtype and a file upload `file_share`; joins, edits and bot posts have others.
const isReport = (m: SlackMessage) =>
  (m.thread_ts === undefined || m.thread_ts === m.ts) &&
  (m.subtype === undefined || m.subtype === "file_share");
const oldestFirst = (a: SlackMessage, b: SlackMessage) =>
  a.ts.localeCompare(b.ts, undefined, { numeric: true });

export function slackHistory(token: string, fetcher: typeof fetch = fetch): WatchIo["history"] {
  return async (channel, oldest) => {
    const messages: SlackMessage[] = [];
    let cursor = "";
    do {
      const query = new URLSearchParams({ channel, oldest, limit: "200", cursor });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each page names the next one's cursor.
      const response = await fetcher(
        `https://slack.com/api/conversations.history?${query.toString()}`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- The page body holds the next cursor.
      const page = parseJson(await response.text(), "Slack response");
      if (!isRecord(page) || page["ok"] !== true || !Array.isArray(page["messages"]))
        throw Error(
          `Slack conversations.history failed: ${isRecord(page) ? String(page["error"]) : response.status}`,
        );
      messages.push(...page["messages"].filter(isMessage));
      const meta = page["response_metadata"];
      cursor = isRecord(meta) && typeof meta["next_cursor"] === "string" ? meta["next_cursor"] : "";
    } while (cursor);
    return messages;
  };
}

const slackTimestamp = (milliseconds: number) => (milliseconds / 1000).toFixed(6);

type State = Record<string, string>;
const isCursors = (value: unknown): value is State =>
  isRecord(value) && Object.values(value).every((ts) => typeof ts === "string");
async function readState(path: string): Promise<State> {
  try {
    const saved = parseJson(await readFile(path, "utf8"), path);
    const channels = isRecord(saved) ? saved["channels"] : undefined;
    if (!isCursors(channels)) throw Error(`Invalid watcher state in ${path}; fix or delete it`);
    return channels;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return {};
    throw error;
  }
}

async function pollChannel(
  channel: string,
  jobs: readonly Watched[],
  state: State,
  io: WatchIo,
  save: () => Promise<void>,
) {
  const oldest = state[channel] ?? "";
  const started: { job: string; ts: string }[] = [];
  const history = await io.history(channel, oldest);
  const reports = history
    .filter((m) => isReport(m) && oldestFirst({ ts: oldest }, m) < 0)
    .toSorted(oldestFirst);
  for (const message of reports) {
    const trigger = {
      source_channel_id: channel,
      message_ts: message.ts,
      ts: message.ts,
      thread_ts: "",
    };
    for (const job of jobs.filter((j) => j.channel === channel)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Start each run before recording the report as seen.
      await io.dispatch(job.path, trigger);
      started.push({ job: job.path, ts: message.ts });
    }
    state[channel] = message.ts;
    // oxlint-disable-next-line eslint/no-await-in-loop -- Record each report as seen before the next.
    await save();
  }
  const newest = history.toSorted(oldestFirst).at(-1);
  if (newest && oldestFirst({ ts: state[channel] ?? oldest }, newest) < 0) {
    state[channel] = newest.ts;
    await save();
  }
  return started;
}

export async function pollOnce(jobs: readonly Watched[], statePath: string, io: WatchIo) {
  const state = await readState(statePath);
  const save = () => atomicWrite(statePath, JSON.stringify({ channels: state }, null, 2) + "\n");
  const channels = [...new Set(jobs.map((j) => j.channel))];
  const known = channels.filter((channel) => state[channel] !== undefined);
  for (const channel of channels) state[channel] ??= slackTimestamp(io.now());
  await save();
  const started: { job: string; ts: string }[] = [];
  for (const channel of known) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Channels are polled one at a time to stay under Slack's rate limits.
    started.push(...(await pollChannel(channel, jobs, state, io, save)));
  }
  return started;
}

const runner = fileURLToPath(new URL("run-job.mjs", import.meta.url));

export function startRun(secret: string, launch: typeof spawn = spawn): WatchIo["dispatch"] {
  return async (job, trigger) => {
    const payload = JSON.stringify(trigger);
    const signature = createHmac("sha256", secret).update(payload).digest("hex");
    const events = join(dirname(job), "events");
    await mkdir(events, { recursive: true, mode: 0o700 });
    const event = join(events, `${basename(job, ".json")}-${trigger.message_ts}.json`);
    await writeFile(event, JSON.stringify({ payload, signature }), { mode: 0o600 });
    const child = launch(process.execPath, [runner, "--run", job, event], {
      detached: true,
      stdio: "ignore",
    });
    await once(child, "spawn");
    child.unref();
  };
}

export async function watchedJobs(paths: readonly string[]): Promise<Watched[]> {
  return Promise.all(
    paths.map(async (path) => {
      const job = await readJob(path);
      if (job.kind === "custom") throw Error(`${path} is not a Benny job`);
      return { path, channel: job.config.sourceChannel };
    }),
  );
}

// The OS lets one process listen on a port and frees it when that process exits, crash
// included, so a port held for the watcher's life is a lock with no stale claim to recover.
const lockPort = (statePath: string) =>
  49152 + (createHash("sha256").update(statePath).digest().readUInt16BE(0) % 16384);

export async function claimState(statePath: string) {
  const port = lockPort(join(await realpath(dirname(statePath)), basename(statePath)));
  const server = createServer((socket) => socket.end());
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", done);
    });
  } catch (error) {
    if (!hasErrorCode(error, "EADDRINUSE")) throw error;
    throw Error(
      `Another watcher uses ${statePath} (port ${port} is taken); run one watcher for its jobs`,
      { cause: error },
    );
  }
  server.unref();
  return () => new Promise<void>((done) => server.close(() => done()));
}
