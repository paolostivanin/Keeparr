# Kept maintainability and smoothness implementation plan

Date: 2026-10-06
Status: approved direction; work packages below are pending unless explicitly stated otherwise.

## 1. Objective and technology decisions

Deliver a maintainable notes application whose everyday interactions remain fast and fluid on the web and native Android, including large accounts, rich notes, offline use, and synchronization in the background.

Agreed technology direction:

- Keep the web client in **TypeScript and Angular**. Modernize state management, rendering boundaries, feature loading, and eventually change detection incrementally.
- Keep the Android client in **Kotlin, Jetpack Compose, Room, coroutines/Flow, and WorkManager**. Improve the existing native implementation rather than replace it with a WebView or another cross-platform UI.
- Keep **Node.js/Express and SQLite** for the backend. Extract cohesive modules and introduce types gradually where they improve contracts and maintainability.
- Use the existing local databases and durable outboxes as the foundation for responsive saves and synchronization.
- Introduce workers, paging, or additional libraries only for a measured need. Do not create a second state store, persistence queue, or synchronization protocol alongside the existing one.

A framework or language rewrite is not part of this plan. Browser DOM/layout costs, whole-collection processing, blocking persistence, and overly broad updates are the first problems to solve. Reconsider a technology decision only with a benchmark demonstrating a limitation that cannot reasonably be addressed within this architecture.

## 2. Relationship to existing plans

Read these documents before implementing Android or shared-protocol changes:

- [Native Android product plan](docs/native-android-plan.md).
- [Native Android remediation and completion plan](docs/native-android-remediation-plan.md).
- [Shared native contract fixtures](test-fixtures/native-contract.json).

This plan adds the maintainability and performance workstream. It retains their content-preservation, revision/conflict, outbox, reminder, profile, widget, and connection requirements. Re-verify previously completed packages when affected; do not reimplement a capability merely because an older paragraph describes it as a gap.

The remediation plan records WP0-WP11 as complete for their stated automated coverage and WP12 as pending. Actual device, gateway, upgrade, accessibility, and release acceptance remain requirements. Reconcile contradictory historical status paragraphs against the current implementation and test evidence before scheduling work.

The native product plan originally proposed API 26. The current `android-native/app/build.gradle.kts` actually specifies **minSdk 34, targetSdk 35, compileSdk 35**. Establish the supported-device policy in phase 0. This performance refactor does not implicitly lower minSdk or establish support for API 26. Test the actual supported minimum and the user's Android 16/OnePlus setup; audit target/compile SDK requirements before release.

The web still contains Capacitor/native plugin entry points for other native shells. Preserve those interfaces when extracting the web editor and Smart Capture. Native Android changes in this document refer to `android-native/`.

## 3. Current architecture and concrete opportunities

Sizes below are approximate inspection snapshots, not permanent limits or acceptance criteria.

| Area | Current source | Observation | Planned response |
| --- | --- | --- | --- |
| Web editor | `src/app/components/input/input.component.ts`, about 4,900 lines | Text editing, checklists, drawings, reminders, organization, collaboration, and saving share one component. | Introduce an editor-session boundary, feature components, focused adapters, and a persistence coordinator. |
| Web overview | `src/app/components/notes/notes.component.ts`, about 3,000 lines | Cards, layout, gestures, selection, dialogs, pagination, and actions are coupled. | Extract card rendering first, then grid/layout and page orchestration. |
| Web state | `shared.service.ts`, `notes.service.ts`, `offline-sync.service.ts` | Broad subjects, mirrored arrays, full cache reloads, and mutable note data create wide update paths. | One normalized notes store, typed change sets, immutable card-facing state, and narrow subscriptions. |
| Web close/save | `InputComponent.saveNote` and `labelsForSave` | A server read may occur before the unchanged-note check; edited notes can wait on remote writes before closing. | Detect no-op closes locally and close changed notes after an atomic durable local save. |
| Web local storage | `offline-store.service.ts` | `getNote`/`putNote` scan collections; snapshot clearing occurs separately from replacement writes. | Indexed point lookups and atomic local edit/snapshot transactions. |
| Web feature loading | `app.module.ts`, `app-routing.module.ts`, `angular.json` | Screens are eagerly imported; the webpack browser builder is still used. | Incremental standalone/lazy feature loading and a separately verified modern builder migration. |
| Native home | `android-native/.../ui/KeptScreen.kt` | A lazy staggered grid already exists, but filtering, HTML conversion, and various screens/dialogs share the composable file. | Preserve lazy grids; extract screen state and immutable display models. |
| Native notes stream | `data/KeptRepository.kt`, `data/Database.kt` | Record observation reparses all note JSON and sorts the collection; other record kinds share the table. | Narrow projections, change-aware decoding, indexed order/search fields, and typed UI state. |
| Native settings | `data/Connection.kt` | Construction and writes use `runBlocking(Dispatchers.IO)`; callers can still block the main thread while waiting. | Asynchronous initialization and suspend writes, with immutable published connection snapshots. |
| Native editor | `ui/NoteEditor.kt`, `ui/NoteEditorViewModel.kt` | A local-save model exists, but full JSON copying/comparison and `raw.toString()` effect keys can occur for every edit. | Field-oriented editor updates, generation-based effects, and preserved rich-text adapters. |
| Native media | `data/Media.kt`, `ui/KeptScreen.kt` | Disk caching exists; image previews are not requested at the actual display size and do not have a shared decoded-image cache. | Size-aware decoding, shared loading/deduplication, cancellation, and bounded memory. |
| Native side effects | `KeptRepository.changed/reconcile/sync`, `MainActivity.kt`, widgets | Broad reconciliation can refresh alarms/widgets after unrelated changes and no-op syncs. | Resource-specific change sets and bounded, coalesced side effects. |
| Backend | `server/server.js`, about 8,500 lines | Persistence, protocol handling, APIs, scheduling, media, and other features share one module. Mutation replies can include a full snapshot. | Extract modules around existing transaction boundaries and negotiate incremental replies. |

### Improvements already implemented in the working tree

Retain and verify the first responsiveness pass:

- Passive, frame-coalesced web scroll handlers that avoid entering Angular unless visible state changes.
- Layout scheduling outside Angular, container ResizeObserver handling, and removal of per-check container-width reads.
- Immediate editor loading feedback and cancellation protection for late note fetches.
- Shorter card/editor transitions and reduced-motion handling.
- Bounded render-limit growth, chunked search rendering, and stale progressive-expansion protection.
- Angular event/run coalescing.
- Regression coverage in `src/app/components/notes/notes.component.spec.ts`.

A local synthetic Chromium comparison observed approximately 809 ms versus 59 ms of scripting across 120 scroll events, and 40 versus 24 resize layout passes. This is evidence for that specific interaction, not a general app-speed result or an Android baseline. Turn the temporary experiment into a reproducible benchmark in phase 0.

## 4. Architectural invariants

These are requirements throughout the refactor, not tasks that can be deferred until the end.

