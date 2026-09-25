#!/usr/bin/env node
// Nothing may be carried over from the pre-package pi-pstack tree (335177c). A file fails when its bytes equal a blob
// in that tree and no vendored upstream 0.15.5 file has the same bytes. Prints each failing path.
import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const OLD_TREE = "335177c";
const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const blobs = (treeish, prefix = "") => new Set(git("ls-tree", "-r", treeish, ...(prefix ? ["--", prefix] : [])).split("\n").filter(Boolean).map((line) => line.split(/\s+/)[2]));

const isRegularFile = (path) => { try { return lstatSync(path).isFile(); } catch { return false; } };
const oldBlobs = blobs(OLD_TREE);
const files = git("ls-files", "--cached", "--others", "--exclude-standard").split("\n").filter((file) => file && isRegularFile(join(REPO, file)));
const upstreamFiles = files.filter((file) => file.startsWith("parity/upstream/"));
const upstreamBlobs = new Set(upstreamFiles.length ? git("hash-object", "--", ...upstreamFiles).split("\n").filter(Boolean) : []);
const shipped = files.filter((file) => !file.startsWith("parity/upstream/"));
const hashes = git("hash-object", "--", ...shipped).split("\n");
const carried = shipped.filter((file, index) => oldBlobs.has(hashes[index]) && !upstreamBlobs.has(hashes[index]));
for (const file of carried) console.log(file);
process.exitCode = carried.length ? 1 : 0;
