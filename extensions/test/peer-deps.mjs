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
    return { require: createRequire(pathToFileURL(execAnchor)), anchor: execAnchor };
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
      return { require: createRequire(pathToFileURL(npmAnchor)), anchor: npmAnchor };
    }
  }

  throw new Error(
    `extensions/test/peer-deps.mjs: could not find a host Pi install providing ` +
      `${ANCHOR_PACKAGE} under "${execAnchor}"` +
      (npmRoot ? ` or "${join(npmRoot, ANCHOR_PACKAGE)}"` : "") +
      `. Run these tests from a machine with Pi's coding agent installed globally.`,
  );
}

const { anchor: hostAnchor } = findHostRequire();

// require.resolve() cannot resolve a peer whose "exports" map only carries the
// "import" condition (pi-ai does), so resolve through Node's ESM resolver with
// the host package as the anchor. The re-entrancy guard below stops the inner
// resolution from recursing into this hook.
let resolvingPeer = false;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!resolvingPeer && PEER_SPECIFIERS.has(specifier)) {
      resolvingPeer = true;
      try {
        return {
          url: import.meta.resolve(specifier, pathToFileURL(hostAnchor).href),
          shortCircuit: true,
        };
      } finally {
        resolvingPeer = false;
      }
    }
    return nextResolve(specifier, context);
  },
});