1. **Durable local saves:** a successful local save commits the document/draft and the necessary outbox intent atomically before reporting success or closing the editor.
2. **One persistence path:** foreground edits, offline edits, widget actions, and background synchronization use the same authoritative local storage and operation model on each client.
3. **Stable identities:** use server/profile plus `syncId` as the logical note identity. A temporary numeric ID becoming a server ID must not replace the editor session, card, selection, media references, or widget row identity.
4. **Content fidelity:** preserve HTML, formatted checklist strings, nesting, inline images, attachments, drawings, and unknown extension fields through web/native round trips. A preview is not a complete editable document.
5. **Separate state domains:** shared content, personal pin/order/view state, presence, local draft generations, and accepted server revisions are different concepts.
6. **Recoverable concurrency:** an incoming snapshot or acknowledgement cannot replace newer local text. Guarded writes, accepted operation identities, and conflict drafts retain their existing semantics.
7. **Immutable sent operations:** only known-unsent work may be coalesced. A request with an unknown outcome retains its operation ID and payload until acknowledged or resolved.
8. **Atomic reconciliation:** data changes and cursor progression commit together. Snapshot replacement retains unsent work, dependent media, recovery records, and profile isolation.
9. **Narrow updates:** changing one note should not reparse every note, remeasure the entire grid unnecessarily, reschedule unrelated alarms, or rebuild every widget.
10. **Main-thread budget:** heavy parsing, image encoding/decoding, database work, configuration writes, and collection transformations stay off the Android main thread and outside browser interaction-critical work where possible.
11. **User feedback:** local saving, saved locally/pending sync, synced, conflict, and failed-local-save states have distinct meanings. An error cannot be disguised by dismissing an unsaved editor.
12. **Lifecycle ownership:** listeners, observers, coroutines, subscriptions, timers, requests, and object URLs have an explicit owner and cleanup policy.
13. **Existing behavior:** ordering, locked previews, reminder occurrence identity, revocation, authentication recovery, mTLS/gateway routing, and widget filtering remain covered by existing contracts.

## 5. Performance targets and measurement policy

Treat these as initial acceptance targets for controlled reference devices and fixtures. Establish the hardware, browser/OS version, build mode, refresh rate, and baseline in phase 0; record any target adjustment with its evidence.

| Interaction/resource | Initial target |
| --- | --- |
| Visual acknowledgement | Aim for the next frame; p95 within 50 ms for ordinary tap/click feedback in warmed views. |
| Browser interaction latency | p95 input-to-visible-update within 100 ms for typing, selection, toggles, and local navigation on the reference setup. |
| Local save and editor close | p95 from close intent to dismissal within 150 ms for ordinary text/checklist fixtures, including the durable local transaction; remote latency excluded from the close path. Report rich-media cases separately. |
| Frame work | Aim below 8 ms of app main-thread work on a 60 Hz device and below 4 ms on the 120 Hz reference device. The total frame budgets are about 16.7 ms and 8.3 ms respectively. |
| Android scrolling | At most 5% janky frames in the defined release-build scroll scenarios; no frozen frames attributable to routine application work. |
| Warm restoration | Web cached overview and Android warm cached home usable within 500 ms on the reference setup; measure cold startup separately. |
| Background sync | A no-change sync produces no note-card projection rebuilds, media decoding, widget content rebuilds, or unnecessary alarm scheduling. |
| Collection scaling | Mounted web cards stay bounded after virtualization; native composed items remain viewport bounded. Test 100, 1,000, and 10,000 notes. |
| Memory | Repeated scroll/open/close cycles plateau after bounded caches warm. No retained closed editor sessions, accumulating listener sets, or unbounded decoded-image/undo caches. |
| Initial web transfer | Core initial JS transfer must not regress from the measured production baseline; route/feature splitting must show a measured reduction. |

### Required measurement setup

- Synthetic collections at 100/1,000/10,000 notes, with controlled mixes of pinned notes, binders, labels, shared notes, rich HTML, images, attachments, and reminders.
- Checklists at 10/100/1,000 rows and text documents at ordinary and unusually large sizes. Include non-string/unsupported checklist data from the contract fixtures.
- Network profiles: low-latency, 500 ms latency, intermittent loss, offline, expired session, and reconnect during an edit.
- A clean profile, populated local cache, upgrade with queued work, and two-user web/native collaboration scenarios.
- Web production builds in Chromium and Firefox; browser/PWA touch behavior in Safari where available. Include any still-shipped web-based native shells as a separate compatibility check.
- Android release-like, profileable builds on the supported minimum/API 34 device or emulator, API 35, and the user's Android 16/API 36 OnePlus device. Include 60 Hz and 120 Hz where supported, plus another launcher for widget checks.
- Web traces covering scripting/layout/style/long tasks, event timing, card update counts, DOM count, network bytes, and memory. Use CPU throttling only as a documented supplementary profile.
- Android Macrobenchmark startup/FrameTiming metrics, Perfetto traces, recomposition diagnostics, memory/GC, and release compiler stability/skippability reports. Debug builds are for correctness, not final smoothness claims.
- Report multiple runs, median/p95 and frame outliers. Keep synthetic input definitions and commands in the repository; keep device-specific raw artifacts out of normal source changes.

### B0 — Baseline and characterization deliverables

- [x] Add deterministic performance-fixture generation under `test-fixtures/performance/`. The web harness varies note/checklist/rich-content/media metadata by stable fixture index and accepts a collection-size argument; Android fixture generation remains outstanding.
- [x] Add a checked-in web browser benchmark harness and documented production-build commands. Reproduce scroll/resize checks and basic list/grid/search/reduced-motion smoke; typing, save/close, media, memory, and native journeys remain outstanding.
- [ ] Capture native release-like startup/scroll/editor traces before Android refactoring. Introduce a minimal repeatable instrumented journey now; expand to full Macrobenchmark modules in A6.
- [ ] Add characterization coverage for existing rich-content, reorder, no-op close, draft/outbox, and protocol behavior before extracting its owner.
- [ ] Record the supported Android minimum, reference devices/launchers, browser versions, refresh rates, benchmark timing definitions, and network/cache conditions.
- [x] Add web/server and Android functional/build CI jobs using Node 24 and JDK 17. Instrumented platform journeys remain separate; no noisy shared-runner timing threshold is imposed.
- [ ] Document the initial architectural ownership map and authoritative storage/write paths. Identify legacy compatibility facades before new stores/components are introduced.

Acceptance:

- Another developer can generate the same synthetic collection and execute the documented web/native journey.
- Baseline results include build/device/cache/network context and repeated runs, not a single anecdotal trace.
- Supported-device and contract decisions are explicit, and new behavioral packages have a reproducible comparison baseline.

## 6. Work-package roadmap

Priority means implementation order/value in this workstream. Dependencies are gates for behavior changes, not a requirement to wait before inspecting or preparing characterization tests.

| ID | Priority | Dependencies | Deliverable |
| --- | --- | --- | --- |
| B0 | P0 | None | Reproducible benchmarks, behavior fixtures, supported-device decisions. |
| W1 | P1 | B0 | Independent web note cards and cached display models. |
| W2 | P1 | W1 | Normalized web state, change sets, indexed local reads, incremental cache notifications. |
| C1 | P1 | B0 | Explicit shared save/acknowledgement contracts and negotiated incremental responses. |
| W3 | P1 | W2, C1 | Durable local-first web saves and recoverable synchronization. |
| W4 | P1 | W1-W3 | Editor/grid/page extraction and focused feature adapters. |
| A1 | P1 | B0 | Asynchronous native settings/startup and lifecycle-owned state. |
| A2 | P1 | B0 | Immutable native projections, scoped screen state, and narrow Room queries. |
| A3 | P1 | A1, A2, C1 | Field-oriented native editor and persistence refinements. |
| A4 | P1 | A2 | Shared size-aware native media loading and stable gesture/layout behavior. |
| A5 | P1 | A1-A4, C1 | Incremental native sync side effects, widgets, and reminders. |
| W5 | P2 | W4 | Standalone/lazy web features and modern build pipeline. |
| W6 | P2 | W2, W4 | Web media/search/drawing hot-path refinements. |
| W7 | P2 | W1, W2, B0 scaling evidence | List virtualization, then a separately accepted grid implementation. |
| S1 | P2 | C1, behavior fixtures | Modular backend, bounded queries, and incremental typing. |
| W8 | P2 | W2-W6, third-party callback audit | Verified zoneless Angular migration. |
| A6 | P2 | A1-A5, release baselines | Baseline Profiles, build/runtime tuning, Android release readiness. |
| Q0 | P0 gate | Every affected package; all packages for release | Cross-client, migration, accessibility, device, and performance acceptance. |

Recommended delivery order:

