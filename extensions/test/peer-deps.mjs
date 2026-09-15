/**
 * Test bootstrap: resolves this package's peerDependencies (typebox,
 * @earendil-works/pi-*) from the host Pi installation, since this repo ships
 * no node_modules. Preload with --import so extension code under test can
 * import its declared peers without a local install.
 *
 * Run: node --experimental-strip-types --import ./extensions/test/peer-deps.mjs <test-file>.mjs
 */
import { registerHooks } from "node:module";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PEER_SPECIFIERS = new Set([
  "typebox",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
]);

const ANCHOR_PACKAGE = "@earendil-works/pi-coding-agent/package.json";

function findHostRequire() {
  const execRoot = join(dirname(dirname(process.execPath)), "lib", "node_modules");
  const execAnchor = join(execRoot, ANCHOR_PACKAGE);
  if (existsSync(execAnchor)) {
    return createRequire(pathToFileURL(execAnchor));
  }

  let npmRoot;
  try {
    npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  } catch {
    npmRoot = undefined;
  }
  if (npmRoot) {
    const npmAnchor = join(npmRoot, ANCHOR_PACKAGE);
    if (existsSync(npmAnchor)) {
      return createRequire(pathToFileURL(npmAnchor));
    }
  }

  throw new Error(
    `extensions/test/peer-deps.mjs: could not find a host Pi install providing ` +
      `${ANCHOR_PACKAGE} under "${execAnchor}"` +
      (npmRoot ? ` or "${join(npmRoot, ANCHOR_PACKAGE)}"` : "") +
      `. Run these tests from a machine with Pi's coding agent installed globally.`,
  );
}

const hostRequire = findHostRequire();

// require.resolve() below is itself routed through this same hook (Node's
// module customization hooks cover both ESM resolve and CJS require.resolve),
// so resolving a peer specifier here would re-enter and recurse forever.
// Guard re-entrancy instead of trying to special-case the caller.
let resolvingPeer = false;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!resolvingPeer && PEER_SPECIFIERS.has(specifier)) {
      resolvingPeer = true;
      try {
        return {
          url: pathToFileURL(hostRequire.resolve(specifier)).href,
          shortCircuit: true,
        };
      } finally {
        resolvingPeer = false;
      }
    }
    return nextResolve(specifier, context);
  },
});
