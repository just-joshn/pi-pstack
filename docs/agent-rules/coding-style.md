# TypeScript coding style and architecture

Scope: Source, tests, configuration, and refactors. Applies with root `AGENTS.md`.

## Configuration

- TS-01 MUST use strict TypeScript and ESM. Source-distributed extensions SHOULD use `"type": "module"`, `target` and `lib` = `ES2024`, `module` and `moduleResolution` = `NodeNext`, `noEmit: true`, and `allowImportingTsExtensions: true`. Verify runtime and compiler support before changing existing settings.
- TS-02 MUST enable `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, and `forceConsistentCasingInFileNames` for new projects. Apply migrations explicitly; do not silently weaken existing checks. Include source, tests, and TypeScript configuration/scripts in appropriate typecheck configs.
- TS-03 MUST use Biome as the default formatter and linter for new projects. Default format: tabs, width 3, line width 120, double quotes, semicolons. Existing repository configuration is authoritative unless a migration is requested.
- TS-04 MUST use erasable syntax. No enums, runtime namespaces, constructor parameter properties, or TypeScript import/export assignments. Use literal unions, explicit fields, and ordinary ESM.

## Types and imports

- TS-05 MUST model actual domain states. Use discriminated unions when states have different valid fields. Use `unknown` for untrusted data and narrow it at a defined boundary.
- TS-06 MUST NOT introduce `any`, double casts, unjustified non-null assertions, or `@ts-ignore`. Allow a documented, narrowly scoped exception only when unavoidable and reviewed. Use `@ts-expect-error` only for an intentional type-error test or reviewed temporary workaround with a reason.
- TS-07 MUST validate external data before trusting it. Do not revalidate values guaranteed by trusted typed paths; authorization and semantic constraints still require enforcement.
- TS-08 MUST use `import type` for type-only imports and `node:` for Node.js built-ins. For source-distributed TypeScript use explicit `.ts` relative imports; for compiled ESM use the project's actual emitted import convention. Prefer static top-level imports. Use dynamic imports only for a documented functional or measured loading requirement.
- TS-09 MUST read installed dependency declarations before using unfamiliar APIs. Do not deep-import private Pi modules or change dependency versions merely to silence errors.

## Implementation

- TS-10 MUST keep registration, domain logic, and side effects separate where that separation improves testability. Keep the entry point small. Organize by responsibility; create directories only when needed.
- TS-11 MUST use descriptive names, `const` by default, early returns, and direct control flow. Use kebab-case file names, camelCase functions/variables, PascalCase types/classes, and UPPER_SNAKE_CASE for fixed configuration constants.
- TS-12 MUST NOT add pass-through wrappers, single-use trivial helpers, speculative factories, empty catch blocks, duplicate representations, unused code, or redundant comments. Extract a function when it names a meaningful operation, centralizes an invariant, or makes independent testing useful.
- TS-13 MUST preserve error causes and report actionable context without secrets. Catch errors only to recover, translate at a boundary, or clean up. Use `finally` for resources that require cleanup on failure.
- TS-14 MUST make mutable state ownership explicit. Use immutable values where mutation is unnecessary, and avoid copying large values without a reason.
- TS-15 MUST prefer standard-library and existing dependencies. Introduce a new package only for a demonstrated requirement; review its runtime cost, maintenance, license, and security. See [security.md](security.md).
- TS-16 MUST comment on non-obvious constraints, invariants, security decisions, or measured performance tradeoffs. Do not narrate obvious code. Remove stale comments and dead code within the authorized scope.

## Verification

- Run the configured formatter/linter and TypeScript checks. No new diagnostics, suppressions, or unrelated formatting changes.
- Check public behavior and imports against the installed SDK and supported runtime. If changing public contracts, follow [ci-release.md](ci-release.md).

## Official references

- <https://www.typescriptlang.org/tsconfig/>
- <https://biomejs.dev/reference/configuration/>
- <https://github.com/earendil-works/pi/blob/main/AGENTS.md>
- <https://github.com/earendil-works/pi/blob/main/biome.json>
- <https://github.com/earendil-works/pi/blob/main/tsconfig.base.json>