1. B0, then W1 and A1: establish measurement, isolate card rendering, remove blocking native configuration.
2. W2, A2, and C1: align state/projections and contract expectations.
3. W3 and A3, followed by W4: make saves durably local-first and split the editor with explicit ownership.
4. A4/A5, W5/W6, and S1: narrow side effects, improve loading/media, and extract backend modules.
5. W7, W8, and A6: measured scaling work, zoneless migration, and release tuning.
6. Q0 final device/cross-client acceptance. Run the relevant Q0 subset after each package rather than waiting for the end.

Each package should be implemented in reviewable behavior-preserving slices, followed by separately measurable performance changes. Record actual results in section 13.

## 7. Web implementation packages

Current web source paths below are relative to `src/app/` unless explicitly prefixed otherwise.

### W1 — Note cards as independent rendering boundaries

Current sources: `components/notes/notes.component.{ts,html,scss}`, `pipes/notes-tools.pipe.ts`, and `components/link-preview/`.

- [x] Extract the independently updating note-preview boundary as `NoteCardPreviewComponent` with `OnPush`, typed inputs, and typed action outputs. It owns note surface/body/link/image/checklist/label/attachment preview markup; the parent retains selection, ordering, reminders, pagination, and toolbar actions.
- [x] Extract selection and pin affordances into the independently checked `NoteCardControlsComponent`; selection and persistence remain page-owned outputs.
- [x] Extract the reminder/archive/trash/tooltip-anchor toolbar DOM into `NoteCardActionsComponent`; reminder state, permission prompts, tooltip menus, and writes remain page-owned event handlers.
- [ ] Introduce an immutable `NoteCardViewModel`: visible title/body segments, bounded checklist preview, completed/hidden counts, labels, color/contrast, lock visibility, sharing indicator, attachment summaries, media descriptors, and displayed reminder.
- [x] Cache an immutable preview-presentation object for title visibility, hybrid-note state, and bounded checklist rows/counts; the existing WeakMap caches rich body/link/color metadata. Labels/media/reminders are still passed as note fields rather than included in one complete card model.
- [x] Preserve preview-presentation identity while note/meta/preference inputs are unchanged. Owner presence has a narrow scalar input so it updates without rebuilding that model.
- [x] Compute HTML/checklist/title-derived values when the relevant note/meta/preference reference changes instead of rebuilding preview arrays on every parent template check.
- [ ] Replace in-place card-facing checklist/label/note mutations with explicit updates that create a new value only for affected notes.
- [ ] Avoid anonymous compound template objects and per-check array filtering when a prepared model can be passed directly.
- [x] Convert `LinkPreviewComponent` to an `OnPush` leaf and mark async preview/copy results for checking; dispose the copy timer and intersection observer with the component.
- [x] Bind owner-online state separately from the cached note object so `OnPush` cards update on realtime presence events that mutate the note reference in place.
- [ ] Attach relevant image/link resize notifications to the layout owner. Keep direct DOM manipulation limited to layout/gesture adapters, not business mutations.
- [ ] Preserve hover/touch tools, overview checkbox actions, locked previews, link-only cards, hybrid notes, keyboard selection, and action-menu behavior.

Acceptance:

- An unrelated selection/status/presence change does not reparse or recreate other cards' preview models.
- Editing one existing note invalidates only that note and directly affected ordered/filter sections.
- Existing desktop/mobile interactions and color/content fixtures match the prior UI.
- Async previews and preferences still update under `OnPush`; no stale checklist/label state.

### W2 — Normalized state and incremental local cache updates

Current sources: `services/shared.service.ts`, `notes.service.ts`, `offline-sync.service.ts`, `offline-store.service.ts`, and `reminder.service.ts`.

- [ ] Establish one `NotesStore` with records keyed by partition and `syncId`, a numeric-ID lookup, ordered identity selectors, search/filter inputs, selection, and per-note updates.
- [ ] Use signals/computed selectors for UI-facing state and retain RxJS at streaming/network boundaries where useful. Do not introduce an additional global store library without a demonstrated need.
- [ ] Distinguish full notes from card previews in the type system. Hydrating a full note must not discard its content when a later preview page arrives.
- [ ] Centralize ordering/filtering rules, including pinned/other, binders, archive/trash, shared views, labels, reminders, and attachments. Preserve all/current search scope.
- [ ] Separate presence, connectivity, reminders, labels/binders, and note documents. Their consumers subscribe to the relevant slices.
- [ ] Change cache notifications to a typed change set containing affected resources, upserts, removals, ordering/personal-state changes, and explicit full-reset/bootstrap events.
- [x] Replace the untyped cache event with typed notes/reminders/attachments change flags; incremental pulls now publish only when a stored resource actually changes. Per-resource ID deltas and explicit bootstrap/reset kinds remain outstanding.
- [x] Stop emitting document-change notifications after an incremental pull that applied no visible resource changes. Cursor or sync-status updates alone no longer notify note/reminder consumers.
- [x] Use primary-key point reads by partition/`syncId` for synced resource changes and the indexed numeric-ID path for note lookup, duplicate resolution, and metadata writes; no longer list the entire partition for one note.
- [x] Add a `partition + value.id` IndexedDB index and use it for numeric note lookup and duplicate-ID resolution during a one-note write; syncId-key reads already use the primary key.
- [ ] Add indexes/projections required for ordered local queries and paging. Keep durable documents distinct from derived presentation data.
- [ ] Make snapshot reconciliation atomic: remove/replace eligible records, preserve local pending work, and advance the cursor in the same transaction. Clear-and-refill cannot expose a half-applied snapshot.
- [x] Make the offline snapshot record replacement and cursor advancement one IndexedDB transaction; pending outbox/recovery preservation across all reconciliation paths remains outstanding.
- [x] Add browser regression coverage for indexed lookup/write, atomic snapshot replacement/cursor, partition isolation, no-op cursor pulls, and resource-family invalidation.
- [ ] Make duplicate-identity repair an explicit migration/recovery operation rather than normal render/read-path work. Cover negative-to-positive ID acknowledgements.
- [ ] Keep server pagination cursors separate from local-cache availability. Refreshing a local projection must not erase a usable server cursor or force unnecessary backfill.
- [ ] Reduce `SharedService` to temporary compatibility facades, then separate navigation/UI state, note commands, labels/binders, and overlays. Remove mirrored authoritative `all/pinned/unpinned` state after consumers migrate.

Acceptance:

- One-note lookup/write does not scan or hydrate the collection.
- No-op sync leaves note references, card projections, and layout state unchanged.
- Unchanged records retain identity across server/local notifications.
- Snapshot interruption cannot erase queued drafts or leave the cursor ahead of committed data.
- Ordering/search fixtures remain consistent after offline edits, remapping, page loading, and reconnect.

### W3 — Durable local-first saving

Current sources: `InputComponent.saveNote/labelsForSave`, note writes in `NotesService`, and the existing IndexedDB/outbox services.

- [ ] Introduce an editor-session model with complete source document, accepted server base/revision, dirty fields, local draft generation, and local/remote save status.
- [x] Check unchanged-note closure before fetching server labels or content. The browser harness confirms closing an unchanged fixture note adds no detail read or note write; pending reminder/media changes still bypass the no-op fast path. Broader close/save scenarios remain to be characterized.
- [ ] Preserve concurrent label/organization changes using field-specific updates or guarded server semantics; do not simply delete the existing refresh workaround.
- [ ] Add one atomic `persistLocalEdit` operation that commits the full local document, draft metadata, and outbox intent together.
- [ ] Route online and offline edits through that path. Publish the committed local state, close after local success, and perform the network request in the background.
- [ ] Retain an open recoverable editor on local-storage failure. Report local persistence failure distinctly from offline/pending-sync state.
- [ ] Unify add/update/updateKey, overview checkbox actions, clone/merge effects, and organization actions behind typed commands. Preserve archive/trash/undo semantics.
- [ ] Adopt C1's guarded operation/acknowledgement model where supported. Migrate queued legacy LWW entries without silently reinterpreting or regenerating sent identities.
- [ ] Coalesce known-unsent edits and chain successors behind in-flight operations. An older acknowledgement advances the accepted base but does not roll back a newer draft.
- [ ] Keep complete pending media durable; commit necessary dependencies before sending note/reminder/media operations. Avoid synchronous image encoding/cache hydration as part of an ordinary text close.
- [ ] Implement typed conflict/access/auth recovery states with recoverable drafts. Reuse the existing merge dialog where applicable rather than maintain competing conflict flows.
- [ ] Define multi-tab behavior: serialize claims/acknowledgements per partition through IndexedDB transactions and a supported coordination mechanism; prevent duplicate queue ownership or use idempotent replay when leadership changes.
- [ ] Flush local edits on ordinary close/background/navigation transitions; treat page termination events as supplementary, not the only durability mechanism.

