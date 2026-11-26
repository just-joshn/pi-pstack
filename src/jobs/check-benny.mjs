// tsconfig.json covers TypeScript only, so this script names its types for the linter.
/// <reference types="node" />
import { checkJob, unresolvedSkills } from "./job-check.ts";

const [target] = process.argv.slice(2);
if (!target)
  throw Error("Usage: node src/jobs/check-benny.mjs <target repository> | <Benny job.json>");
const report = target.endsWith(".json")
  ? await checkJob(target)
  : await unresolvedSkills(target).then((unresolved) => ({ ok: !unresolved.length, unresolved }));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.ok ? 0 : 1;
