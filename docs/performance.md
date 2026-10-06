# Reproducible web UI performance check

The checked-in browser harness uses deterministic synthetic notes and an isolated mock API. It does not log in to or modify a real Kept server/account.

## Run it

Build the production web client and then launch Chromium:

```bash
npm run build
npm run benchmark:web
```

The harness detects common system Chromium locations. Set `CHROME_BIN` when the browser executable is elsewhere:

```bash
CHROME_BIN=/path/to/chromium npm run benchmark:web
```

To vary fixture size and note-detail latency:

```bash
node test-fixtures/performance/web-ui-check.mjs --notes=1000 --detail-delay=800
```

The harness clamps collection sizes to 80–10,000 notes and uses a temporary browser profile and an ephemeral local HTTP port. Fixture index deterministically varies checklist/rich-body/link notes, labels, binders, colors, shared/presence states, archive/trash, thumbnails, attachments, and reminders. It reports initial rendered card count, browser scripting/task and layout/style counters over 120 animation-frame scroll events, mobile grid geometry, a small interaction smoke suite, mock API request count, and browser exceptions. Process and temporary-profile cleanup are part of the run.

The scroll counter is a repeatable synthetic interaction proxy, not a measurement of a physical finger scroll or a claim about end-to-end user-perceived latency. Use Chrome DevTools Performance traces and real-device/browser interaction recording for release comparisons. Compare runs using the same browser version, hardware, production build, fixture size, warm/cold cache state, and display configuration. Record repeated runs and report median/p95 rather than treating a single number as a CI threshold.

## Current local reference observation

On the available headless Chromium 154 environment, the post-refactor 240-note harness run reported about **41 ms of `ScriptDuration`** over its synthetic 120-frame scroll sequence, 21 layout passes during the viewport resize, 28 style recalculations, no mobile card overlap, and no browser exceptions. Previous temporary runs measured about 59 ms scripting after the first scroll optimizations and about 809 ms before them. These are directional results from this local synthetic setup, not directly comparable device latency or a release performance guarantee.

The smoke checks cover list/grid switching, sidebar resize, search/clear, unchanged-note close without a detail read/write, and reduced-motion editor closure. Android instrumentation, real media/long-document performance, and real device profiling are separate requirements in `PLAN.md`.