Acceptance:

- Closing an unchanged note performs no note read/write request.
- Closing an edited text note works with 500 ms network delay/offline within the local-save target.
- A process/tab interruption after local commit leaves both content and replayable work.
- A lost accepted response and a newer edit produce no duplicate operation or draft overwrite.
- Two-user web/native conflicts remain recoverable; unknown fields and formatted content survive.

### W4 — Split page/editor responsibilities

Proposed structure under `src/app/features/notes/`; paths are intended targets and can be adjusted to match an agreed feature-folder convention:

```text
features/notes/
  notes-page/
  note-grid/
  note-card/
  note-editor/
    text-editor/
    checklist-editor/
    drawing-editor/
    editor-session.store.ts
  overlays/
    reminder-picker/
    collaborators-dialog/
    labels-binder-picker/
  data/
    notes.store.ts
    note-commands.service.ts
    note-persistence.service.ts
    note-preview.mapper.ts
  layout/
    masonry-layout.adapter.ts
    note-drag.controller.ts
```

- [ ] Extract a grid/layout owner responsible for measurements, ResizeObserver, packing, pagination sentinels, and responsive column rules.
- [ ] Extract selection/drag controllers with explicit lifecycle ownership. Preserve desktop drag, touch long-press, selection, drop constraints, and scroll anchoring.
- [ ] Introduce one overlay host so fixed dialogs are not trapped by card transforms. Migrate modal visibility from direct `style.display` checks to explicit state.
- [ ] Extract text editing/selection/formatting into a focused DOM adapter and component. Preserve caret position, IME composition, undo/redo, paste, and inline objects.
- [ ] Extract checklist editing, nesting, reorder, completed collapse, conversion, and focus movement. Reuse the existing pure checklist/indent utilities.
- [ ] Extract the web drawing feature: canvas rendering, pointer gestures, selection, tool settings, serialization, and undo state belong there.
- [ ] Extract the reminder calendar/time/location UI and common repeat-rule presentation. Keep Smart Capture-specific state separate; share genuinely reusable picker behavior.
- [ ] Extract labels/binders/collaborator/media toolbars and dialogs where they have independent state. Avoid dozens of stateless wrappers that add no ownership boundary.
- [ ] Extract Smart Capture orchestration/panel from `MainComponent` and retain existing Capacitor/plugin event contracts.
- [ ] Keep business rules in domain helpers/commands; keep HTTP/storage out of presentation components. Add a short ownership/dependency guide.
- [ ] Replace scattered cleanup with lifecycle-owned subscriptions (`takeUntilDestroyed` where appropriate), request cancellation, observer disconnects, and disposed timers/object URLs.

Acceptance:

- A change to reminder UI does not require editing drawing/checklist/persistence code.
- Closed editors and destroyed pages retain no subscriptions, listeners, requests, or gesture state.
- Opening/loading/cancelling a note cannot mount a truncated editable preview or reopen a dismissed editor.
- Feature extraction preserves existing native-shell integration and rich-editor behavior.

### W5 — Lazy features, standalone boundaries, and build modernization

- [ ] Migrate extracted features to standalone Angular components incrementally. Keep compatibility module declarations only until their consumers move.
- [ ] Lazy-load auth/setup/admin/settings routes using appropriate route boundaries. Keep the notes route available without loading unrelated screens.
- [ ] Defer drawing, specialized location/Smart Capture UI, import/export tooling, and heavy editor helpers until needed. Identify static imports that prevent code splitting.
- [ ] Provide a lightweight composer entry point so an idle home page does not need active editor listeners or the complete editor feature.
- [ ] Prefetch likely next features only after useful paint/idle and within a documented bandwidth policy. Define first-use loading/focus behavior.
- [ ] Separately migrate `angular.json` from the webpack browser builder to the supported application builder. Verify output paths, assets, source maps, proxy/development commands, Docker serving, and service-worker registration.
- [ ] Re-evaluate `purgecss.config.js`: retain it only where necessary and verify all dynamic classes/templates; remove it if the new pipeline makes it unnecessary and size evidence supports removal.
- [ ] Add meaningful initial and feature-chunk budgets based on the measured baseline. Track transfer size and parse/execute cost, not just raw bundle size.
- [ ] Verify stylesheet/font/image loading and compressed static serving in the actual deployment path. Scope immutable caching to hashed assets; index/API responses must retain appropriate freshness.

Acceptance:

- Admin/settings/drawing code is absent from the core initial bundle when unused.
- The notes overview is usable before optional features load.
- Production Docker/PWA builds still resolve assets, lazy chunks, and updates correctly.
- Feature-first-open behavior preserves focus and does not cause a blank screen.

### W6 — Media, search, and heavy computation

- [ ] Reserve image aspect ratios/placeholders to avoid repeated layout shifts. Request card-sized thumbnails where available and retain full originals for editing/download.
- [ ] Load/decode offscreen images and link previews within a measured viewport buffer. Bound concurrency and avoid eager scraping of the entire account.
- [ ] Reuse resolved preview metadata immediately. Retry failed previews through an explicit policy rather than keeping rejected promises forever.
- [ ] Cache normalized searchable text per changed note. Move collection-level search into a selector/query pipeline rather than repeated template filtering.
- [ ] Cancel/version obsolete search results and page requests. Preserve operators/date search/fuzzy matching and all/current scope through shared fixtures.
- [ ] Introduce a worker for search/import/image processing only if traces show meaningful main-thread cost. DOM-dependent HTML conversion stays in a bounded adapter or uses a verified worker-safe parser.
- [ ] Profile drawing pointer/selection handling, schedule visual updates per frame, and run canvas-only activity outside Angular where no bound state changed.
- [ ] Replace unbounded full PNG data-URL undo history with a bounded history policy and an appropriate stroke/tile/checkpoint model. Preserve undo fidelity and serialized drawing compatibility.
- [ ] Use asynchronous encoding for large images where feasible; keep it outside ordinary note typing/close paths and report progress for genuinely expensive operations.

Acceptance:

- Image-heavy scrolling has bounded requests/decoded memory and stable card geometry.
- Stale searches never replace newer queries.
- Representative rich notes/checklists retain existing search semantics.
- Long drawing/edit sessions do not accumulate unbounded memory or block the UI during routine interaction.

### W7 — Virtualization for large collections

This package is a planned scaling deliverable; choose the implementation using B0 measurements. The existing progressive renderer remains the comparison baseline.

- [ ] Prototype list virtualization first with stable keys, variable-height measurement, overscan, restored scroll anchors, and keyboard focus handling.
- [ ] Integrate server/local paging without rendering all search results. Distinguish unloaded results from actual empty state.
- [ ] Measure DOM/card count, memory, scroll frames, and edit/selection behavior at 10,000 notes.
- [ ] Prototype grid virtualization separately. Account for measured heights, shortest-column placement, pinned sections, image changes, responsive/foldable columns, and stable ordering.
- [ ] Select a maintained compatible library or a small tested adapter based on correctness and measurable cost. Basic fixed-height list virtualization is not sufficient evidence for masonry.
- [ ] Preserve drag targets/autoscroll, selections across unmounted items, overlay anchoring, accessibility, and note-editor return position.
- [ ] Replace `bricks.js` only when the replacement passes the same behavior/performance scenarios. Avoid running old and new layout engines against the same DOM.

