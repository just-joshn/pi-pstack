# Performance and resource efficiency

Scope: Startup, event handlers, rendering, tools, I/O, concurrency, data processing, and persistence. Pi shares its Node.js process with extensions.

## Runtime rules

- PERF-01 MUST keep interactive paths responsive. Avoid synchronous filesystem, subprocess, compression, and expensive CPU work on the event loop. Bound callback work; partition or offload expensive computation when profiling justifies it.
- PERF-02 MUST minimize algorithmic complexity for representative input sizes. Avoid repeated scans, nested linear searches, repeated parsing, serialization for equality, and unnecessary copies. Use Map/Set for repeated keyed lookups where appropriate; prefer simple arrays for small sequential data.
- PERF-03 MUST defer expensive initialization until needed. Avoid import-time I/O, unconditional repository scans, network requests, and persistent idle polling. Keep lightweight registration eager; measure lazy loading's first-use cost.
- PERF-04 MUST bound concurrency, queues, retries, input sizes, buffers, and caches. Parallelize independent I/O; serialize conflicting writes. Use backpressure with streams. Avoid unbounded `Promise.all` over external workloads.
- PERF-05 MUST propagate cancellation and deadlines to subordinate work. Close streams, timers, file handles, listeners, workers, and processes on every exit path. Retry only transient failures when safe; cap attempts and total elapsed time, use backoff with jitter.
- PERF-06 MUST stream large files and responses when practical. Cap collection before truncation. Cache only when repeated work justifies it; specify ownership, key, invalidation, maximum size, eviction, and lifecycle.
- PERF-07 MUST avoid redundant UI renders, log formatting, prompt context additions, and tool output. Update only on relevant state changes. Keep model context small. See [pi-extension.md](pi-extension.md) for output ceilings.
- PERF-08 SHOULD reuse connections and expensive objects when safe. Avoid premature micro-optimizations and object pooling without measurement. Do not trade correctness, isolation, or maintainability for an unverified gain.

## Measurement protocol

- PERF-09 MUST establish a baseline before modifying an existing performance-sensitive path when feasible. For new functionality, measure against the approved budget or equivalent operation with the extension disabled. Use representative small, typical, large, and concurrent workloads as applicable.
- PERF-10 MUST compare equivalent environments: same hardware/runner, OS, Node/Pi versions, fixtures, concurrency, settings, and workload. Separate cold and warm runs. Use warmups where appropriate, repeated samples, and sufficient observations for reported percentiles. Report sample count and variability.
- PERF-11 MUST measure relevant metrics: p50/p95/p99 latency, throughput, CPU, heap/RSS, event loop delay, retained resources, and prompt/output tokens. Use `node:perf_hooks`, Node CPU/heap profiles, and Vitest Bench or a reproducible benchmark script. Convert event loop delay nanoseconds to milliseconds.
- PERF-12 MUST record baseline, candidate, absolute and relative change, workload, and reproduction command. Do not claim a speedup from complexity analysis alone. If measurements are unavailable or inconclusive, state that explicitly.

## Initial project budgets

These are project defaults, not Pi requirements. Calibrate on a documented reference environment before using them as hard CI gates. Measure incremental extension cost where stated.

| Metric | Initial target |
| --- | ---: |
| Added cold startup latency, p95 | <= 100 ms |
| Lightweight event callback, p95 | <= 5 ms |
| Lightweight UI render, p95 | <= 16 ms |
| Lightweight local tool overhead, p95 | <= 50 ms |
| Event loop delay, p99 | <= 20 ms |
| Added idle memory (RSS) | <= 20 MB |
| Unapproved reproducible regression | <= 5% |
| Retained resources after shutdown | 0 unintended resources |
| Sustained heap growth after repeated operations | No growth beyond expected retained state |

PERF-13 MUST investigate reproducible regressions over the configured threshold or budget violations. Confirm differences exceed measurement noise and materially affect the workload. Do not change thresholds or remove benchmarks to pass CI. Require documented approval for accepted regressions.

## Official references

- <https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop>
- <https://nodejs.org/api/perf_hooks.html>
- <https://nodejs.org/api/worker_threads.html>
- <https://nodejs.org/api/stream.html>
- <https://vitest.dev/guide/features.html>
