# CI, dependencies, compatibility, and releases

Scope: Build and validation configuration, package manifests, dependencies, lockfiles, workflows, and distribution.

## Toolchain and compatibility

- CI-01 SHOULD use npm, committed `package-lock.json`, Biome, TypeScript, Vitest, and V8 coverage for new repositories. Use the existing equivalent toolchain for established projects unless migration is authorized.
- CI-02 MUST document supported Pi versions, Node.js versions, and operating systems. Read installed SDK declarations and current official release requirements. Test the newest supported and oldest advertised Pi/runtime combinations; include Linux and any advertised macOS/Windows support. Do not hardcode "latest" into reproducible builds.
- CI-03 MUST pin direct registry development/runtime dependencies and CI tool versions. Review intentional updates and commit the corresponding lockfile. Pi host peer dependencies are the documented exception; see [pi-extension.md](pi-extension.md). Set Node engines to the actual supported range.

## Required gates

Use equivalent configured scripts when names differ. Do not claim these commands are available until inspected.

| Gate | Default command or mechanism | When |
| --- | --- | --- |
| Clean install | `npm ci --ignore-scripts` | CI |
| Format and lint | `biome ci .` via a local script | Code/config changes |
| Type checking | `tsc --noEmit` via a local script | Code/config changes |
| Tests | `npm test` | Code changes |
| Coverage | `npm run test:coverage` | Code changes |
| Integration/contract tests | Configured scripts | Affected interfaces |
| Dependency audit | `npm audit --audit-level=high` | CI/release |
| Secret scanning | Configured scanner | CI/release |
| Performance comparison | `npm run bench` or dedicated script | Performance-sensitive changes |
| Package inspection | `npm pack --dry-run --ignore-scripts` | Package/release changes |
| Real package install + Pi smoke test | Isolated clean environment | Release/runtime contract changes |

- CI-04 MUST run mandatory checks before merge/release. Require passing checks and review on protected `main`. Do not bypass failures; document approved exceptions with scope, owner, reason, and expiry.
- CI-05 MUST treat audit failures by cause: findings, registry failure, or tool/config failure. Do not claim a clean audit if unavailable. Block releases on unreviewed high/critical vulnerabilities under this policy; approved exceptions must be explicit and time-limited. Never automatically force-upgrade dependencies.
- CI-06 MUST run untrusted pull requests without secrets or write permissions. Pin third-party GitHub Actions to reviewed full commit SHAs. Use minimal `permissions`, protected release environments, and a separate publishing job. Do not interpolate untrusted workflow expressions directly into shell scripts.

## Distribution

- CI-07 MUST declare Pi resource entry paths accurately and include all required files. Use a package `files` allowlist where practical. Exclude credentials, private fixtures, local session data, development artifacts, and unrelated files.
- CI-08 MUST inspect the dry-run file list, build the actual tarball, and test installing/loading that tarball in a clean environment with the supported Pi host. A checkout-only smoke test does not establish that the distributed package works. Do not run unreviewed lifecycle scripts.
- CI-09 MUST use Semantic Versioning for released public contracts. For stable versions: patch for compatible fixes/performance improvements; minor for compatible new capabilities; major for incompatible API/tool schema/configuration or support changes. Pre-1.0 projects must document their breaking-change policy. Maintain `CHANGELOG.md` and update user-facing documentation.
- CI-10 MUST release only from reviewed, authorized source with all required checks satisfied. Verify tag/version/package consistency. Prefer npm trusted publishing (OIDC) with provenance when supported; avoid long-lived publication tokens. Grant `id-token: write` only to the authorized publishing job when needed.
- CI-11 MUST NOT tag, publish, change distribution tags, merge, or push without authorization. Verify the published artifact/version before reporting release success. If recovery is required, coordinate a corrective release; do not silently overwrite history or publish credentials.

## Official references

- <https://docs.pi.dev/latest/packages>
- <https://docs.pi.dev/latest/quickstart>
- <https://nodejs.org/en/about/previous-releases>
- <https://docs.npmjs.com/cli/commands/npm-ci/>
- <https://docs.npmjs.com/cli/commands/npm-audit/>
- <https://docs.npmjs.com/cli/commands/npm-pack/>
- <https://docs.npmjs.com/trusted-publishers/>
- <https://docs.github.com/en/actions/reference/security/secure-use>
- <https://semver.org/>