Acceptance:

- Mounted cards stay within the defined visible-window/overscan bound while traversing a 10,000-note account.
- Scroll/focus/selection restoration survives open/close, pin/order changes, resize, and delayed images.
- Grid replacement has no persistent overlap, missing notes, incorrect order, or inaccessible offscreen selections.
- Record the tested fallback and remaining limitation if a grid prototype fails acceptance; do not mark grid virtualization complete based on list results.

### W8 — Zoneless Angular after reactive-state readiness

- [ ] Audit every async state producer: sockets, IndexedDB, timers, observers, timepicker callbacks, native/plugin events, image loads, clipboard results, and notification state.
- [ ] Ensure visible state updates use signals, AsyncPipe, or explicit Angular notifications. `NgZone.run` alone must not be assumed to notify a zoneless app.
- [ ] Remove reliance on application-wide checks and `ngAfterViewChecked` state mutation/layout scheduling. Drive work from state/element changes and appropriate render hooks.
- [ ] Keep frame/layout-only callbacks outside reactive updates; trigger a render only for a real bound-state change.
- [ ] Migrate bootstrap configuration and remove Zone.js from the application bundle only after all callback paths are covered. Update the test environment appropriately; legacy zone-based tests need an explicit migration strategy.
- [ ] Compare a zoneless build against the established coalesced-zone baseline for startup, typing, scrolling, and async features.

Acceptance:

- All browser/PWA/native-shell integration scenarios update correctly without incidental zone ticks.
- No stale loading/sync/reminder/presence state or changed-expression failures.
- Performance evidence justifies the final bootstrap change; its tradeoffs and dependency compatibility are recorded.

## 8. Native Android implementation packages

Paths in this section are relative to `android-native/app/src/main/java/dev/kept/android/` unless otherwise stated.

### A1 — Asynchronous configuration, startup, and lifecycle state

Current sources: `data/Connection.kt`, `KeptApplication.kt`, `MainActivity.kt`, `data/SyncWorker.kt`, and `ui/KeptScreen.kt`.

- [x] Remove `runBlocking` settings loading/writes from the main path. Settings expose asynchronous readiness; startup, foreground/background workers, widgets, and reminder receivers await initialization. Legacy property setters update memory immediately and queue serialized IO persistence; logout awaits credential writes, and login activation is atomic.
- [ ] Make important setting-write failures actionable in the UI and verify certificate/key-access behavior on physical devices. Property-setter write errors are currently logged, not surfaced.
- [ ] Publish immutable connection snapshots. Commit login/profile fields together so background work cannot observe a partially changed account/server configuration.
- [ ] Keep token/certificate/gateway persistence and client creation off the main thread. Preserve the existing credential protection and profile-specific cache/job identities.
- [ ] Cache initialized settings in memory and expose typed readiness/authentication state. Show cached content as soon as the relevant local profile is available rather than wait for remote sync.
- [ ] Scope connection changes and coroutine collectors to the active profile. Preserve queued work on nondestructive reauthentication and account switching.
- [ ] Consolidate startup/onStart/onResume reconciliation into a lifecycle coordinator. Preserve required boot/alarm recovery without repeating full work on every ordinary resume.
- [ ] Ensure foreground WebSocket connect/disconnect and WorkManager scheduling remain lifecycle-aware and independent of initial screen rendering.
- [ ] Instrument startup, configuration persistence, Room opening, and first cached UI presentation separately.

Acceptance:

- StrictMode/Perfetto detects no routine main-thread configuration/Keystore/network/disk waits.
- Reauthentication and certificate replacement retain cached documents and queued work.
- Startup does not flash the login screen before initialized session state is known.
- Foreground lifecycle changes do not duplicate sockets, sync jobs, or alarm recovery.

### A2 — Immutable projections, screen extraction, and local queries

Current sources: `ui/KeptScreen.kt`, `data/Models.kt`, `data/Database.kt`, and `KeptRepository.notes()`.

Proposed organization:

```text
ui/
  app/KeptApp.kt
  home/HomeScreen.kt
  home/HomeViewModel.kt
  home/NoteCard.kt
  editor/NoteEditorScreen.kt
  editor/NoteEditorViewModel.kt
  editor/RichTextEditor.kt
  editor/ChecklistEditor.kt
  reminders/
  organization/
  connection/
  conflicts/
  settings/
data/
  notes/NoteQueries.kt
  notes/NoteCommands.kt
  sync/SyncCoordinator.kt
  sync/SnapshotReconciler.kt
  media/MediaRepository.kt
  models/
```

- [ ] Extract app navigation, home, login/connection, settings, reminder lists, organization, and conflict screens into cohesive files and ViewModels.
- [ ] Introduce immutable typed `NoteSummary`, `NoteCardUiModel`, checklist preview, reminder-summary, media descriptor, and screen-state models. Parse raw JSON at storage/network boundaries, not inside normal composition.
- [ ] Retain the full raw/extension-field representation for lossless storage/edit serialization. Do not drop unknown fields while making typed projections.
- [ ] Split the large `Models.kt` into format/order/editor policy/recurrence/protocol models around the existing tested responsibilities.
- [ ] Move HTML-to-preview, label/binder extraction, reminder indexing, filtering, and search transformations off main-thread composition and cache by content version.
- [x] Move native visible-note filtering and HTML text-search projection to a cancellable `LaunchedEffect`/`Dispatchers.Default` projection; note-content parsing no longer runs during ordinary home recompositions. Shared filtering tests cover home/archive search and locked-content exclusion.
- [ ] Introduce a Room note-summary projection with indexed ordering/filter/search fields if the B0 collection baseline justifies it. Update that projection atomically with raw documents on every local, sync, recovery, and deletion path.
- [ ] Keep the raw document and outbox authoritative; summary/search tables are rebuildable derived data. Add nondestructive migrations and exported schemas.
- [ ] Use narrow DAO/table observations so occurrence/reminder writes do not force decoding all notes. Reuse decoded unchanged records and apply `distinctUntilChanged` to meaningful typed results.
- [x] Apply `distinctUntilChanged` before Android JSON projection flows and move note/reminder/occurrence projection work to `Dispatchers.Default`; unrelated reminder writes now leave the notes flow silent. Room still observes the shared records table, so dedicated tables/indexes and decoded-note identity caching remain outstanding.
- [ ] Add a `HomeViewModel` combining query/filter/selection and relevant streams off main; collect lifecycle-aware state at the narrowest screen/component boundary.
- [ ] Preserve the existing `LazyVerticalStaggeredGrid` and stable `syncId` keys. Add content types and isolate per-item selection/presence/media state.
- [ ] Use `remember`/`derivedStateOf` only for appropriate state boundaries; annotations such as `@Immutable` require genuinely immutable contents, not mutable `JSONObject` hidden inside them.
- [ ] Add Room/Paging integration only if whole-list query/projection cost remains material at the target sizes. Define separate list/grid scroll-restoration and global reorder semantics before changing collection loading.

Acceptance:

- Typing a search query or updating sync status does not parse full note HTML inside composition.
- One-record updates reuse unchanged display models and avoid unrelated card recompositions where inputs are unchanged.
- Occurrence updates do not cause whole-note JSON decode/sort work.
- Pinned/order/binder/label/archive/trash queries agree with widgets and shared fixtures.
- Upgrade from current Room schema 4 retains all records, operations, dependencies, delivery entries, and drafts.

### A3 — Editor sessions and durable local persistence refinements

Current sources: `ui/NoteEditor.kt`, `ui/NoteEditorViewModel.kt`, `EditorSnapshotPolicy`, and `KeptRepository.save`.

