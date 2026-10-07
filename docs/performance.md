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

Compare the large-account experimental grid window against the Bricks fallback explicitly:

```bash
node test-fixtures/performance/web-ui-check.mjs --notes=10000 --virtual-grid=on
node test-fixtures/performance/web-ui-check.mjs --notes=10000 --virtual-grid=off
```

The harness clamps collection sizes to 80–10,000 notes and uses a temporary browser profile and an ephemeral local HTTP port. Fixture index deterministically varies checklist/rich-body/link notes, labels, binders, colors, shared/presence states, archive/trash, thumbnails, attachments, and reminders. It reports initial rendered card count, browser scripting/task and layout/style counters over 120 animation-frame scroll events, mobile grid geometry, a small interaction smoke suite, mock API request count, and browser exceptions. Process and temporary-profile cleanup are part of the run.

The scroll counter is a repeatable synthetic interaction proxy, not a measurement of a physical finger scroll or a claim about end-to-end user-perceived latency. Use Chrome DevTools Performance traces and real-device/browser interaction recording for release comparisons. Compare runs using the same browser version, hardware, production build, fixture size, warm/cold cache state, and display configuration. Record repeated runs and report median/p95 rather than treating a single number as a CI threshold.

## Current local reference observation

On the available headless Chromium 154 environment, the post-refactor 240-note harness run reported about **41 ms of `ScriptDuration`** over its synthetic 120-frame scroll sequence, 21 layout passes during the viewport resize, 28 style recalculations, no mobile card overlap, and no browser exceptions. Previous temporary runs measured about 59 ms scripting after the first scroll optimizations and about 809 ms before them. These are directional results from this local synthetic setup, not directly comparable device latency or a release performance guarantee.

The smoke checks cover list/grid switching, sidebar resize, search/clear, lazy settings-chunk loading, unchanged-note close without a detail read/write, and reduced-motion editor closure. The production build also reports which auth/admin route chunks are deferred.

After migration to the application builder, the current production build emits a 1.47 MB initial bundle (~288 KB estimated transfer), with settings and auth/admin code in separate lazy chunks. The previous browser-builder output was about 1.60 MB initial (~317 KB estimated transfer) in the same workspace. The new initial budget warns at 1.6 MB and errors at 1.75 MB; individual scripts warn at 800 KB and error at 900 KB.

Local Chromium 154 scale runs on this host reported:

| Fixture | First-paint cards | 120-frame script time | Resize layouts | List-window cards (top/mid-scroll) | Browser errors |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 240 notes | 87 | 40.99 ms | 24 | 7 / 7 | 0 |
| 1,000 notes | 87 | 40.74 ms | 24 | 7 / 9 | 0 |
| 10,000 notes (Bricks fallback) | 87 | 1,150.17 ms | 24 | 6 / 7 | 0 |

The list layout uses a variable-height window with measured rows, stable `syncId` tracking, overscan, spacer offsets, and scroll anchoring; it mounted at most nine rows in top/mid-scroll checks. A separate experimental grid window (`--virtual-grid=on`, equivalent to `?virtualGrid=on`) passed overlap checks and mounted 15 cards at first paint / 20 after scroll, but measured 1,749.23 ms scripting versus 1,150.17 ms for the Bricks fallback at 10,000 notes. The experimental grid therefore remains opt-in; further profiling and optimization are required before replacing Bricks. Android instrumentation, real media/long-document performance, and physical-device profiling remain separate requirements in `PLAN.md`.

## Reference environment and supported Android floor

- The current Android minimum is **API 34**, matching `android-native/app/build.gradle.kts` (`minSdk = 34`). The build targets/compiles against API 35. API 34 is the software support floor pending explicit product-policy review.
- The requested physical reference set is API 34 minimum, API 35, and the user's Android 16/API 36 OnePlus device, with the user's launcher plus another launcher for widgets. No physical device is attached in this environment, so device refresh rates, launcher behavior, gateway/mTLS journeys, and physical traces remain unmeasured.
- Local browser measurements use Node 24, Linux, production Angular output, headless Chromium 154, and the harness's 1440×900 desktop / 480×850 mobile emulation at device scale factor 1. The 120-frame `ScriptDuration` is synthetic browser scripting, not physical scroll latency. The mock API uses 500 ms detail latency for its editor-open characterization; no account/server data is involved.
