# Kept maintainability and smoothness implementation plan

Created: 2026-10-06 · Scope consolidated with user approval: 2026-10-07
Status: in progress; target release **v2.0.0**.

The active backlog contains **32 implementation work items across six milestones**, including the widget-icon fix and version bump. Release gates and deferred options are recorded separately, rather than counted again as unfinished implementation tasks. Consolidation reduces duplication and required scope; it does not imply that unfinished work has been implemented or verified.

## 1. Objective, scope, and constraints

Deliver a maintainable notes application with responsive web/native Android editing, large-account browsing, offline use, and background synchronization.

- Retain TypeScript/Angular on the web; Kotlin/Compose/Room/coroutines/WorkManager in `android-native/`; and Node.js/Express/SQLite on the backend.
- Build on the existing databases, outboxes, editor mechanisms, and extracted modules. Use one authoritative persistence path per client.
- Require reliable state ownership and focused editor/layout/sync boundaries. Exact folder trees, class names, full signal conversion, and splitting every screen/dialog are implementation choices rather than completion gates.
- Add workers, indexes, projections, libraries, or paging only for a demonstrated bottleneck. No framework, backend-language, or database rewrite is required.
- Preserve shipped Capacitor/native-shell entry points and Smart Capture/plugin contracts as well as native Android behavior.

Before Android/shared-protocol changes, consult [native product requirements](docs/native-android-plan.md), [native remediation and WP12 acceptance](docs/native-android-remediation-plan.md), and [shared contract fixtures](test-fixtures/native-contract.json). WP0–WP11 automated coverage is recorded as complete in the remediation plan; recheck affected behavior instead of recreating it. Device/gateway/release acceptance remains open.

Current Android configuration is minSdk 34, targetSdk 35, compileSdk 35. API 34 is the current implementation floor, pending supported-device policy confirmation; this plan does not establish API 26 support. Audit SDK requirements before v2 release.

Supporting references: [ownership map](docs/architecture.md), [sync contract](docs/sync-protocol.md), and [performance harness/results](docs/performance.md). Reconcile historical status statements in these documents with current code and tests when implementing an affected item.

## 2. Requirements retained throughout

These are invariants, not a second implementation checklist.

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

## 3. Current baseline and status reconciliation

The following is recorded implementation/test evidence, not a declaration of full release acceptance. Historical commands and results remain in section 8.

| Area | Existing baseline to retain | Remaining gap belongs to |
| --- | --- | --- |
| Web saves/storage | No-op close fast path; local-first creation/full updates, clones, and receipt-backed merge; atomic note/outbox, field-patch/outbox, merge dependencies, and attachment staging; atomic snapshot/change-page cursor commits; indexed lookups; duplicate recovery and numeric-ID remapping coverage. | M1.2–M1.5: durable session recovery, guarded full-document conflicts, acknowledgement chains, and broader reconciliation/upgrade evidence. |
| Web state/cards/build | NotesStore identity indexes and signal section selectors with compatibility facades; typed cache deltas; OnPush card boundaries; cached previews; card ResizeObserver; lazy auth/settings routes; application builder, budgets, gzip/static caching. | M2/M3/M6: narrow state updates, stale-request handling, layout/editor ownership, interaction and deployment acceptance. |
| Web scaling | Variable-height list window; opt-in shortest-column grid prototype through `?virtualGrid=on`; Bricks remains default/fallback. Recorded 10k runs mount 6/7 list rows and 15/20 experimental grid cards at top/after scroll. | M2/M6: profiling and interaction acceptance. Recorded grid prototype scripting (~1,749 ms) is worse than fallback (~1,150 ms); fewer DOM nodes alone do not justify promotion. |
| Native startup/media/home | Async settings/readiness and immutable connection snapshots; visible write errors; off-main typed home cards; unchanged-note decode reuse; bounded media caches/shared request handling; no-op sync skips widget/reminder reconciliation. | M4/M5/M6: lifecycle/profile audit, remaining hot paths, scoped side effects, device evidence. |
| Native editor/content | Existing ViewModel/local persistence; local-save-dependent `finish()`; dirty-draft/older-ack handling; blank-new-note policies; recovery/profile isolation and Room-reopen/rich-content tests. | M4/M6: performance refinements, closed-session disposal, IME/device/process-restoration acceptance. These are not all missing features. |
| Backend/contracts | Transactional mutation receipts and revision guards; negotiated incremental results/high-water separation; existing native/reminder/OAuth modules; static/capability/mutation-route extraction. | M1/M5/M6: web adoption, focused domain boundaries, targeted validation, query/proxy and cross-client evidence. |

For partially completed old bullets, retain only the remaining gap. Examples: W3's two coalescing bullets and A5's two no-op sync bullets are merged; image/link resize handling already exists and now needs acceptance/ownership work. Do not automatically mark a feature done based on a historical checkbox, test name, or successful build.

## 4. Active milestones

Check an item only after its stated remaining work and focused verification are complete. If code is already sufficient, close it with current evidence instead of implementing a replacement. The single release checklist in section 6 covers shared acceptance journeys.

| Milestone | Former packages | Scheduling |
| --- | --- | --- |
| M1 — Save/conflict/recovery correctness | W2, W3, C1; affected A3 contracts | First priority; gates editor persistence changes. |
| M2 — Reliable web state and large-account rendering | W1, W2, W6, W7 | Start profiling/state work alongside M1; promote renderers only after acceptance. |
| M3 — Focused web editor/layout ownership | W4; relevant W5/W6 and W8 readiness | Prepare characterization first; follow M1/M2 ownership boundaries. |
| M4 — Android editor/startup/projection lifecycle | A1, A2, A3, relevant A4 | Retain existing local-save/editor adapters; improve measured hot paths. |
| M5 — Scoped sync/widget effects and backend boundaries | A4, A5, S1 | Follow affected client/contract ownership; the icon fix can proceed independently. |
| M6 — Verification and v2 release readiness | B0, Q0, required A6/W5 release work | Run relevant gates after every slice; final release follows M1–M5. |

### M1 — Save/conflict/recovery correctness

Primary owners: `InputComponent`, `NotesService`, `OfflineStoreService`, `OfflineSyncService`, shared mutation handlers.