- [ ] Preserve the existing ViewModel/local-save mechanism; strengthen it rather than create a parallel editor repository.
- [ ] Replace whole-document JSON copying/canonical comparison on each keystroke with typed field updates, dirty-field tracking, and explicit draft/content generations.
- [x] Replace `LaunchedEffect(raw.toString())` keys with an editor draft generation for focus and autosave effects. Focus/autosave no longer serialize the complete JSON document simply to derive an effect key.
- [ ] Serialize complete wire/storage snapshots off main as far as editor API constraints permit. Use an explicit serial/session ownership model for incoming snapshots and local changes.
- [ ] Coalesce superseded unsent draft writes within a measured short window. Bound unsaved time, flush on close/background, and continue to commit document plus outbox atomically.
- [ ] Separate durable-local status from accepted-server dirty state. Avoid queueing repeated equivalent operations solely because an accepted server base trails the already-persisted local draft.
- [ ] Keep `finish()` dependent on local durability, not remote network completion. Handle failed local saves without losing the draft or accidentally closing it.
- [ ] Extract rich text, checklists, media rows, reminder/organization/collaboration dialogs, and toolbar actions. Keep the existing AndroidView/EditText adapter for supported rich text unless a replacement passes content/IME tests.
- [ ] Preserve EditText instances, caret/selection, styled spans, composing text, focus requesters, checklist IDs, and undo behavior across recompositions. Do not replace editor text in the AndroidView update callback for unrelated metadata.
- [ ] Load clean incoming changes without cursor jumps; preserve dirty drafts and surface conflicting remote versions. Older acknowledgements cannot replace newer local text.
- [ ] Scope ViewModels by profile and `syncId`, explicitly release closed editor sessions, and restore recoverable drafts after process death. Ensure opening/closing many notes does not retain every prior session.
- [ ] Preserve blank-new-note discard, attachment staging, lock/unlock, revocation recovery, and personal checklist-collapse behavior.

Acceptance:

- Long text/checklist typing does not serialize and recompare the entire note on the main thread each keystroke.
- Back/close after local save remains responsive during slow or unavailable networking.
- Local persistence failure retains visible recovery work.
- IME composition, rich text, formatted checklist strings, incoming acknowledgements, and process-death restoration pass behavioral tests.
- Repeated open/close cycles retain no inactive editor ViewModels or text watchers.

### A4 — Media, gestures, and adaptive layout

Current sources: `data/Media.kt`, `MediaImage`, `NoteCard`, and editor media rendering.

- [ ] Introduce one application/profile-aware media repository or a maintained image loader configured with the existing authenticated/mTLS client.
- [x] Bound card preview decoding to 768 px, inspect bitmap bounds first, and use power-of-two sampling instead of decoding large source images at near-original size.
- [x] Add a bounded 32 MiB decoded-bitmap LRU keyed by profile, media identity, and requested dimension, plus existing bounded disk caching. In-flight request coalescing and UI-size exact thumbnails remain outstanding.
- [ ] Deduplicate concurrent image requests. Correctly cancel irrelevant consumers, avoid retaining requests for recycled cards, and handle shared-request ownership without breaking other consumers.
- [ ] Make blocking OkHttp operations cancellation-aware. All app/editor/widget/media routes continue using the same immutable connection snapshot and credential-origin rules.
- [ ] Reserve bounded media geometry and expose loading/error states. Avoid card height jumps and repeated decoding during scroll/recomposition.
- [ ] Support existing inline/base64/SVG/drawing previews without introducing a new native drawing editor. Preserve originals and unknown rich content.
- [ ] Move drag hit-test geometry into a dedicated controller. Avoid broad observable geometry-map updates and pointer-input restarts keyed on the changing set of visible bounds.
- [ ] Compute drop targets from visible item geometry, allow required autoscroll, and preserve pin-group/filter reorder constraints. Commit order once per accepted drop rather than every pointer movement.
- [ ] Preserve accessible move-earlier/later actions alongside gestures.
- [ ] Verify list/grid, large font, edge-to-edge insets, keyboard, tablet/foldable widths, orientation changes, and return-to-note scroll position.

Acceptance:

- Media-heavy release scrolling meets frame/memory targets and stays offline-readable after cache warmup.
- Cached thumbnails are not redecoded on every recomposition.
- Drag controllers do not restart mid-gesture because another card entered the viewport.
- Drop order is consistent after local commit/restart/sync and matches widgets.

### A5 — Incremental sync, workers, widgets, and reminders

Current sources: `KeptRepository.changed/reconcile/sync`, `data/SyncWorker.kt`, `reminders/ReminderScheduler.kt`, and `widgets/`.

- [ ] Extract repository responsibilities into note commands/queries, outbox ownership, sync coordination, snapshot reconciliation, presence, and effect dispatch. Keep the existing tested transaction/operation invariants intact.
- [ ] Produce a committed `ChangeSet` recording affected note/reminder/occurrence/media IDs and ordering/personal-state changes.
- [ ] Skip Room replacement writes when the relevant stored representation is unchanged. Check canonical content/personal metadata, not revision alone, because personal state can change independently.
- [ ] After a commit, notify only affected projections, widgets, media consumers, and reminder schedules. Do not perform full reconciliation after an empty successful sync.
- [ ] Separate widget refresh, reminder scheduling, and remote synchronization requests. Reserve full reconciliation for startup/reboot/clock/timezone/permission/profile recovery where necessary.
- [ ] New/changed reminder schedules and occurrence actions take effect promptly after durable local commit; batching widget or note effects must not delay a due alarm.
- [ ] Coalesce widget refresh bursts with a bounded maximum delay and explicit refresh behavior. Use a shared ordered projection/query instead of loading/parsing the entire raw note store per widget.
- [ ] Preserve collection/single-note/quick-create widget semantics. Bound RemoteViews payload size and use a supported collection-loading strategy when large datasets exceed safe IPC limits; do not arbitrarily reduce widgets to a few recent notes.
- [ ] Give widget rows collision-safe stable IDs derived from profile/`syncId`/checklist identity, independent of temporary numeric-ID remapping. Preserve scroll anchors and action targeting.
- [ ] Widget actions persist through the same commands/outbox as app actions, then update affected local views without waiting for remote sync.
- [ ] Reuse connection/client state across WorkManager, widgets, media, REST, and WebSocket. Keep background work profile-scoped and preserve retry/backoff/connectivity rules.
- [ ] Preserve note creation/media/reminder dependencies, lost-response replay, rejected operations, recovery records, and alarm occurrence ledgers.
- [ ] Adopt C1 incremental acknowledgements where negotiated; avoid applying a full account snapshot for every individual queued mutation on capable servers.

Acceptance:

- No-op sync performs no widget-content refresh or alarm re-registration.
- A note body change refreshes dependent previews/notification content as needed without rescheduling unrelated reminders.
- Widget actions are immediately reflected locally and remain queued offline.
- Large collection widgets stay ordered, scrollable, and within binder payload limits.
- Reminder delivery survives process death/reboot/reconnect and retains deduplication/version semantics.

### A6 — Release performance and build readiness

- [ ] Add separate Macrobenchmark and Baseline Profile modules/test journeys appropriate to the current Gradle/Compose setup.
- [ ] Benchmark startup, cached home, search, grid/list scrolling, editor open/typing/close, rich-media rendering, widget launch, and background sync during use.
- [ ] Generate/install Baseline Profiles for representative journeys and compare before/after release metrics. Profiles complement algorithmic improvements; they do not substitute for them.
- [ ] Enable and verify release shrinking/resource optimization where appropriate; inspect APK size and startup dependencies. Evaluate the extended icon dependency and other large dependencies using actual size reports.
- [ ] Audit Kotlin/Compose/toolchain versions and compiler stability reports as a separate controlled change. Do not combine all dependency upgrades with an editor/state refactor.
- [ ] Verify target/compile SDK and supported minimum against the phase-0 policy. Test system navigation, permissions, insets, and background behavior on the chosen versions.
- [ ] Replace the current debug-signed release configuration with the intended release signing/distribution setup before an actual release. Keep local benchmark variants installable without requiring production credentials.
- [ ] Record release-build Perfetto, memory, thermal/repeated-run, and frame metrics on physical reference devices, including the user's OnePlus and launcher.

Acceptance:

- Release-like builds, not debug-only traces, meet agreed targets.
- Profile installation, R8/resource behavior, migrations, native text/media, and app/widget intents work in the optimized build.
- Existing native WP12 device/gateway/notification/accessibility acceptance is completed or explicitly recorded as blocked with evidence.

## 9. Shared protocol and backend support

### C1 — Save contracts and negotiated incremental responses

Current sources: `server/server.js`, `server/native-client.js`, `server/native-client.test.js`, web outbox services, Android `NativeProtocol`/repository, and `test-fixtures/native-contract.json`.

- [ ] Document capabilities and current request/result shapes before changes. Native revision checks, persisted operation receipts, personal state, and reminder schedule/occurrence versions already exist; reuse them.
- [ ] Specify local commit, sent operation, accepted server revision, newer local generation, conflict, retryable failure, revocation, and auth-recovery state transitions for both clients.
- [ ] Add opt-in incremental mutation results where needed: authoritative accepted resource/identity/revision and change cursor metadata, without requiring a full account snapshot on every write.
- [ ] Negotiate this response behavior through explicit capabilities/request options. Keep full-snapshot responses as the backward-compatible default until consumers migrate.
- [ ] Define acknowledgement versus cursor catch-up precisely. A mutation reply cursor must not skip unrelated unseen changes; apply/pull all required changes before advancing a durable cursor.
- [ ] Add guarded partial/personal-state operations only where existing operations cannot express the necessary dirty-field update. Do not split a document into concurrent writes without defined revision/conflict semantics.
- [ ] Let modern web saves opt into guarded revision behavior on compatible servers. Preserve and explicitly handle legacy web LWW operations/older server capability results during migration.
- [ ] Ensure receipt replay remains atomic with mutation acceptance and returns authoritative results. Retry of an identical operation must not change revision/order/occurrence identity again.
- [ ] Reduce full bootstrap use to initial cache construction, explicit reset/recovery, and required compatibility cases. Incremental pulls are the ordinary refresh path.
- [ ] Extend shared fixtures for order, identity remapping, unknown HTML/checklist fields, no-op changes, concurrent labels/personal state, and accepted-old/newer-draft interactions.

Acceptance:

- Old web/native clients retain compatible responses and behavior.
- New clients can save and catch up incrementally without a full-account transfer per operation.
- Concurrent and lost-response tests still pass, and no cursor advancement hides another user's edit.
- Native and web serialization retain full content, extension fields, and personal-state boundaries.

### S1 — Modular backend and measured API improvements

Proposed modules under `server/`: bootstrap/configuration, database/transactions/migrations, notes, labels/binders/personal state, sync, reminders, realtime/presence, media, auth/users, import/backup, and integrations. Existing `native-client.js`, `reminder-recurrence.js`, and `oauth-mcp.js` remain useful boundaries.

- [ ] Extract the database transaction/access context first or preserve its existing boundary explicitly in every extraction. The shared SQLite connection and post-commit effects cannot be rearranged casually.
- [ ] Move routes/services by domain in behavior-preserving slices. Keep protocol/media/auth contract tests as characterization coverage.
- [ ] Define runtime-validated DTO/result boundaries and add JSDoc/checkJs or compiled TypeScript modules incrementally. Preserve Node entry points, package scripts, Docker builds, and emitted-code paths.
- [ ] Centralize note/reminder normalization, access predicates, ordering, and resource-change publication rather than reproduce rules per route/client path.
- [ ] Profile card-page queries, full-note fetches, mutation replies, bootstrap, and search with representative account sizes. Use existing performance tracing and SQLite query-plan inspection.
- [ ] Add appropriate indexes/projections only after checking actual query plans; avoid unbounded full-account reads on ordinary paginated paths.
- [ ] Evaluate FTS/indexed search if current search cost justifies it. Preserve documented search semantics or introduce capability/versioned semantics with compatibility fixtures.
- [ ] Build card-sized media thumbnails if client measurements justify them. Keep original downloads and profile/access rules intact; generate expensive derivatives outside ordinary mutation latency.
- [ ] Coalesce redundant realtime invalidations while preserving resource identity/access removals. Presence events must not force content reloads.
- [ ] Verify static compression/caching in Docker and proxy deployments separately from authenticated API behavior.
- [ ] Measure response bytes and p95 API latency before considering another backend language or database.

Acceptance:

- Server responsibilities have explicit transaction/service/route boundaries and can be tested independently.
- Existing native/sync/reminder/MCP/auth compatibility checks pass after affected extractions.
- Query/index/response changes have recorded improvements at target sizes.
- No language/database replacement is required to claim this package complete.

## 10. Q0 — Verification and regression coverage

### Existing commands

Run appropriate checks for the changed package; broaden to cross-client checks when state, storage, protocol, or server behavior changes.

From the repository root:

```bash
npm run build
CHROME_BIN=/usr/bin/chromium npm test -- --watch=false --browsers=ChromeHeadless --include='src/app/components/notes/notes.component.spec.ts'
node --test src/app/utils/checkbox-indent.test.ts src/app/utils/checklist-conversion.test.ts src/app/utils/note-color.test.ts
npm run test:native
npm run test:sync
npm run test:reminders
npm run test:mcp
git diff --check
```

`CHROME_BIN` is environment-specific; use the installed browser path. Expand frontend test discovery to newly extracted component/store/persistence tests. Update zone-based test setup when W8 changes bootstrap behavior.

From `android-native/`:

```bash
./gradlew testDebugUnitTest assembleDebug lintDebug
```

Add explicit documented commands for instrumented Compose tests, migration tests, release-like assembly, Macrobenchmark, and Baseline Profile generation when the corresponding modules/variants exist. Record prerequisites for devices/emulators and signing; do not list an uncreated Gradle task as already available.

### New meaningful automated coverage

- Store/change-set identity: one-note update, no-op sync, presence-only change, preview/full-note merge, scope/filter/order selectors, and ID remapping.
- Browser IndexedDB transactions: atomic document/outbox commit, interrupted snapshot, indexed lookup, recovery/upgrade, and multi-tab queue ownership.
- Editor lifecycle: unchanged close without network, local-save failure, late hydration after cancellation, in-flight acknowledgement with later edits, caret/IME preservation, and cleanup.
- Angular async behavior under `OnPush` and later zoneless: media/timepicker/native/socket/clipboard/preferences updates.
- Native immutable projections: query invalidation, stable display models, off-main parsing, and all/current feature-specific filter semantics as agreed.
- Android settings/profile changes: atomic async persistence, initialized readiness, reauthentication, and captured-snapshot correctness during background work.
- Native editor: local generation/persistence ordering, rich-format round trips, blank-note discard, selection/composing text, closed-session disposal, and process restoration.
- Both storage upgrade paths: preserve queued/in-flight/conflicted operations, dependencies, identities, drafts, media, cursors, and reminder delivery ledgers.
- Negotiated mutation responses: old/new clients, lost response, replay fingerprint, authoritative revision, concurrent note/personal changes, and cursor catch-up.
- Widgets/reminders: coalesced updates, stable action IDs, IPC bounds, note revocation/lock visibility, no-op scheduling, offline delivery, and process/reboot cases.

Avoid snapshot tests that merely restate component structure or tests of private helper wiring alone. Prioritize data-loss, concurrency, content, lifecycle, and measured-performance regressions.

### Required end-to-end/device journeys