- [x] **M1.1 — Complete local-first commands.** `NotesService.updateKey()` persists positive-ID field changes used by checkbox, binder, archive/trash, pin, label, and image actions as atomic, replayable `note.patch` commands. `NotesService.clone()` builds a fresh owned note through durable create/outbox. `NotesService.merge()` commits the merged document, source trash state, attachment/reminder projection, and `note.merge` outbox intent atomically; the receipt-backed server transaction preserves attachment reparenting, earliest-pending-reminder selection, source trash, and post-commit calendar cleanup. Source attachment uploads retain their immutable payloads and are flushed before their merge command; merge-target uploads and deletes follow the merge. Ordinary text saves return after local persistence, without waiting for network retries/media encoding.
- [x] **M1.2 — Durable editor sessions.** `utils/editor-session.ts` models a session: accepted base (revision/updatedAt/fields), dirty fields, draft generation, saved generation, and local (`clean/dirty/saving/saved-local/failed`) plus remote (`none/queued`) save states. Drafts are written to a dedicated `kept-editor-sessions-v1` IndexedDB (owned by `OfflineStoreService`, exposed by `NotesService.editorSessions()`; the main DB version is unchanged so rollback stays readable) after a 400 ms debounce, before every save, on `visibilitychange`→hidden, `pagehide`, `beforeunload` (supplementary) and component destroy (navigation). Successful saves advance the base without discarding edits typed during the save and remove the draft; failed saves keep it and the editor open with a visible status line. Reopening restores only the dirty fields over the latest note (composer: single `new` slot). Storage failure is surfaced in the editor and retried on the next write/flush. Remote acknowledgement (`queued`→accepted) and guarded conflicts remain M1.3/M1.4.
- [x] **M1.3 — Guarded web conflicts.** The web client negotiates `/api/client/capabilities` (`noteRevisions`) once per profile. Full-document saves of existing server notes carry a durable `guard` (accepted `baseRevision` + base field values) and are sent as guarded `note.upsert`; a 404/405 or `noteRevisions: false` keeps explicit legacy last-writer-wins. On 409 the client three-way merges field-by-field (`utils/note-merge.ts`): fields the user did not change follow the server, so concurrent labels, organization and personal state survive, and the merged document is resent as a new operation against the latest revision. True same-field conflicts, deletion elsewhere, and 403/404 access loss park the operation (`blocked`) in the outbox with the local document intact; `OfflineSyncService.attention$` drives a banner offering *Keep my version*, *Keep both* (saves a copy, then adopts the other version) and *Use other version*/*Discard my changes*. A 401 during sync sets `auth-required` with an explicit "changes are saved on this device" message. `note.patch` stays field-level.
- [x] **M1.4 — Safe acknowledgements and queue ownership.** A guarded save behind a possibly-sent (`sent` or legacy-unknown) operation is chained (`guard.after`), never coalesced into it and never sent in the same request; coalescing of known-unsent saves keeps the original accepted base. Completing an operation advances the base of its chained successor to the acknowledged revision (the server now also returns `revision` for `note.patch`) in the same IndexedDB transaction, and the successor's base is pinned before its first send so lost-response replay is byte-identical. Pending drafts are never overwritten by acknowledgements (cache overlay keeps pending documents). Two tabs: Web Locks serialize flushes; without them concurrent flushes of one entry stay safe through server operation receipts. Same-millisecond outbox entries now order by their hybrid logical clock (fixes the earlier flaky ordering test).
- [x] **M1.5 — Reconciliation and upgrades.** Audited gaps and closed the ones reproduced by tests: (1) reminders/attachments (cache and snapshot projections, including note-embedded attachments) now follow a local note's negative ID to the server ID in the same transaction as the note write; (2) responses fetched for one profile are no longer written into another after a switch, and a sign-out mid-flight cannot resurrect purged data; (3) signing out no longer purges a profile that holds queued operations or unsaved drafts (they stay in that user's partition until re-login and sync); (4) a throwing write inside a multi-store IndexedDB transaction now aborts the whole transaction (previously earlier writes, e.g. the blob of a pending attachment, committed alone); (5) upgrade evidence: a first-generation database with a legacy outbox entry opens non-destructively and chains new saves behind it, and new outbox records keep every field an older build reads. Outbox payloads of unsent reminder/attachment entries keep their original local IDs (the server resolves by sync identity; sent payloads must stay immutable).

### M2 — Reliable web state and large-account rendering

Primary owners: `NotesStoreService`, `SharedService` facades, `NotesToolsPipe`, `NotesComponent`, list/grid adapters.

- [x] **M2.1 — Canonical document/query ownership.** View membership, search scope, operator/date/fuzzy search and reminder ordering now live in one framework-free `NoteQuery` (`utils/note-query.ts`); `NotesToolsPipe` is a thin adapter supplying user/reminder context. Normalized semantics: active/archived/trashed read flags by truthiness (a cached note with missing flags used to vanish from home *and* trash), notes without a `pinned` flag land in the unpinned section instead of in neither, label pages tolerate missing label arrays, and the reminders view orders by a note's earliest pending reminder with untimed ones last. Preview/document boundary: `NotesService.fullDocument()` returns a complete note or throws `NoteIncompleteError`; card checklist/image commands use it and abort with a visible message instead of falling back to a truncated preview (which would have overwritten the full checklist/images), and `updateKey` no longer marks a patched preview as complete. Cache/server cursor handling and identity indexes are unchanged.
- [x] **M2.2 — Narrow card updates.** Presence flips and user-profile changes now replace only the affected notes (`withPresence`, `noteWithUpdatedUserProfile`) and publish through `NotesStore.publishDelta`, instead of mutating shared note/collaborator objects in place and republishing the whole collection (which also re-derived reminder lifecycle and rebuilt every identity index). `NotesComponent` skips layout work for publications that differ only by presence (`notesChangeLayout`), reacts to reminder emissions only when a card's reminder chip can change (`reminderChipKey`), and on preference updates rebuilds layout only for card-shaping preferences (`richLinkPreviews`, text size, checklist ordering, past reminders) and destroys the time picker only when the clock style changes; the meta/date caches no longer reset on every save because they already key on the preferences they depend on. `deleteImage` rewrites a copy of the complete document (the card object and previews are never mutated or written back). Existing per-card `ResizeObserver` coverage of image/link growth was reviewed, not changed.
- [x] **M2.3 — Version/cancel stale requests.** New `RequestGate` (`utils/request-gate.ts`) versions work that publishes shared state. `NotesService` uses it so that: changing the search text expires and network-cancels the old page request (previously the old request ran to completion and was only ignored afterwards), a superseded `load` is not reported as a load error, a next-page request belongs to the list it was issued for (a refresh, new query or account switch expires it, so an old cursor can no longer rewind the new list or append older pages), an account change expires everything in flight and `get()` no longer caches/merges a note fetched for another profile, cache projections publish only if they are the newest for the active profile, and a changed-note publication that raced with a page load re-derives from the current list instead of overwriting it. The filtered-page backfill loop stops when the view/query changes or the component is destroyed. Search operator/date/fuzzy semantics are untouched (`NoteQuery`). Editor opens already carry a per-open token checked after the unlock prompt and the full-note fetch, and a cancelled open mounts nothing; this was reviewed, not changed.
- [ ] **M2.4 — Diagnose and resolve scaling costs.** Trace 100/1,000/10,000-note cold/warm browsing, search, paging, script/layout work, and mounted counts. Identify interaction-critical versus background/bootstrap cost before selecting the remedy. Evaluate the grid prototype against Bricks; retain the faster working fallback until correctness and performance justify promotion.
- [ ] **M2.5 — Accept bounded renderers.** Finish variable-height/geometry updates, scroll anchoring, keyboard-focus and editor-return restoration, pinned/order transitions, delayed-media handling, selection across unmounted notes, and desktop/touch drag targets/autoscroll. Validate list and masonry separately; only one layout engine owns a given DOM tree.

### M3 — Focused web editor/layout ownership and cleanup

Primary owners: `InputComponent`, `NotesComponent`, focused feature/domain adapters.

- [ ] **M3.1 — Editor/persistence boundary.** Separate session/commands from text/checklist DOM editing while retaining complete source content, rich formatting, nesting/reorder/conversion, caret/IME, paste, inline objects, and undo/redo. Extract only cohesive responsibilities supported by characterization tests.
- [ ] **M3.2 — Layout/gesture boundary.** Give measurements, ResizeObserver, packing/window state, sentinels, responsive/foldable rules, selection, and drag lifecycles explicit ownership. Drive layout from changed state/elements rather than repeated application checks.
- [ ] **M3.3 — Overlay state and callbacks.** Replace business-state decisions based on `style.display` with explicit state; keep dialogs outside transformed cards and preserve focus. Make async timer/socket/observer/timepicker/plugin/clipboard results notify the intended view under the current Angular mode.
- [ ] **M3.4 — Bounded resource lifecycle.** Dispose subscriptions, timers, requests, observers, listeners, object URLs, and closed sessions; bound drawing undo memory and avoid expensive synchronous encoding in typing/close paths. Retain drawing serialization and native-shell/Smart Capture behavior; address leaks/stalls with targeted changes rather than mandatory panel-by-panel extraction.

### M4 — Android editor/startup/projection lifecycle

Primary owners: `Connection`, `MainActivity`, `NoteEditorViewModel`, rich-text AndroidView adapter, home projections, `KeptRepository`, `Media`.

- [ ] **M4.1 — Nonblocking initialized startup.** Verify settings/credential/certificate/client creation stays off main, cached active-profile content appears promptly, settings failures are actionable, and login does not flash before readiness. Preserve immutable snapshots and nondestructive reauthentication/profile transitions.
- [ ] **M4.2 — Lifecycle and session disposal.** Consolidate required startup/resume recovery without duplicate sockets/jobs/alarms; scope collectors/ViewModels by profile and syncId, release closed editors, and verify process-restoration and draft safety. Keep existing `finish()` local durability and recovery mechanisms.
- [ ] **M4.3 — Editor hot paths.** Reduce whole-JSON copying/comparison/serialization during text/checklist typing with field/generation-aware, serially owned updates. Keep local durability separate from accepted-server dirty state; avoid redundant queue writes and flush with bounded unsaved time.
- [ ] **M4.4 — Narrow home projection work.** Give query/filter/selection/home state a cohesive owner and reuse unchanged card/search projections. Keep raw JSON authoritative and complete, parsing off composition/main; retain the lazy staggered grid, stable keys, and meaningful content types. Change Room observation/query structures only if profiling still shows material cost.
- [ ] **M4.5 — Reliable native media.** Audit profile-scoped authenticated media requests and captured credentials, cancellation through download/body/decode work, bounded shared caches, actual display-size decoding, reserved geometry, and loading/error state. Preserve inline/base64/SVG/drawing previews and original files.

### M5 — Scoped widget/reminder/sync effects and backend boundaries

Primary owners: `KeptRepository`, workers, reminder scheduler, `widgets/`, server transaction and domain helpers.

- [ ] **M5.1 — Committed change/effect scope.** Carry affected resource identities/order/personal-state changes through commits; skip equivalent writes on remaining paths and notify only dependent projections/media/widgets/alarms. Coalesce widget bursts with a bounded delay without delaying due reminders; reserve full reconciliation for actual recovery needs.
- [ ] **M5.2 — Durable scalable widget behavior.** Verify collection/single-note/quick-create actions use canonical commands/outbox, stable collision-safe row identities, and active-profile filtering/order. Bound RemoteViews/IPC payloads without truncating a large collection to a few recent notes; preserve scroll anchors and local action feedback.
- [ ] **M5.3 — Stable native gestures.** Fix geometry-state/pointer-input restart problems, preserve visible-target hit testing and autoscroll/pin-group constraints, commit order once per accepted drop, and retain accessible move-earlier/later actions.
- [ ] **M5.4 — Focused backend ownership.** Extract remaining high-coupling note/sync/reminder/media responsibilities as warranted, preserve the SQLite transaction/access/post-commit boundary, and centralize shared normalization/access/order/publication rules. Add targeted runtime validation/types at changed external boundaries; preserve Node/Docker entry points and compatibility.
- [ ] **M5.5 — Bounded server work.** Profile card/detail/search/bootstrap/mutation queries, response bytes, and p95 latency with representative accounts. Fix proven whole-account queries or redundant realtime invalidations; preserve resource/access removals and keep presence independent from document reloads. Introduce SQL indexes/FTS/thumbnails only when the evidence warrants them.
- [x] **M5.6 — Widget icon matches main icon (user-reported).** Both native widget provider previews now reference the same `@drawable/kept_icon` as the Android application icon. Resource-level tests verify the shared icon reference; visual launcher/device validation remains in M6.4.

### M6 — Cross-client verification and v2 release readiness

The release gates below are executed here, not duplicated as 25 separate definition-of-done tasks.

- [ ] **M6.1 — Close automated coverage gaps.** Audit existing tests before adding new ones; implement missing fault/concurrency/upgrade/content/identity/lifecycle regression scenarios from the release gates, including unsent/sent/legacy queue cases and old/new client negotiation. Run affected suites per slice and confirm hosted CI evidence.
- [ ] **M6.2 — Repeatable release measurements.** Extend the current harness with missing typing/save/media/memory journeys and a repeatable native journey; collect startup/scroll/search/editor/widget/background-sync traces with release-like builds. Separate cold/warm/cache/network conditions, report repeated median/p95/frame outliers, and document evidence-based target adjustments.
- [ ] **M6.3 — Deployment and shipped clients.** Exercise lazy auth/setup/admin/settings navigation, assets/fonts/styles, Docker/proxy gzip/cache policy, PWA/service-worker/lazy-chunk upgrades, and supported web/native shells. Confirm initial transfer budgets and first-use focus/loading remain acceptable.
- [ ] **M6.4 — Supported Android acceptance.** Confirm device policy and target/compile SDK requirements, then execute API 34 minimum, API 35, and Android 16/API 36 OnePlus journeys, including gateway/mTLS/certificate replacement, permissions, reboot/timezone/clock changes, insets/orientation/large fonts, and two launchers for widgets. Record unavailable hardware separately from implementation gaps.
- [ ] **M6.5 — Accessibility and lifecycle acceptance.** Run the consolidated keyboard/screen-reader/TalkBack/contrast/reduced-motion/focus/touch checks and ten scroll/open/edit/close cycles with media/sync. Investigate retained sessions/listeners/bitmaps/undo growth and visual/frame regressions.
- [ ] **M6.6 — Installable release configuration.** Establish intended signing/distribution before publishing (native release currently uses debug signing); verify optimized release builds, nondestructive upgrades, and app/widget/share intents. Evaluate shrinking/resources with actual size/runtime evidence; keep local benchmark builds installable without production credentials.
- [x] **M6.7 — Bump to v2 (user-requested).** Root package/lockfile and server capability version are `2.0.0`; Android `versionName` is `2.0.0` and `versionCode` advances to `2`. Build/protocol/resource tests verify metadata; upgrade testing, release notes, and signing/distribution remain in M6.6, while physical-device version behavior remains in M6.4.

## 5. Deferred / evidence-triggered backlog

These options do not block the six milestones merely because their mechanisms are absent. Activate an option by linking measured evidence, an owner, and focused acceptance to an active item.

- **Zoneless Angular migration (former W8):** retain coalesced Zone.js while fixing narrow/explicit async view updates under M3.3. Revisit removal only after callback readiness and a measured benefit, with test-environment migration and plugin compatibility coverage.
- **Dedicated Room summary/search tables, additional web ordered indexes, and Room/Paging:** defer schema/query redesign until M2.4/M4.4/M5.5 traces justify it. Any derived data must remain rebuildable, atomically updated where used, and nondestructively migrated.
- **Workers, SQLite FTS, and server-generated media thumbnails:** defer until search/import/image/query profiles demonstrate a need; preserve documented search/content/auth semantics if activated.
- **Baseline Profiles, separate Macrobenchmark/Profile modules, and exhaustive compiler reports:** tooling/optimization follow-ups. Repeatable release-like measurements remain required under M6.2; use the simplest reliable setup first.
- **Prefetching and additional lazy feature splitting:** optional follow-ups to transfer/startup evidence. Composer/drawing/Smart Capture/import deferral is justified only by cost; preserve first-open focus and shipped plugin interfaces.
- **Complete signals migration or one all-encompassing card model:** prefer existing working selectors/facades/caches where they meet identity/update requirements. No extra global store library is prescribed.
- **Exhaustive folder/file reorganizations:** split additional toolbar/dialog/settings/auth/import screens or `Models.kt` only for real ownership/testability benefit. The former proposed directory trees are suggestions, not deliverables.
- **Bricks replacement:** keep the opt-in grid experiment for characterization or revisit the adapter; promote/replace only after performance and interaction acceptance. Do not run both engines on one DOM tree.
- **Broad toolchain/dependency upgrades, icon-library replacement, and backend/database rewrites:** handle independently if SDK/support requirements or benchmarks warrant them. Release SDK compliance remains mandatory; no rewrite is a completion condition.

## 6. Consolidated release gates

These are acceptance journeys, not additional implementation work counts. Record pass/fail/blocked evidence against M6 and fix failures in the responsible milestone. New migrations/renderers/contracts must pass their affected subset before promotion.

| Gate | Required evidence |
| --- | --- |
| **G1 — Everyday navigation/rendering** | Cold/warm home; deep scroll; search/clear/all-current scope; grid/list toggle; selection; pin/reorder; archive/trash/undo; card tools/locked/link-only/hybrid previews; delayed media; editor return position; no overlap or stale async results. |
| **G2 — Cross-client content fidelity** | Rich text, formatted/nested/non-string checklist data, drawing previews, inline images, attachments, unknown extension fields, labels/binders/personal state, and reminders survive web/native round trips without preview truncation. |
| **G3 — Durability/concurrency/upgrades** | Offline create/edit/toggle/reorder; interruption/restart after local commit; local-storage failure; reconnect during edits/uploads; two-user same-base conflicts; lost accepted response and newer drafts; multi-tab replay/ownership; negative-to-positive ID remaps; supported storage upgrades and rollback compatibility. |
| **G4 — Connection/profile recovery** | Session expiry and nondestructive reauthentication; profile switch; certificate replacement; real mTLS/gateway REST/media/WebSocket behavior; no cross-profile data/credentials/jobs. |
| **G5 — Widgets/share integration** | Placement/picker/icon consistency; collection filters/order/scroll/IPC bounds; single-note checklist actions; quick create/share reception; launcher restart; remapped IDs; local durable action feedback. |
| **G6 — Reminder correctness** | Create/edit/dismiss/snooze/repeat; server/local occurrence identity agreement; permissions/process death/reboot/clock/timezone changes; no duplicate delivery; revoked/locked content handled correctly; no-op sync avoids unnecessary scheduling. |
| **G7 — Accessibility/adaptive layout** | Web keyboard/screen reader; TalkBack; large font; palette contrast; reduced motion; touch targets; editor/virtualized focus; insets/keyboard/orientation/tablet/foldable behavior and accessible reorder. |
| **G8 — Performance/lifecycle/release** | Repeated production/release-like interaction/startup/frame/memory/transfer measurements and ten busy scroll/open/edit/close cycles; bounded DOM/caches/sessions; supported builds/deployments/signing/upgrade/CI evidence. |

### Initial targets and measurement policy

Targets remain reference-environment objectives, not thresholds inferred from one synthetic run.

| Interaction/resource | Initial target |
| --- | --- |
| Visual acknowledgement | Next-frame feedback where possible; p95 within 50 ms in warmed ordinary interactions. |
| Browser input latency | p95 input-to-visible-update within 100 ms for typing, selection, toggles, and navigation. |
| Local save/close | p95 within 150 ms for ordinary text/checklists, including durable local commit; exclude network latency and report rich media separately. |
| App frame work | Aim below 8 ms at 60 Hz and 4 ms at 120 Hz; total frame budgets are ~16.7/~8.3 ms. |
| Android scrolling | At most 5% janky frames in defined release journeys; no routine-work frozen frames. |
| Warm cached restoration | Usable within 500 ms on the reference setup; report cold startup separately. |
| Background sync | No-change sync does not rebuild note/media/widget content or unnecessarily schedule alarms. |
| Scaling/memory | Viewport/overscan-bounded mounting in accepted renderers; caches/sessions/listeners/undo plateau after warmup. |
| Web transfer | Core initial JS stays within the measured production baseline/budgets; optional code splits need measured benefit. |

Measure controlled 100/1,000/10,000-note mixtures; 10/100/1,000-row checklists; ordinary/large/rich notes; clean/populated/upgraded caches; low-latency/500 ms/offline/loss/expired/reconnecting network cases; and two-user collaboration. The existing web harness starts at 80 notes and defaults to 240; use 100 for the minimum reference collection. Use Chromium/Firefox production builds and Safari/PWA/shipped-shell touch checks where available. Collect API 34/35/36 native release-like evidence and 60/120 Hz/widget-launcher cases where supported.

Record hardware/browser/OS/build/cache/network/refresh context, repeated median/p95/frame outliers, scripting/layout/long tasks/event timing/card counts/bytes/heap, and native startup/FrameTiming/Perfetto/recomposition/memory evidence. Keep fixture definitions/commands in source and device-specific raw artifacts outside normal source changes. A synthetic 120-frame ScriptDuration total is not input latency, finger-scroll jank, or proof that a renderer meets acceptance. No noisy shared-CI-runner timing gate is required.

Current environment blockers recorded in earlier executions: `adb devices -l` found no device; the emulator command was unavailable. These block physical/device journeys, not feasible code work. Hosted CI, Firefox/Safari, gateway/proxy, device refresh rates, and release signing still need actual evidence rather than inferred passes.

## 7. Execution discipline and available checks

- Inspect the tree before each slice and preserve existing user work, including the `.gitignore` edit.
- Keep extraction, storage/contract changes, and performance behavior separately reviewable. Migrate consumers through facades; remove redundant ownership after migration.
- Preserve transaction/post-commit ordering, client capability negotiation, immutable sent work, and rollback readability. Never resolve upgrade/rollback problems by clearing pending user data.
- Add meaningful regression/fault tests for data-loss, concurrency, content, lifecycle, and measured hot paths. Reuse existing tests and audit claimed coverage; avoid implementation-mirroring snapshots.
- Run appropriate checks once, expanding/repeating only for new changes/failures/unresolved concerns. Update docs/output paths when changed. Compilation alone does not close a milestone.
- Preserve historical log entries as recorded evidence; append a new entry with changed responsibilities, decisions, checks, performance context, remaining acceptance/blockers, and next dependency. Historical package IDs map to the milestones above.

From the repository root:

```bash
npm run build
CHROME_BIN=/usr/bin/chromium npm test -- --watch=false --browsers=ChromeHeadless
node --test src/app/utils/checkbox-indent.test.ts src/app/utils/checklist-conversion.test.ts src/app/utils/note-color.test.ts
npm run test:native
npm run test:sync
npm run test:reminders
npm run test:mcp
git diff --check
```

Set `CHROME_BIN` to the installed browser. Focus frontend discovery on affected specs when appropriate. From `android-native/`:

```bash
./gradlew testDebugUnitTest assembleDebug lintDebug
```

Production Docker and scaling comparisons (repository root):

```bash
docker build -t kept-plan-verify .
npm run benchmark:web -- --notes=1000
npm run benchmark:web -- --notes=10000 --virtual-grid=off
npm run benchmark:web -- --notes=10000 --virtual-grid=on
```

Document device/instrumentation/release tasks when they actually exist, with their prerequisites. Do not list an uncreated Gradle task as available. The commands above are known entry points, not new verification results from this documentation edit.

## 8. Execution log

Historical entries below are preserved verbatim from the previous plan. Their old pending-package descriptions are historical; sections 3–6 govern current scope/status. Previously reported automated results are not physical-device/release acceptance.

### 2026-10-06 implementation slice

```text
Package / date: B0 web baseline/CI + W1 preview/control/action boundaries + W2 indexed offline access/change notifications and initial NotesStore + W3 unchanged-close optimization + C1 incremental mutation responses + A1 settings/startup + A2 off-main search/projections + A3 editor effect keys + A4 bounded image previews / 2026-10-06
Status: in progress
Files / responsibilities changed: web/server/Android CI and synthetic Chromium harness/docs; settings is a standalone lazy route; OnPush note preview, card controls, and card actions components with typed outputs; unchanged editor close is checked before fetching fresh labels; NotesStore provides the ordered in-memory collection and identity indexes; IndexedDB uses numeric note-ID and syncId primary-key indexes, atomic snapshot/cursor writes, and per-resource cache deltas; Android settings readiness/serialized IO persistence/atomic login, app-widget-worker-reminder readiness gates, off-main search, distinct/off-main Room projections, generation-keyed editor effects, and bounded profile-scoped decoded-image caching with size-aware sampling.
Contract / storage / lifecycle decisions: existing HTML/raw note and local outbox formats are unchanged; note-page state still owns editor/open/mutation and card toolbar actions; Android connection profile interface has readiness defaults to keep test fakes and repository callers compatible.
Checks executed and outcomes: `npm run build` passed; 24 focused web card/action/editor/store/offline-sync/link-preview tests passed; `npm run benchmark:web` passed with 240 mixed synthetic notes, about 42 ms synthetic-scroll ScriptDuration, 24 resize layout passes, 31 style recalculations, no mobile overlap, no browser errors, lazy settings chunk load on navigation, and unchanged-note close making no detail read/write; a 1,000-note harness run also passed. `./gradlew testDebugUnitTest assembleDebug lintDebug`, `npm run test:native`, `npm run test:sync`, `npm run test:reminders`, and `npm run test:mcp` passed. Native search, reminder-versus-note invalidation, editor generation, connection snapshots, and bitmap sampling tests pass in the Android unit suite.
Reference build/device/fixture: production Angular build; headless Chromium 154; 240 synthetic notes; Android Robolectric/unit/debug build (no physical device).
Before / after performance evidence: local synthetic 120-frame script time is about 39 ms in this run, compared with earlier temporary runs of about 59 ms after the first UI pass and 809 ms before it; comparison is directional. The 1,000-note harness run completed without browser errors or mobile grid overlap. No Android performance baseline was collected.
Remaining acceptance or blocker: B0 native/repeated-browser traces, supported-device decision, and CI execution on hosted runners; W1 complete cached immutable card model and image/link layout notifications; W2 signal/computed selectors, shared-state mirror removal, full editor-session and online local-first saves, duplicate repair, and attachment/recovery preservation through reconciliation; W5 drawing lazy loading, app builder migration, and deployed asset checks; A1 physical startup/StrictMode verification and user-visible settings-write error recovery; A2 typed Room summary tables/narrow SQL queries, decoded-note identity caching, and physical performance evidence; A4 real-device memory/frame/gesture evidence; other roadmap packages remain pending.
Next dependency: continue W2 normalized state and atomic local edits, then move into the guarded/incremental protocol and complete the web/native editor persistence paths.
```

### 2026-10-06 follow-up

```text
Package / date: W5 route split + W3 offline persistence/error reporting + W2 snapshot recovery/duplicate repair / 2026-10-06
Status: in progress
Files / responsibilities changed: login, register, setup, and user-management screens are standalone lazy routes alongside Settings; OfflineStoreService atomically writes offline note documents and note.upsert outbox entries; OfflineSyncService runs an explicit per-partition duplicate-ID recovery pass and stamps/schedules offline note operations; NotesService uses the transaction for offline create/update/updateKey paths and connectivity-failure fallback and distinguishes local persistence failures; InputComponent keeps the editor open and reports device-storage failure; snapshot reconciliation overlays the latest queued note/reminder edits and honors queued deletes; removed duplicate unused checklist-preview calculations from NotesComponent.
Contract / storage / lifecycle decisions: existing IndexedDB/outbox schema retained; note and outbox entry share one readwrite transaction and operation ID; snapshot content and cursor are reconciled atomically while queued note/reminder intents remain authoritative; full online editor-session and background-save semantics remain deferred.
Checks executed and outcomes: production build passed; Chrome Headless web suite passed (31 tests, including local-storage error classification, queued note/reminder preservation, and explicit duplicate recovery); `npm run benchmark:web` passed (240 notes, zero browser errors, zero mobile overlap, lazy settings load); native/sync/reminder/MCP suites passed (native/sync smoke, 10 reminder, 21 MCP tests); Android unit/build/lint passed.
Reference build/device/fixture: production Angular build; headless Chromium 154; Android Gradle debug/Robolectric.
Before / after performance evidence: main JavaScript chunk is 1.44 MB (~287 KB estimated transfer); Settings is a separate 197 KB (~44 KB transfer) chunk, user management 65 KB, setup 23 KB, login 18 KB, and register 18 KB. Synthetic 120-frame scripting was 39 ms; resize had 24 layout passes and 31 style recalculations, with zero browser errors.
Remaining acceptance or blocker: exercise standalone login/register/setup/admin navigation behavior end-to-end; W3 still needs durable editor sessions, online edits through local commit, storage-failure recovery, and broader command/conflict handling. Drawing remains eager; attachment/recovery preservation, build modernization, and deployment-path checks are open.
Next dependency: continue W3 editor-session/local-first work while progressing W2 selector normalization and remaining W5 feature boundaries.
```

### 2026-10-07 follow-up

```text
Package / date: W3 local-first existing-note updates / 2026-10-07
Status: in progress
Files / responsibilities changed: NotesService.update now atomically commits an edited existing note with its outbox operation before returning, publishes the durable local value, and leaves delivery to OfflineSyncService; added a regression test covering the local-first path.
Contract / storage / lifecycle decisions: existing IndexedDB note/outbox transaction and LWW operation format are reused; full-document edit completion no longer waits for the remote request/retry window. New-note creation and partial field-key updates retain their existing network-first behavior pending compatible command/guarded-save handling.
Checks executed and outcomes: service-spec Chrome Headless suite passed (16 tests, including 3 `notes.service.spec.ts` tests); `npm run build` passed; `git diff --check` passed.
Reference build/device/fixture: production Angular build; Chrome Headless 154 service unit tests.
Before / after performance evidence: no timing benchmark collected; edited existing-note completion is now bounded by the local IndexedDB note/outbox commit rather than network latency, by implementation path.
Remaining acceptance or blocker: local-storage failures must keep the editor open; editor session/draft generations, note creation, `updateKey`, guarded revisions/concurrent field handling, and broader command/conflict recovery remain open.
Next dependency: extend local-first durability to creation and supported field updates without weakening concurrent-label and acknowledgement semantics, then characterize editor-session recovery.
```

### 2026-10-07 continuation

```text
Package / date: W3 online local-first create/update and attachment durability; W2 cursor/identity recovery; C1 outbox receipts/contracts; W5 application builder/deployment; W6 preview retry; A1 settings error reporting; A4 cancellable shared media / 2026-10-07
Status: in progress
Files / responsibilities changed: NotesService routes authenticated full-note creates/updates through atomic IndexedDB document/outbox commits, resolves a stale temporary editor ID by syncId after server acknowledgement, and sends durable outbox operation IDs; explicitly-unsent note upserts coalesce while potentially sent and legacy-unknown operations remain immutable. Operations are marked potentially sent before transport. Partition-scoped Web Locks serialize cross-tab sync cycles, with server receipt replay as the fallback. Attachment staging commits blob/attachment/note/upload intent in one transaction, snapshot and incremental change-page reconciliation preserve pending local work and advance cursors atomically, and failed attachment persistence leaves the editor open for retry. Cached card pages preserve an already hydrated full document while refreshing server title/card metadata; local projection refreshes preserve pagination cursors. Overview checklist actions clone rows; failed link-preview promises expire with a 30-second retry cooldown and bounded resolved cache. Added architecture and sync-protocol docs. Migrated Angular to the application builder with explicit output path/budgets; removed the empty PurgeCSS setup; Express serves immutable hashed assets, revalidating entry points, and gzip. Android settings-write errors now reach a Compose dialog; media loads are shared with last-consumer cancellation and OkHttp cancellation propagation.
Contract / storage / lifecycle decisions: IndexedDB and the established LWW wire format remain authoritative for web note saves; `syncId` survives negative-to-positive numeric ID remapping; staged attachment data and replay intent commit atomically; incremental page records and their durable cursor commit in one transaction; the mutation high-water cursor remains distinct from the durable change-feed cursor. Android raw note/outbox ownership is unchanged.
Checks executed and outcomes: `npm run build` passed (1.46 MB initial, ~285 KB estimated transfer); full Chrome Headless suite passed (45 tests; 29 service specs); `npm run test:native` and `npm run test:sync` passed; earlier `npm run test:reminders` (10 tests), `npm run test:mcp` (21 tests), and `./gradlew testDebugUnitTest assembleDebug lintDebug` passed; `npm run benchmark:web` passed at 240 notes (41.01 ms script, 23 resize layouts, no browser errors); 1,000- and 10,000-note harness runs completed without browser errors or mobile overlap; production Docker image built and served the entry point, hashed CSS, worker, and gzip response; `git diff --check` passed.
Reference build/device/fixture: Node 24 production Angular build; headless Chromium 154; Docker Node 24 image; Android Robolectric/debug build. `adb devices -l` found no attached device.
Before / after performance evidence: application-builder output reduced initial raw/estimated-transfer bytes from about 1.60 MB/317 KB to 1.45 MB/284 KB. The 10,000-note harness still measured about 1,032 ms of script work during the 120-frame synthetic scroll sequence despite keeping first-paint cards at 87; this fails the planned scaling objective and keeps W7 open.
Remaining acceptance or blocker: W2 still needs typed full-note/card types, selector/signal migration, ordered query indexes, and broader recovery/duplicate coverage. W3 still needs a complete editor-session/draft model, guarded partial updates, auth/conflict recovery, and successor revision-chain semantics. W1 cached card model/layout notifications and W4 editor/grid/overlay extraction remain incomplete. W5 drawing/composer deferral remains open. W6 search cancellation and drawing hot paths remain open. W7 virtualization is required by the 10,000-note result. A1 certificate/Keystore and startup traces, A2/A3/A5/A6 device and architecture work, full S1 server extraction, W8 zoneless migration, and Q0 remain incomplete. No physical Android device is attached for the API 34/API 35/API 36 acceptance journeys.
Next dependency: address the measured 10,000-note web interaction cost and finish guarded/recoverable local-first editor sessions; then continue the native projection/sync work and arrange physical-device acceptance.
```

### 2026-10-07 large-package continuation

```text
Package / date: W3 safe note-outbox coalescing/cross-tab serialization; A2 typed home-card projection; A5 no-op sync side-effect suppression; S1 static/capability/mutation-route extraction; W7 variable-height list virtualization / 2026-10-07
Status: in progress
Files / responsibilities changed: IndexedDB note mutations now coalesce only explicitly-unsent upserts; queue claims mark operations potentially sent before transport, and legacy entries lacking send-state metadata stay immutable. OfflineSyncService serializes sync cycles by profile partition using Web Locks, retaining receipt replay as the fallback. KeptRepository now compares incremental records/occurrences before writes and skips full reminder/widget reconciliation on a no-op sync. Express static delivery/cache policy moved to `server/static-assets.js`, and capability negotiation moved to `server/client-capabilities.js`. NotesComponent coalesces scroll expansions and now renders list mode through a stable-key, measured variable-height window with Fenwick-tree offsets, overscan, spacer extents, scroll-anchor correction, and page-sentinel integration; the harness reports top/mid-scroll mounted counts. Android builds immutable `NoteCardUiModel` values and prepares search/filter/reminder/card fields off main before Compose.
Contract / storage / lifecycle decisions: existing operation IDs and payloads remain unchanged after send; new `deliveryState` metadata distinguishes known-unsent work from sent/legacy-unknown operations without an IndexedDB version change. No-op native sync still updates durable cursors/status but does not refresh widgets or re-register reminders.
Checks executed and outcomes: `npm run build` passed (1.47 MB initial, ~288 KB estimated transfer); full Chrome Headless suite passed (53 tests); native-client/sync/reminder/MCP suites passed; `./gradlew testDebugUnitTest assembleDebug lintDebug` passed, including typed projection and no-op sync side-effect tests; Docker image build passed; `git diff --check` passed.
Reference build/device/fixture: Node 24/Angular production build; Chrome Headless 154; Android Robolectric; Docker Node 24 image. No device is attached.
Before / after performance evidence: the current 10,000-note Bricks fallback measured 1,150.17 ms synthetic-scroll script time with 87 mounted cards; the opt-in grid experiment mounted 15/20 cards at first paint/after scroll, passed overlap checks, and measured 1,749.23 ms. It remains off by default. The variable-height list window mounted 6/7 rows at the top/mid-scroll.
Remaining acceptance or blocker: W7's grid prototype needs more optimization plus drag/accessibility/focus/return-position and release-memory checks; Bricks remains the default. W3 still lacks guarded web mutations/conflict UI, durable editor-session generations, and successor revision chaining. A5 still needs resource-specific ChangeSets and batched widget effects. A2 still needs a HomeViewModel, narrow Room projections, and screen extraction; S1 still needs the database/notes/reminder/media/auth domain extractions. W4, W8, A3/A6, and physical-device Q0 work remain open.
Next dependency: optimize and behavior-test the opt-in grid adapter, then continue guarded/recoverable editor sessions and native projection work.
```

### 2026-10-07 approved scope consolidation

```text
Package / date: plan consolidation into M1–M6; widget icon and v2 release tasks / 2026-10-07
Status: complete (documentation consolidation only; implementation/release remains in progress)
Files / responsibilities changed: PLAN.md merges the 154 unchecked bullets into 32 active work items across six milestones, moves repeated completion criteria into eight shared release gates, separates deferred/evidence-triggered mechanisms, and records existing native/editor/observer evidence as a baseline to re-verify. Added M5.6 widget/main icon consistency and M6.7 coordinated v2.0.0 versioning.
Contract / storage / lifecycle decisions: all content, durability, replay, concurrency, cursor, profile, reminder/widget, lifecycle, migration, compatibility, and release requirements remain. Zoneless migration and optional tools/schema/exhaustive reorganizations are not independent release blockers. Historical execution entries are unchanged.
Checks executed and outcomes: reviewed milestone coverage and old-package mapping; verified 32 active unchecked items, unique task IDs, balanced code fences, unchanged historical log and .gitignore bytes; git diff --check passed. No runtime suites were required for this documentation-only change.
Reference build/device/fixture: no new runtime benchmark or device run; current version/icon references were inspected for task context.
Before / after performance evidence: no application changes or performance claim; active checklist count reduced through approved scope consolidation, not by declaring unimplemented behavior complete.
Remaining acceptance or blocker: M1–M6 and G1–G8 remain open as recorded; widget artwork and version metadata still require implementation; physical-device gates need supported hardware.
Next dependency: M1 durable partial writes/session/conflict work and M2 scaling diagnosis; widget-icon investigation can proceed independently.
```

### 2026-10-07 widget/version verification

```text
Package / date: M5.6 widget preview artwork; M6.7 coordinated v2 version metadata / 2026-10-07
Status: implementation and automated verification complete; physical-device and release gates remain open
Files / responsibilities changed: Both Android widget provider XML resources declare the existing `@drawable/kept_icon` as their picker preview. Android resource contract tests verify both references and the Android version metadata; server capability tests assert the advertised version matches root package metadata. Root package and lockfile versions are `2.0.0`; Android `versionName` is `2.0.0` and `versionCode` is `2`.
Contract / storage / lifecycle decisions: application icon artwork is shared by the widget-picker previews; notification small-icon handling remains separate. Version metadata changes do not alter package/application identity.
Checks executed and outcomes: `npm run build` passed; Chrome Headless full suite passed (53 tests); native-client, sync, reminder (10 tests), and MCP (21 tests) suites passed; `./gradlew testDebugUnitTest assembleDebug lintDebug` passed; `docker build -t kept-plan-verify .` passed, including clean `npm ci` and production build; `git diff --check` passed. An initial Android test compilation exposed a missing generated `R` import; fixed and the full Gradle command then passed.
Reference build/device/fixture: Node 24 production build and Docker image; Chrome Headless 154; Android Robolectric/debug build. No physical Android device is attached.
Before / after performance evidence: no performance claim; this slice changes widget preview resources and release metadata only.
Remaining acceptance or blocker: confirm visual preview/placed-widget behavior on supported launchers and Android versions, verify nondestructive v1-to-v2 installation, prepare release notes, and establish signing/distribution under M6.4/M6.6.
Next dependency: continue M1/M2 correctness and scaling work; schedule M6.4/M6.6 device and release acceptance when hardware and distribution configuration are available.
```

### 2026-10-07 durable partial-update continuation

```text
Package / date: M1.1 web field-only durable updates / 2026-10-07
Status: one partial-update path implemented and verified; M1.1 remains in progress
Files / responsibilities changed: Positive-ID `NotesService.updateKey()` calls now commit the merged local note and a `note.patch` outbox entry atomically through OfflineSyncService/OfflineStoreService. Known-unsent note upserts are safely replaced by a fresh full upsert; sent or legacy-unknown operations remain immutable and later field patches stay separate. Offline snapshot and incremental change-page reconciliation overlay only pending patch fields over server notes. The sync mutation endpoint applies an allowlisted patch to the latest accessible server note and records successful operation receipts transactionally. Added client store/service and server retry/concurrent-unrelated-field regression coverage.
Contract / storage / lifecycle decisions: `note.patch` applies named fields against the latest server note, preserving unrelated concurrent edits; full-document `note.upsert` remains a separate path with existing revision/conflict behavior. Operation identity and field patch payload are retained for replay.
Checks executed and outcomes: full Chrome Headless suite passed (59 tests); `npm run build` passed; sync smoke passed, including unrelated-field preservation, operation receipt replay, rejection of server-managed patch fields, and collaborator-only pin behavior; native protocol, reminder (10 tests), and MCP (21 tests) suites passed; Node syntax checks and `git diff --check` passed.
Reference build/device/fixture: Node 24/Angular production build; Chrome Headless 154; isolated SQLite sync smoke server.
Before / after performance evidence: no benchmark collected; this changes persistence/replay semantics for partial-field updates.
Remaining acceptance or blocker: remaining overview checkbox, organization, and clone/merge writes must be audited; full-document guarded conflicts, recovery UI, and successor acknowledgement chains remain open under M1.2–M1.4.
Next dependency: audit remaining partial mutation callers, then add guarded conflict and acknowledgement recovery for full-document saves.
```

### 2026-10-07 durable clone continuation

```text
Package / date: M1.1 local-first single-note clone / 2026-10-07
Status: clone path implemented and verified; M1.1 remains in progress for merge
Files / responsibilities changed: With an active offline partition, `NotesService.clone()` now requires a complete source document, assigns a fresh sync identity and owned profile metadata, clears collaborator/attachment/personal-collapse state, and calls the existing local-first `add()` command. The clone is immediately local and is created remotely through the existing replayable note-upsert outbox path. Legacy direct-endpoint fallback remains when no offline partition is active.
Contract / storage / lifecycle decisions: clone semantics preserve the server clone's complete note content while treating it as a new note with a new identity and current owner. Attachments are not copied, matching the existing clone endpoint; note images/content are retained.
Checks executed and outcomes: full Chrome Headless suite passed (60 tests), including a clone regression for rich content, identity and ownership reset; `npm run build` passed; `git diff --check` passed.
Reference build/device/fixture: Node 24/Angular production build; Chrome Headless 154.
Before / after performance evidence: no benchmark collected; clone now commits locally before replay rather than waiting on a network request.
Remaining acceptance or blocker: merge still performs server-side source trashing, attachment reparenting, pending-reminder selection, and external-calendar cleanup. Moving it to the outbox requires a receipt-backed operation that preserves these transactional and retry semantics. Physical/offline end-to-end clone acceptance remains part of M6.
Next dependency: characterize merge's transaction/side effects and add a replay-safe mutation before changing its client path; continue M1.2–M1.4 full-document session/conflict work.
```

### 2026-10-07 receipt-backed local merge continuation

```text
Package / date: M1.1 durable web merge and resource dependency handling / 2026-10-07
Status: M1.1 local-first command paths implemented and verified; broader M1 persistence/conflict work remains open
Files / responsibilities changed: `NotesService.merge()` obtains complete owned sources, reproduces ordered merge content (including checklists, images/drawing flattening, labels, locks, and unknown fields), and commits through `OfflineSyncService.persistNoteMerge()`. `OfflineStoreService.persistNoteMergeMutation()` atomically stores the merged note, source trash/unpin state, attachment reparenting, earliest pending reminder, deletion of later pending reminders, and one `note.merge` outbox operation. Source attachment upload intents retain their original note identity and operation data; `flushOutbox()` flushes source uploads before merge, then merged-note deletes/reminders/uploads afterward. Server receipts make the operation replayable; the transaction preserves attachment/reminder sync changes and post-commit external-calendar cleanup.
Contract / storage / lifecycle decisions: source notes resolve by stable sync identity. Server mutation ordering applies queued note/reminder work before `note.merge`, then permanent note and attachment deletions afterward. Merge acknowledgements contain identity only; the durable change feed carries authoritative note and dependent-resource updates. No IndexedDB schema migration was needed.
Checks executed and outcomes: full Chrome Headless suite passed (66 tests), including dependency-ordering coverage; `npm run build` passed; `npm run test:sync` passed, covering receipt replay, attachment reparenting, reminder ordering/change-feed updates, and source trash; native protocol, reminder (10 tests), and MCP (21 tests) suites passed; Node syntax checks and `git diff --check` passed.
Reference build/device/fixture: Node 24/Angular production build; Chrome Headless 154; isolated SQLite sync smoke server.
Before / after performance evidence: no benchmark collected; this slice adds local merge persistence and server replay-safe resource transactions.
Remaining acceptance or blocker: two-tab fallback behavior and permanent-delete/merge successor races remain under M1.4. Validate offline/online merge, restore/undo, and external-calendar behavior through M6 acceptance.
Next dependency: continue M1.2–M1.5 editor sessions, guarded full-document conflicts, and reconciliation recovery.
```

### 2026-10-07 durable editor sessions

```text
Package / date: M1.2 durable web editor sessions / 2026-10-07
Status: implemented and verified by unit/build checks; no browser-driven editor lifecycle test and no device run
Files / responsibilities changed: new pure session model + serialized persister (`utils/editor-session.ts`); `OfflineStoreService` put/get/list/delete editor sessions in a separate IndexedDB, purged with the partition on sign-out; `NotesService.editorSessions()` facade; `InputComponent` captures drafts (debounced from the existing edit hooks), flushes on hidden/pagehide/beforeunload/destroy, wraps `saveNote()` with begin/succeeded/failed transitions, restores dirty fields on open, and shows a status line (`Unsaved changes`, `Saving…`, `Not saved yet…`, recovery-copy failure). `noteSaveSnapshot` now derives from the shared `editorDraftFromNote`.
Contract / storage / lifecycle decisions: drafts sit beside, not inside, the note store and outbox, so `note.upsert/patch/merge` operation identity, coalescing and replay are untouched. Separate DB avoids a schema bump that older builds cannot open. Recovery overlays only dirty fields (concurrent remote changes to other fields survive); full-document conflict detection stays M1.3. Pending attachment files and reminder picks are not part of drafts. New-note drafts use one slot per profile.
Checks executed and outcomes: Chrome Headless suite 77/77 (twice; 11 new tests: tracker generations/dirty fields/base advance during save/failure, dirty-field overlay, persister ordering, storage-failure retry, restore, IndexedDB session store and purge); `npm run build` passed; `npm run test:sync` passed; `git diff --check` clean. One unrelated pre-existing flake seen once in 5 runs: `preserves legacy outbox entries with unknown send state` (outbox order assertion; outbox code unchanged).
Reference build/device/fixture: Node 24/Angular production build; Chrome Headless 154.
Before / after performance evidence: none collected; capture is debounced and compares normalized drafts only.
Remaining acceptance or blocker: `InputComponent` glue (restore, flush on lifecycle events) is covered only through the model/store tests, not a component test; physical-device background/kill acceptance belongs to M6. `remoteState` stays `queued` until M1.4 acknowledgement chains.
Next dependency: M1.3 guarded web conflicts.
```

### 2026-10-07 guarded conflicts and acknowledgement chains

```text
Package / date: M1.3 guarded web conflicts + M1.4 safe acknowledgements / 2026-10-07
Status: implemented and verified by unit, fake-server and smoke checks; no real-browser multi-tab run and no device run. Delivered as one commit because guards are only safe together with acknowledgement chaining.
Files / responsibilities changed: `utils/note-merge.ts` (field canonicalisation, three-way merge); `OfflineStoreService` (`guard`/`blocked` outbox fields, guard derivation inside the note+outbox transaction, atomic acknowledge-and-advance in `removeOutbox`, `replaceRejectedNoteUpsert`, `discardPendingNoteUpserts`, `blockOutboxEntry`, HLC tie-break in `listOutbox`); `OfflineSyncService` (capability negotiation, chained/deferred sending, 409/403/404 handling, `attention$`, `resolveBlockedNote`, `auth-required`); main component banner and resolution actions; server `note.patch` acknowledgement now includes `revision`.
Contract / storage / lifecycle decisions: no IndexedDB schema change (new fields live on existing outbox records, so older builds still read them and ignore the extras). Unguarded legacy entries stay unguarded so their edits remain visible to the merge. Rejections are never recorded as server receipts, so a rebased save uses a new operation ID. Sent/legacy-unknown operations are immutable. Conflict resolution never discards the local document until the user picks an option.
Checks executed and outcomes: Chrome Headless 101/101 on three runs (24 new tests: merge rules; guard derivation, coalescing, chaining, legacy handling, atomic replace, ordering; fake-server flows for guarded send, legacy fallback, auto-merge, parked conflict, keep mine / use theirs, revoked access, lost-response replay with chained successor, no same-request chaining, cache overlay vs. acknowledgement, concurrent-device rebase, two-tab without Web Locks, lock vs. direct `syncNow`); `npm run build`, `test:sync` (extended with patch revision acknowledgement), `test:native`, `test:reminders` (10), `test:mcp` (21), `node --check server/server.js` and `git diff --check` passed.
Reference build/device/fixture: Node 24/Angular production build; Chrome Headless 154; fake in-test server plus isolated SQLite sync smoke server.
Before / after performance evidence: none collected; guard derivation reuses the existing outbox scan and one extra keyed read.
Remaining acceptance or blocker: the conflict banner and `InputComponent` flows are not exercised in a browser; two real tabs and an interrupted real network are M6 acceptance. The editor session's `remoteState` still reads `queued` (it is not wired to outbox acknowledgement); the outbox is authoritative. Shared-note collaborator edits and `note.merge` do not use guards. Chains whose predecessor acknowledgement carries no revision fall back to the cached revision.
Next dependency: M1.5 reconciliation and upgrades.
```

### 2026-10-07 reconciliation and upgrade hardening

```text
Package / date: M1.5 reconciliation and upgrades / 2026-10-07
Status: implemented and verified by unit/build/smoke checks; no real-browser upgrade or two-account run
Files / responsibilities changed: `OfflineStoreService` (dependent ID remap in `applyChangePage` and `replaceSnapshot`, `hasUnsyncedWork`, abort-on-throw for `transaction()` and note/patch mutations); `OfflineSyncService` (profile-scoped bootstrap/pull/flush/upload responses, sign-out retention policy).
Contract / storage / lifecycle decisions: no schema change. Retaining an unsynced profile after sign-out trades some on-device privacy for no silent data loss; it stays isolated by user partition and is purged on the next clean sign-out. Draft/session storage is a separate database, so main-schema upgrades cannot touch it.
Checks executed and outcomes: Chrome Headless 112/112 on three runs (new: dependent remap through change page and snapshot, three profile-switch races, two sign-out retention cases, two interrupted-commit atomicity cases, legacy-schema open + chaining, older-reader field check); `npm run build`, `test:sync` and `git diff --check` passed.
Reference build/device/fixture: Node 24/Angular production build; Chrome Headless 154.
Before / after performance evidence: none; remap scans reminders/attachments only when a local ID is replaced.
Remaining acceptance or blocker: rollback to a pre-M1 build with queued guarded entries was reasoned about (extra fields are ignored) but not executed; real multi-account/offline sign-out journeys belong to M6.
Next dependency: M2.1 canonical document/query ownership.
```

### 2026-10-07 canonical note query and preview boundary

```text
Package / date: M2.1 canonical document/query ownership / 2026-10-07
Status: implemented and verified by unit/build checks; no browser interaction run
Files / responsibilities changed: new `utils/note-query.ts` (+ spec) moved out of `pipes/notes-tools.pipe.ts`; `NotesStoreService` unpinned selector; `NotesService.fullDocument`/`NoteIncompleteError` and `updateKey` preview flag; `NotesComponent` overview checkbox and image commands.
Contract / storage / lifecycle decisions: no storage or protocol change. Search scope still widens only home/binder views; archived, trashed, shared, reminders, attachments and label views search within themselves (characterized, not changed).
Checks executed and outcomes: Chrome Headless 129/129 on two runs (17 new tests: view membership incl. missing flags, scopes, labels, sharing, attachments, reminder ordering; text/typo/operator/date search; preview search text; identity preservation for empty queries; unpinned fallback; full-document/preview rules and patched-preview flag); `npm run build`, utils `node --test` and `git diff --check` passed.
Reference build/device/fixture: Node 24/Angular production build; Chrome Headless 154.
Before / after performance evidence: none; the engine is the pipe's logic moved unchanged apart from the semantic fixes above.
Remaining acceptance or blocker: `Shared.note.*` section setters and `notes$` remain compatibility facades; consumers that read `notesList$` directly were not migrated.
Next dependency: M2.2 narrow card updates.
```

### 2026-10-07 narrow card updates

```text
Package / date: M2.2 narrow card updates / 2026-10-07
Status: implemented and verified by unit/build checks; not exercised in a browser
Files / responsibilities changed: new `utils/note-presence.ts`; `NotesService` presence/profile delta publication and `deleteImage`; `UserPreferencesService` change/layout helpers; `NotesComponent` notes/reminders/preferences subscriptions and delete-image error handling.
Contract / storage / lifecycle decisions: presence remains presentation-only and is never persisted. Unchanged notes keep object identity, so OnPush cards and the per-note meta/presentation caches are reused. Card async values (link-preview meta, time format) keep keying on the preferences they use.
Checks executed and outcomes: Chrome Headless 138/138 on three runs (9 new tests: immutable presence incl. untouched collaborators, presence-only vs. layout-changing publications, reminder chip key, preference change classification, delta publication of presence with unchanged identities, image deletion on a complete document and refusal on a preview); `npm run build`, `test:sync` and `git diff --check` passed.
Reference build/device/fixture: Node 24/Angular production build; Chrome Headless 154.
Before / after performance evidence: none collected; the change removes full-collection republication and layout rebuilds for presence/preference/reminder noise, to be measured in M2.4/M6.2.
Remaining acceptance or blocker: media/link resize handling relies on the existing per-card ResizeObserver and was not run in a real browser; the `Shared.note.*` section setters still publish the whole collection for reorder operations.
Next dependency: M2.3 version/cancel stale requests.
```

### 2026-10-07 stale request versioning

```text
Package / date: M2.3 version/cancel stale requests / 2026-10-07
Status: implemented and verified by unit/build checks; the editor-open token was reviewed but has no automated component test
Files / responsibilities changed: new `utils/request-gate.ts` (+ spec); `NotesService` load/loadNextPage/get/publishCachedNotes/publishChangedCachedNotes; `NotesComponent` backfill loop.
Contract / storage / lifecycle decisions: cancellation is client-side (`takeUntil` unsubscribes the XHR); no server change. Pull-to-refresh and cache-change projections keep their existing triggers; they are now ordered rather than debounced.
Checks executed and outcomes: Chrome Headless 148/148 on two runs (10 new tests: gate semantics and cancellation; old-query request cancelled and unpublished; queued load superseded; next page discarded after refresh without cursor rewind; account change drops in-flight work; newest cache projection wins; changed-note publication re-derived after interleaving); `npm run build` and `git diff --check` passed.
Reference build/device/fixture: Node 24/Angular production build; Chrome Headless 154.
Before / after performance evidence: none; fewer obsolete page requests complete and publish.
Remaining acceptance or blocker: end-to-end typing-while-scrolling behavior in a real browser is not covered.
Next dependency: M2.4 scaling diagnosis.
```