1. Cold/warm home, deep scroll, search/clear/scope, grid/list toggle, selection, pin/reorder, archive/trash/undo, editor return position.
2. Rich text, nested/formatted checklist, hybrid note, inline image, drawing preview, attachment, unsupported content, labels/binders, and reminder round trips across web and Android.
3. Offline create/edit/toggle/reorder; process/tab restart; reconnect; same-base two-user conflict; edit during in-flight upload/save; accepted response loss.
4. Session expiry/nondestructive reauthentication, profile switch, certificate replacement, real mTLS/gateway media and WebSocket flows.
5. Widget placement/filter/order, single-note checklist action, quick capture/share reception, launcher restart, negative-to-positive ID remapping, and large collection scrolling.
6. Reminder create/edit/dismiss/snooze/repeat, server/local occurrence agreement, process death, reboot, permission/clock/timezone change, and observed access revocation.
7. Accessibility: web keyboard and screen reader, Android TalkBack, large font, contrast across note palettes, reduced motion/system animation settings, touch targets, and focus across virtualized content.
8. Ten repeated scroll/open/edit/close cycles while background sync and media loading are active; inspect heap, retained listeners/ViewModels, bitmap cache, and frame outliers.

## 11. Migration, rollout, and implementation discipline

- Start every slice by inspecting current files and working-tree changes. Preserve existing work, including the first UI improvement pass and unrelated documents.
- Keep extraction, storage/protocol migration, and behavioral performance changes separately reviewable whenever possible.
- Make the new store/command boundary available through temporary facades; migrate one consumer at a time and remove the facade when no longer used.
- Maintain one authoritative write path throughout. Do not dual-write two outboxes or let old/new layout engines manage the same view.
- IndexedDB/Room/server migrations are nondestructive and tested from every currently supported predecessor schema. Derived caches can be rebuilt; pending edits and replay identities cannot be discarded.
- Negotiate server extensions before relying on them. Deploy-compatible server behavior can precede new clients; older clients must continue working during the transition.
- Use controlled switches for higher-risk renderer/zoneless prototypes, with a tested fallback until acceptance. Remove redundant implementations after choosing the accepted path.
- Run migration/fault-injection tests on isolated synthetic instances. Use the real gateway/device for its specific acceptance journeys after automated contracts pass.
- A rollback must remain able to understand durable pending work, or the minimum compatible version must be explicitly established before rollout. Never fix a rollback by clearing the user's local data.
- Update developer documentation/source maps after moving files; update build/deployment commands when the builder or server module entry points change.
- Do not mark a package complete based solely on a successful compilation. Record behavior tests and before/after metrics for its stated objectives.

## 12. Definition of done

### Web

- [ ] Overview and editor responsibilities have coherent component/adapter/domain boundaries.
- [ ] Cards update independently and use cached immutable display models.
- [ ] Notes state is normalized; no-op sync and presence updates leave unrelated cards/layout untouched.
- [ ] Indexed local reads and atomic document/outbox/snapshot transactions replace collection scans and split durability paths.
- [ ] Unchanged close is network-free; changed close follows durable local persistence.
- [ ] Lazy feature boundaries and the build pipeline show measured startup improvements.
- [ ] List/grid scaling implementation meets its respective correctness/performance gates.
- [ ] Heavy media/search/drawing work is bounded and removed from measured hot paths.
- [ ] Zoneless migration is accepted with explicit async notification coverage.
- [ ] Browser/PWA/native-shell compatibility, accessibility, and upgrade checks pass.

### Native Android

- [ ] Configuration and startup no longer synchronously wait for persistence on main.
- [ ] Screen state and display models are typed/immutable; raw JSON and HTML processing are outside normal composition.
- [ ] Lazy grids, queries, media loading, and gestures are bounded and independently updating.
- [ ] Editor field updates preserve local durability, rich text/IME behavior, incoming revisions, and process restoration.
- [ ] Closed editors, requests, bitmaps, and listeners have bounded lifetimes.
- [ ] Sync commits produce narrow post-commit widget/reminder/UI effects.
- [ ] Widgets remain ordered, offline-responsive, scalable, and profile-isolated.
- [ ] Release-like startup/frame/memory benchmarks and Baseline Profiles are recorded.
- [ ] Existing native WP12 device/gateway/notification/accessibility acceptance is satisfied for the chosen supported-device policy.

### Shared/backend

- [ ] Compatible guarded saves and negotiated incremental acknowledgements work across old/new clients.
- [ ] Full account snapshots are not required for each ordinary mutation on capable clients.
- [ ] Content, identity, conflict, reminder, access, and operation replay invariants pass cross-client tests.
- [ ] Backend modules preserve transaction semantics and have explicit typed/validated boundaries.
- [ ] Automated CI runs functional/build checks; performance evidence is collected with documented reference environments rather than unreliable shared-runner timing thresholds.
- [ ] Documentation records actual results, remaining limitations, and any unavailable device checks.

## 13. Execution log

Keep the roadmap and checkboxes above current. Add one entry per completed or blocked work package using this format:

```text
Package / date:
Status: pending | in progress | complete | blocked
Files / responsibilities changed:
Contract / storage / lifecycle decisions:
Checks executed and outcomes:
Reference build/device/fixture:
Before / after performance evidence:
Remaining acceptance or blocker:
Next dependency:
```

Initial state: this document defines the approved implementation direction. The first web responsiveness pass and the 2026-10-06 B0/W1/A1 implementation slice are present in the working tree. Broader packages require implementation and their own verification. No Android performance acceptance is claimed by this plan.

### 2026-10-06 implementation slice

```text
Package / date: B0 web baseline/CI + W1 preview boundary/controls + W2 indexed offline access/change notifications + A1 settings/startup + A2 off-main Android search/projections + A3 editor effect keys + A4 bounded image previews + W3 unchanged-close optimization / 2026-10-06
Status: in progress
Files / responsibilities changed: web/server/Android CI and synthetic Chromium harness/docs; OnPush note preview, card controls, and card actions components with typed outputs; unchanged editor close is checked before fetching fresh labels; IndexedDB uses numeric note-ID and syncId primary-key indexes, atomic snapshot/cursor writes, and typed resource-family cache changes; Android settings readiness/serialized IO persistence/atomic login, app-widget-worker-reminder readiness gates, off-main search, distinct/off-main Room projections, generation-keyed editor effects, and bounded profile-scoped decoded-image caching with size-aware sampling.
Contract / storage / lifecycle decisions: existing HTML/raw note and local outbox formats are unchanged; note-page state still owns editor/open/mutation and card toolbar actions; Android connection profile interface has readiness defaults to keep test fakes and repository callers compatible.
Checks executed and outcomes: `npm run build` passed; 19 focused web card/action/editor/offline-store/offline-sync tests passed; `npm run benchmark:web` passed with 240 synthetic notes, about 41 ms synthetic-scroll ScriptDuration, 21 resize layout passes, 28 style recalculations, no overlap, no browser errors, and unchanged-note close making no detail read/write; `./gradlew testDebugUnitTest assembleDebug lintDebug`, `npm run test:native`, `npm run test:sync`, `npm run test:reminders`, and `npm run test:mcp` passed. Native search, reminder-versus-note invalidation, and bitmap sampling tests pass in the Android unit suite.
Reference build/device/fixture: production Angular build; headless Chromium 154; 240 synthetic notes; Android Robolectric/unit/debug build (no physical device).
Before / after performance evidence: local synthetic 120-frame script time is about 41 ms in this run, compared with earlier temporary runs of about 59 ms after the first UI pass and 809 ms before it; comparison is directional. No Android performance baseline was collected.
Remaining acceptance or blocker: B0 native/repeated-browser traces, CI, supported-device decision, and CI execution on hosted runners; W1 reminder/toolbar ownership and a complete cached immutable card model; W2 normalized state, atomic editor/outbox persistence, duplicate repair, resource-ID deltas, and pending-work snapshot preservation; A1 physical startup/StrictMode verification and user-visible settings-write error recovery; A2 typed Room summary tables/narrow SQL queries, decoded-note identity caching, and physical performance evidence; A4 in-flight media request coalescing/cancellation and real-device memory/frame measurements; the other roadmap packages remain pending.
Next dependency: continue W2 normalized state and atomic local edits, then move into the guarded/incremental protocol and complete the web/native editor persistence paths.
```
