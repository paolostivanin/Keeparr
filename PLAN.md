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
- [x] **M2.4 — Diagnose and resolve scaling costs.** The harness gained a repeatable `--profile` journey (cold/warm start, search, scroll-through, mounted counts, optional CPU profile with inclusive time and a readable development build) and `npm run benchmark:web:scale` (median/worst of N at 100/1,000/10,000 notes); numbers are in `docs/performance.md`. Findings: interaction-critical cost was flat in collection size on a cold start (~0.6 s) but, on a warm 10,000-note start, the first card waited ~1.27 s for every stored note to be read and published; background cost grew ~linearly (cold 0.15 s → 1.6 s from 100 → 10,000). Remedies applied for measured causes: (1) navbar label/binder menus scanned the whole collection on every change-detection pass even with nothing selected (≈225 ms of scripting at 10,000) — now O(1) without a selection and memoized with one; (2) the sidenav's overflow probe forced layout on every observer/scroll/resize event — coalesced to one read per frame; (3) a persisted "display window" (first 120 syncIds, stored under its own key in the existing sync-state store) lets a warm start paint the top of the list from point reads while the full read continues — warm 10,000-note first card 1,274 → 324 ms; (4) the duplicate-identity repair that ran on every start now finds duplicates from index keys without deserializing notes; (5) a republished collection keeps the object identity of unchanged notes (also preserving presence flags). Trade-off: the full read/publish now happens after the first card, so total warm scripting at 10,000 notes is higher (~2.1 s vs ~1.4 s) though off the critical path; its profile is Angular rendering of the republished list. Grid prototype vs Bricks at 10,000 notes: equal first card and scroll-through scripting, 15 vs 70 mounted cards, but worse cold background scripting (1.9 s vs 1.3 s) and more heap, so Bricks stays the default and the grid stays opt-in.
- [x] **M2.5 — Accept bounded renderers.** Audited and fixed what was reproducible without a device. Experimental grid window: the model served *stale note objects* when the same cards were set again with unchanged geometry (an edited note kept rendering its old version) — it now refreshes items and the component re-emits the visible window when an item changes; the height-measurement path that is actually live lacked the scroll anchoring that only an unused duplicate had, so late media above the viewport shifted visible cards — the duplicate was removed and the anchored implementation is the single one. Keyboard: cards were not reachable (click-only) — the card body is now focusable, Enter/Space on the card itself opens it (keys inside controls keep their meaning), and closing the editor returns focus to that card (re-focused after the scroll restore if its row was unmounted). Touch drag now autoscrolls near the viewport edges (`dragAutoScrollDelta`, re-testing the card under the finger each step so targets mount as the window moves) and stops with the drag. Selection is ID-based, so it does not depend on mounted cards (`selectedNotesOf`). List and masonry models are validated separately (keyed measurement retention across pin/reorder, late-media growth, item freshness); one layout engine still owns each DOM tree (list window, Bricks, or opt-in grid). Browser-verified with the harness in list/Bricks and grid modes at 1,000 and 10,000 notes: bounded mounted counts, no overlap, keyboard open and focus return. Not verified: physical touch/desktop drag across virtualized rows, real late-loading media, autoscroll feel, screen readers (M6.5).

### M3 — Focused web editor/layout ownership and cleanup

Primary owners: `InputComponent`, `NotesComponent`, focused feature/domain adapters.

- [x] **M3.1 — Editor/persistence boundary.** Session/save state already lives in `utils/editor-session.ts` (M1.2); the remaining non-DOM editing logic that was embedded in `InputComponent` is now framework-free and characterized: `utils/checklist-model.ts` (row normalization/id repair, depth change that carries children, done-toggle that carries children, and `ChecklistHistory` structural undo/redo with the 80-step bound and the "text typed after the last structural change belongs to the browser undo" rule) and `utils/editor-body.ts` (stored body ⇄ editor HTML: link/URL preview slots, stripping editor-only chrome on save, URL extraction). The component keeps DOM, caret/IME, paste, drag and focus ownership and delegates to these; behavior is unchanged (round trip of rich formatting, links, inline-image wrappers is asserted). Drawing, reminders, places and collaborator panels were not moved (no cohesion gain demonstrated).
- [x] **M3.2 — Layout/gesture boundary.** `utils/layout-scheduler.ts` (`LayoutScheduler`) is now the single owner of repack timing: one pending frame, signature de-duplication, a single cancellable viewport/rotation settle sequence (immediately, after paint, +80 ms, +220 ms) and disposal; `NotesComponent` no longer keeps its own frame/timer/signature fields. Element-driven inputs already existed and are unchanged (container and per-card `ResizeObserver`, load-more `IntersectionObserver`, window/list/grid models). The per-pass work in `ngAfterViewChecked` was the remaining polling: the page/search/scope/view context string is now rebuilt only after an event (`SharedService.searchQueryChanged$`, scope/view subjects, page-name update) instead of on every change-detection pass. Gesture lifecycle: destroying the view mid-touch-drag used to leave the document `touchmove` listener, the ghost clone, page `touch-action`, the autoscroll frame loop, the long-press timer and the pull-to-refresh settle timer alive; `ngOnDestroy` now ends the drag (uncommitted) and clears both timers. Selection is ID-based (M2.5) and unchanged.
- [x] **M3.3 — Overlay state and callbacks.** The note editor overlay is now driven by `NotesComponent.editorOpen` (template binds `display` and the editor `@if` to it) and mirrored for other components in `SharedService.noteEditorOpen$`; Escape, scroll pagination, pull-to-refresh and the widget open/compose paths read that state instead of `modalContainer.style.display`, and `AppComponent` no longer queries the DOM with `getComputedStyle` to decide whether the editor is open. The reminder picker and editor overlay are root-level siblings of the card list (not inside transformed cards), and the existing focus return (M2.5) is unchanged. Callback audit under the current coalesced Zone.js mode: timepicker confirmations (notes and editor), Capacitor widget/back-button/deep-link handlers, share-intent, online/offline, `selectionchange` and location handlers already re-enter the zone; link-preview uses `markForCheck`; clipboard results run in the user-event zone. Two real gaps were fixed: Zone.js does not patch `ResizeObserver`, so the sidenav's scroll-cue state (set from a frame requested by an observer callback) and the drawing canvas resize ran outside Angular and could leave the view stale — the sidenav now publishes a changed cue inside the zone only when the value changes, and the drawing observer callback runs in the zone. The reminder banner observer only writes a CSS variable and needs no view update. Sidenav's own `display` toggles for its label/binder dialogs are presentation-only (no logic depends on them) and were left. Zoneless migration stays deferred (section 5).
- [x] **M3.4 — Bounded resource lifecycle.** Audited `InputComponent`, `NotesComponent` and the offline store for owners of subscriptions, timers, observers, listeners and object URLs; fixed what was reproducible. New `utils/disposables.ts` (`Disposables`: tracked timeouts/frames/listeners, idempotent dispose, nothing attachable afterwards). Gaps closed: the editor's document `mousedown` listeners (composer and reminder picker) and the deferred "attach picker listener" timeouts (which could attach a document listener after the editor was destroyed; same in `NotesComponent`), the drawing `ResizeObserver`, the time picker instance, the checklist suggestion/touch-drag timers and drag image were not released on destroy; cached offline-media object URLs were never revoked (now revoked per partition on `purgePartition` via `releaseMediaUrls`; URLs of a live partition stay stable because rendered images use them). Drawing undo memory: `DrawingHistory` (`utils/drawing-history.ts`) replaces the unbounded array of PNG data URLs with a stack capped at 40 snapshots and 24 M characters (current state plus one undo step always kept), and is released on destroy. Encoding cost: a stroke previously encoded the canvas twice (history and note image) and undo/redo re-encoded the restored canvas; each stroke now encodes once and undo/redo reuse the stored snapshot. Typing no longer parses and serializes the whole body on every keystroke just to refresh the length cue (coalesced to one frame, cancelled on destroy). Drawing serialization format, `Drawing|bg:` names, save/session paths and native-shell/Smart Capture entry points are unchanged. Not changed (reviewed): pending permanent-delete timers (they must still commit), the deferred 1 s revoke in the browser-download helper, and the settings export download (revokes right after click).

### M4 — Android editor/startup/projection lifecycle

Primary owners: `Connection`, `MainActivity`, `NoteEditorViewModel`, rich-text AndroidView adapter, home projections, `KeptRepository`, `Media`.

- [x] **M4.1 — Nonblocking initialized startup.** Audited the startup path. Off main (verified, now covered by a test that the DataStore read runs on another thread): settings read and Keystore decryption (`ConnectionSettings.initialize` on `Dispatchers.IO`), persistence writes, and TLS client creation including `KeyChain` certificate access (`KeptApi.client` is only reached from IO callers: `call`, `foreground`, media upload/download). Room opens lazily on its first query, which the notes `Flow`s run off main (`flowOn(Default)`). Fixed: the signed-in state and dark theme were seeded from a `LaunchedEffect` after the first ready composition, so a user with a stored session saw one login-screen (and light-theme) frame before home; they are now derived in the same composition (`ui/StartupGate.kt`, explicit sign-in/sign-out/theme overrides still win). An unreadable settings store already completed startup with cached notes retained; its message now also says what to do ("Sign in again to continue") and is shown on the login screen that follows. Immutable `ConnectionSnapshot`s, profile-switch confirmation and nondestructive reauthentication are unchanged.
- [x] **M4.2 — Lifecycle and session disposal.** Findings and fixes: (1) startup recovery (alarm-registry reset, reminder/widget reconciliation, sync scheduling) ran in every `MainActivity.onCreate`, i.e. again after each rotation; it is now `KeptApplication.ensureStartupRecovery()`, once per process, and `onResume` no longer joins anything. (2) `foreground()` checked-then-created the realtime socket across a suspension, so concurrent callers (start, login, reconnect) could open several sockets, and each disconnect could stack reconnect jobs or tear down a replacement socket; socket reconciliation is now serialized behind a mutex that re-reads the wanted state, closed sockets only act if they are still current, one reconnect job at a time, and `setForeground()` records the wanted state synchronously so a quick stop/start (or stop-only) resolves to the latest. A configuration change keeps the socket and skips the repeat foreground sync. (3) A recreated activity re-handled the launching intent (share/quick-create/widget action), repeating its action after rotation; the launch intent is now taken only on first creation. (4) Editors were keyed inside the activity's own `ViewModelStore`, so every opened note's `NoteEditorViewModel` (with its snapshot collectors and draft copy) lived until the activity died and a reopened note reused a stale session; sessions now live in per-editor stores held by `EditorSessionStores` (keyed by profile and syncId, surviving rotation) and are released on an explicit close, which cancels their coroutines. (5) The open note was lost on rotation/process restoration (editor silently closed); its syncId is now saved and the note reloaded from Room, where the draft is already persisted on every change. `finish()` durability, recovery drafts and profile isolation are unchanged.
- [x] **M4.3 — Editor hot paths.** Measured by inspection of the per-keystroke path: each change copied the whole note (serialize+parse, including inline images/drawings), `repository.save` copied it again and serialized it twice, a Room write plus outbox write ran for every keystroke (earlier ones only cancelled), and the 600 ms idle flush re-wrote the identical, already-committed draft. Now: (1) `NoteEditorViewModel.change(vararg touched)` deep-copies only the named top-level fields (`copyForEdit`; title/body/pinned/checklist call sites name theirs) and shares the rest with the previous draft, whose snapshot is never mutated; an unnamed `change {}` still copies everything. (2) `KeptRepository.save` shallow-copies and serializes once. (3) Local persistence is debounced (250 ms) with a hard bound of 1 s of unsaved time during continuous typing, serially owned by the existing persistence mutex and generation counters; `persistedGeneration` makes a later `flushAndQueueSync` skip rewriting a committed draft and only call `queueSync()`, and prevents the pending write from duplicating a flush. `finish()` first commits an emptied draft still in the debounce window (otherwise the discard/trash decision read stale stored content), `flushLocal()` commits on `ON_STOP`. (4) `EditorSnapshotPolicy.sameEditableContent` compares canonical forms without copying either note. Durability separation is unchanged: local commit does not mean accepted; `dirty` still clears only on an accepted snapshot. Not changed: body text is still serialized with `Html.toHtml` per keystroke (the editor needs the emitted string to detect external resets) and checklist reorder/remove copy the checklist.
- [x] **M4.4 — Narrow home projection work.** Previously every notes/reminders/filter/search change rebuilt a `NoteCardUiModel` for every visible note (HTML parsing per card), re-parsed every note's HTML for each search keystroke, re-derived labels/binders for all notes, and always published a new projection object. Now: `ui/HomeState.kt` owns query, filter, grid/list and selection and their rules (a changed query/filter clears the selection, the same query does not, reordering only where the visible order is the stored order; the screen's scattered effect that cleared selection is gone). `ui/HomeProjector.kt` is an incremental, rebuildable cache keyed by syncId and by `Note` instance identity (the repository already reuses decoded `Note` objects for unchanged rows): cards are rebuilt only for changed notes or a changed reminder line, search text is built once per note instance so narrowing a query only runs `contains`, labels/binders for the drawer are computed per note once, identical inputs return the same projection, and a result that is element-for-element the previous one (for instance an edit to a note outside the current filter) is returned as the same object so nothing recomposes. It runs where the projection already ran, on `Dispatchers.Default`, and raw note JSON stays authoritative (derived values only). The grid keeps `LazyVerticalStaggeredGrid`, `syncId` keys, and now meaningful `contentType`s (text/checklist/image/locked cards, section headers). Room queries/observation were not changed: no profile shows a cost that justifies it (deferred list, section 5).
- [x] **M4.5 — Reliable native media.** Audit result: previews already captured the connection snapshot and refused cross-origin URLs (credentials never leave the server origin; test added), the decoded cache is a 32 MB LRU and the disk cache is capped at 100 MB per profile, and shared preview requests cancelled with their last consumer. Defects fixed: (1) `download` named its cache file from the *live* profile while using the captured snapshot's credentials, so a profile switch mid-download filed one account's media under the other's cache; it now uses the snapshot's profile. (2) Cancelling a download only interrupted the wait for headers; a blocked body read continued (up to 25 MB, leaving a temporary file until it ended) because nothing cancelled the OkHttp call — a watcher child now cancels the call, and the read loop checks for cancellation. (3) Concurrent downloads of one file (different preview sizes, attachments) each fetched it; downloads now share one transfer per file with last-consumer cancellation (`SharedLoader`, also used by the decoded-preview cache, which keeps its semantics). (4) A cache hit did not refresh the file's age, so eviction removed by fetch time not use; hits now touch it. (5) `preview` swallowed `CancellationException` through `runCatching`; it is rethrown. (6) Previews decoded at a fixed 768 px regardless of the slot; `MediaImage` now decodes for its actual slot (`previewDecodeSize`: longest slot side bucketed to 128 px, clamped 128–2048) so rotation/inset changes reuse decodes. (7) Loading showed nothing and failure was silent; the slot now reserves the image's height (last known aspect ratio, else 4:3, bounded by the slot) with a progress indicator, keeps a previous bitmap while a new size loads, and shows an accessible *Retry* on failure. Inline/base64/SVG/drawing previews, original files, and uploads are unchanged.

### M5 — Scoped widget/reminder/sync effects and backend boundaries

Primary owners: `KeptRepository`, workers, reminder scheduler, `widgets/`, server transaction and domain helpers.

- [x] **M5.1 — Committed change/effect scope.** Every local commit and sync result now carries an `EffectScope` (`data/Effects.kt`: changed note syncIds — including a note whose reminder changed —, order changed, alarms affected, full recovery). `KeptRepository.changed()/reconcile(scope)` run only dependent effects: widgets through `NotesWidget.refresh(context, scope)` (a single-note widget refreshes only for its note; collections for membership/content/order changes), alarm reconciliation only when a reminder/occurrence changed or a note appeared, disappeared, was archived or trashed. Previously every edit, reorder, view-state change, upload queueing, sync with any change, and a plain editor close reconciled all alarms and rebuilt every widget. Equivalent writes are skipped: identical synced/queued note saves, reorders that leave the relative order unchanged, trashing already-trashed notes, re-saving an identical synced reminder, repeated dismissals/occurrence actions, unchanged checklist-collapse state; snapshot and change-page application write and report only rows whose payload differs (the snapshot path also reads each kind once instead of per row), so an unchanged bootstrap/snapshot is no longer a reconcile. Widget bursts: `EffectDispatcher` merges scopes after a 250 ms quiet period but never later than 1 s after the first request in the burst (the earlier debounce could be postponed indefinitely), and alarm reconciliation is dispatched immediately, never behind that delay. Full reconciliation is reserved for startup recovery, logout and unspecified callers; notification-permission and boot/time-change receivers reconcile alarms only; an editor closing without changes just queues sync. Acknowledged note writes need no widget work; an accepted reminder identity remap re-plans alarms for its note.
- [x] **M5.2 — Durable scalable widget behavior.** Audit: row taps/toggles already went through the repository (`toggleChecklist` → `save` → Room + outbox) but via the full Compose `MainActivity`, which also silently dropped the action when settings/sign-in were not ready; quick-create already created notes through `repo.save` in the app. Defects fixed: (1) `RemoteCollectionItems` carried every row's `RemoteViews` in one binder transaction, so a large collection or a long single-note checklist risked `TransactionTooLargeException`; rows are now served lazily by `NotesWidgetService`/`NotesWidgetFactory` (`RemoteViewsFactory`: `onDataSetChanged` loads the filtered, ordered rows off the UI thread, `getViewAt` builds one bounded row), so nothing is truncated and each IPC is one row (tests: 3,000 notes served complete in app order; every row of 1 MB/100 k-character notes and a 300-item checklist is under 16 KB). (2) Row ids came from the numeric note id (a temporary id becomes the server id; temporary ids from the same millisecond collide) and a 32-bit string hash for items; ids are now a 64-bit SHA-256 digest of syncId (+ item id, with duplicate/missing item ids falling back to the index), so acceptance does not change a row's identity and note/item rows cannot collide. (3) Data changes re-sent the whole frame and every row; scoped refreshes now only `notifyAppWidgetViewDataChanged` + a partial status update, keeping the adapter binding, so the host keeps its scroll position and stable ids anchor it; startup recovery/logout still republish the frame. (4) Taps go to the invisible `WidgetActionActivity`: a checklist toggle on an identifiable item of an unlocked note is committed through the repository without starting the app UI and the widget refreshes immediately (`flushWidgets`), failures show a toast; other taps open the note in `MainActivity`. (5) `toggleChecklist` read the stored note outside the edit lock and always saved; it now reads, modifies and saves inside the lock and ignores unknown items, so it cannot overwrite a concurrent editor save. (6) PendingIntents are distinguished by action/data, not extras, and request codes could collide between the notes widget's add button (`id + 20000`) and quick-create (`id * 2`); each widget/kind now has its own data URI. Active-profile filtering/order and locked-content handling are unchanged and now covered by tests.
- [x] **M5.3 — Stable native gestures.** Findings: (1) every card's `pointerInput` was keyed on `bounds.keys.toList()`, read from a snapshot map that each card also wrote on every placement, so any card entering/leaving composition or being laid out restarted all cards' gestures (cancelling a drag in progress) and made all cards recompose; (2) the gesture lived in the dragged card, so a drag could not survive that card leaving composition and there was no autoscroll, which limited targets to the screen at drag start; (3) the pin-group rule and the move-earlier/later toolbar logic were duplicated inline, and the actions existed only through selection mode. Now: `ui/NoteReorder.kt` — `NoteReorderController` keeps card geometry in a plain map (no observable writes; verified by test), reports only composed cards as hit targets, applies the pinned/other group rule through `canDrop`, highlights only the source/target cards through per-card `derivedStateOf`, retargets after autoscroll without pointer events, and reports an accepted drop exactly once (`finish()`; `cancel()`/no target report nothing). `noteReorderGestures` is one grid-level gesture (long press → drag tracked in the initial pass so grid scrolling does not also react; a competing scroll still cancels the long press) with frame-paced edge autoscroll through `LazyStaggeredGridState.scrollBy`; its input node has a stable key, and the drop commits `repository.reorder` once, still skipped when more than one note is selected or the order is unchanged (M5.1). `moveNoteBy`/`canMoveNoteBy` are the single rule for the toolbar's Move earlier/later buttons and for new per-card TalkBack custom actions "Move earlier"/"Move later" (offered only where valid), so reordering no longer requires entering selection mode. Drag/selection semantics, `canReorderNotes` (home/pinned without search) and `moveDraggedNote` are unchanged.
- [x] **M5.4 — Focused backend ownership.** `server/server.js` shrank by 425 lines through five pure modules with explicit exports, each extracted verbatim (same names, behavior, call sites) and now unit-tested without a server: `note-text.js` (plainText/parseJson/escapeHtml/preview/link count), `note-search.js` (operator parsing and the SQL predicates), `reminder-model.js` (repeat-rule/due/location normalization, schedule-definition comparison, request and response shaping), `public-network.js` (private-address blocking, public-IP resolution and pinned lookups for link previews/calendar fetches) and `sync-protocol.js` (LWW stamps, mutation priority/order, envelope validation, change-feed parameters). Centralized rules: the five-minute client clock-skew window was written twice (LWW stamp, sort order) and is now `clampToClockSkew`; mutation priority/ordering moved out of the route into `orderMutations`; `GET /api/sync/changes` paging parsing is `parseChangesQuery`. Runtime validation at the changed external boundary (`POST /api/sync/mutations`): each entry must be an object with a string `type` ≤ 64, optional string `operationId` ≤ 160 and `syncId` ≤ 200, and an object/null `payload`; a malformed entry gets its own 400 result (the rest still run, in order), and more than 500 mutations in one request gets 413. Every shipped client sends the validated shape (web outbox: string syncId/object payload; native: operationId/syncId/payload object); payload contents remain validated by their handlers. Left in place on purpose: the SQLite transaction/lock/`afterDatabaseCommit` machinery, access checks (`getAccessibleNote`), `executeSyncMutation` and its per-resource appliers, snapshot/changes SQL and realtime publication, whose coupling to the transaction boundary is the property to preserve; extracting them without a measured need would add indirection, not ownership. Node/Docker entry points (`node server/server.js`, `COPY server`) and every route/response are unchanged.
- [x] **M5.5 — Bounded server work.** Measured with `npm run benchmark:server -- --notes=10000` (new `test-fixtures/performance/server-query-report.mjs`: seeds a representative account directly in SQLite — 5% shared, pins, per-user positions, reminders, attachments, checklists, labels —, starts the real server and reports p50/p95 and response bytes; 15 iterations after a warm-up; Node 24, SQLite 3.53, local disk). 10,000-note account: card page 1/mid-account p50 59/57 ms (≈134 KB, 80 cards), card search 66–68 ms, `/api/notes/search` 31 ms, note detail 6 ms, `sync/changes` 11 ms (50 changes) / 5 ms (at head), one `note.upsert` mutation 22 ms, web `PUT` 15 ms, bootstrap 0.8 s / 13.8 MB (first sync only; web and native both send `includeSnapshot: false`). Card pages scale linearly with the account (per-trace: the key query is ≈32 of ≈50 ms at 10 k notes, 3 ms at 1 k): a rewritten query, `temp_store`/cache/mmap pragmas and a covering `(ownerUserId, sortOrder, id)` index were each tried on the 10 k database and gave at most ≈30 % (28→20 ms) for a write-cost index, so no index/FTS/pragma change is made — not warranted by a ≈60 ms p50. Realtime: one edit of a shared note sends exactly one `notes-changed` to each recipient (collaborator and owner's other device); presence messages are separate and never trigger document reloads; the 1.2 s follow-up after create/delete/collaborator changes is a deliberate recovery message (commit ff7a5b3) and is kept. **Proven defects fixed:** (1) one `note.reorder` of the whole visible order (what native sends after every drag; web sends all loaded ids) wrote a position and published a full-note sync change for every listed note: 18.6 s and 9,350 `sync_changes` rows per reorder at 10 k notes, inside the serialized database transaction (every other request waits) and re-downloaded by every device; now a move costs 23.6 ms and one row. Protocol is additive: `note.reorder` (and `PATCH /api/notes/reorder`) accept `positions` — the new stored position of each note that moved — validated (finite, bounded, ≤ 20,000, deduplicated, accessible notes only) and written/published only when different; the whole `syncIds`/`ids` list is still sent and still used by servers/clients that predate it (they keep the old full rewrite). Clients compute the positions with one planner (`utils/note-order.ts`, `NoteOrderPlan.kt`; longest already-ordered run keeps its positions, others go between kept neighbours, pinned/other groups independent, renumber only when positions are exhausted), apply them locally, and the web/native local stores no longer rewrite every note; both implementations reproduce `test-fixtures/note-order-plan.json` exactly and single moves write one note. (2) `sync/bootstrap` and the non-card `GET /api/notes` built an `IN (…)` list of all the user's note ids for attachments, so an account over SQLite's 32,766-variable limit failed with `SQLITE_ERROR` (reproduced at 40,000 notes); attachments are now selected by the access rule itself (33,000 notes bootstrap in 1.8 s). `reminderNoteMap` is chunked for the same reason. Guarded by `server/large-account.test.js` (`npm run test:scale`; fails on the previous server).
- [x] **M5.6 — Widget icon matches main icon (user-reported).** Both native widget provider previews now reference the same `@drawable/kept_icon` as the Android application icon. Resource-level tests verify the shared icon reference; visual launcher/device validation remains in M6.4.

### M6 — Cross-client verification and v2 release readiness

The release gates below are executed here, not duplicated as 25 separate definition-of-done tasks.

- [x] **M6.1 — Close automated coverage gaps.** Audited existing coverage against G2/G3: unsent/sent/legacy outbox cases (`offline-store`, `offline-sync-guarded` specs), incremental-vs-snapshot and `positions` negotiation (`native-client`, `large-account`), lost-response replay and fault points, shared-fixture content fidelity were already covered. Gaps closed: unknown `note.*` mutation types were run as upserts (a newer client's unknown operation created a junk note) — now a per-entry 400; new `server/client-negotiation.test.js` (capabilities, legacy full-order reorder with full snapshot, operation-ID replay not re-applying over newer work, unknown type isolated from neighbours); web test that unknown extension fields survive snapshot/edit/queued upsert; CI now also runs `test:server` and `test:scale` (it ran neither). Hosted CI: last pushed head `28ff1c0` passed on the fork (run 37747929639); the commits for this item are unpushed, so their hosted run is pending.
- [x] **M6.2 — Repeatable release measurements.** The web harness now has an editor journey (`--profile --cycles=N`: open, 20 keystrokes, close/save, with forced-GC retained heap/DOM/listener samples and a settle wait) aggregated as median/worst-of-5 at 100/1,000/10,000 notes against the production build, plus the server query report; results and target discussion are in `docs/performance.md`. The measurement exposed that closing a changed note waited on a server fetch (790 ms → 285 ms after reading labels locally). A native repeatable journey and API 34/35/36 traces cannot be collected without a device: the intended `adb` procedure is documented, not executed (blocked on hardware, tracked under M6.4).
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
npm run test:server
npm run test:scale
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

### 2026-10-07 scale diagnosis and first remedies

```text
Package / date: M2.4 diagnose and resolve scaling costs / 2026-10-07
Status: diagnosis complete with repeated measurements; two follow-ups identified (see blocker). Interaction-critical start cost is resolved for warm starts; background render cost at 10,000 notes is reduced but not eliminated.
Files / responsibilities changed: `test-fixtures/performance/web-ui-check.mjs` (`--profile`, `--cpu-profile`, `--build-root`), new `web-scale-report.mjs`, `docs/performance.md`; `NavbarComponent` selection memo and `utils/note-selection.ts`; `SidenavComponent` overflow coalescing; `OfflineStoreService` display window and key-only duplicate repair; `NotesService.publishCachedNotes` early window and identity reuse (`utils/note-identity.ts`).
Contract / storage / lifecycle decisions: no schema change; the display window is a derived hint that is purged with the partition and ignored if stale (missing notes are skipped, the full read always follows). The identity-reuse rule compares every field a card shows plus revision/stamp, so unchanged notes keep presence flags and caches but any visible change replaces the object.
Checks executed and outcomes: Chrome Headless 165/165 on two runs (new: display window storage/purge, early window then full publish with identity reuse, stale-profile guard, identity rules, selection helper); `npm run build` passed; scale journey run for 100/1,000/10,000 notes, 3 repetitions each, Bricks and grid (tables in docs/performance.md).
Reference build/device/fixture: Node 24, Linux, production Angular build and a development build for function names, headless Chromium 154 at 1440x900, mock API with synthetic notes.
Before / after performance evidence: see docs/performance.md (warm 10,000-note first card 1,274 -> 324 ms; warm interactive scripting 631 -> 126 ms; total warm scripting at 10,000 notes up ~0.7 s, off the critical path).
Remaining acceptance or blocker: (a) render cost of the republished collection (Angular `@for`/template work and per-card meta) is the next target; (b) the fixed 3 s background window makes the 10,000-note search/scroll rows include spillover; (c) no real-device, real-network or long-document measurements.
Next dependency: M2.5 bounded renderer acceptance.
```

### 2026-10-07 bounded renderer acceptance

```text
Package / date: M2.5 accept bounded renderers / 2026-10-07
Status: automated and headless-browser acceptance done for the items listed; touch/desktop drag and media behavior need physical or scripted-gesture acceptance (M6.4/M6.5)
Files / responsibilities changed: `NoteMasonryWindowModel` item refresh; `NotesComponent` (grid window freshness, single anchored measurement path, card focus return, touch autoscroll); `NoteCardPreviewComponent` keyboard open; new `utils/drag-autoscroll.ts`; harness keyboard smoke step.
Contract / storage / lifecycle decisions: no data or protocol change. Keyboard activation uses role="button" on the card body, which contains interactive children; the structure should be reviewed in the M6.5 screen-reader pass.
Checks executed and outcomes: Chrome Headless 165/165 on two runs (new: masonry item freshness and late-media reflow, list pin/reorder measurement retention, card keyboard open, autoscroll speeds, selection helper); production build; harness smoke at 1,000 notes (Bricks and grid) and 10,000 notes (Bricks and grid) all passing including the new keyboard step, 0 browser errors; `git diff --check`.
Reference build/device/fixture: Node 24, production Angular build, headless Chromium 154 with synthetic notes.
Before / after performance evidence: none for this item.
Remaining acceptance or blocker: physical touch-drag/autoscroll feel, desktop drag across unmounted rows (native browser autoscroll is relied on), delayed real media, and screen-reader behavior.
Next dependency: M3 (editor/layout ownership), M6 acceptance.
```

### 2026-10-08 editor/persistence boundary

```text
Package / date: M3.1 editor/persistence boundary / 2026-10-08
Status: implemented and verified by unit/build checks; no device or browser-interaction run
Files / responsibilities changed: new `utils/checklist-model.ts` and `utils/editor-body.ts` (+ specs); `InputComponent` delegates checklist normalization, indent/toggle with children, structural history, and body decorate/strip/URL extraction to them (about 150 fewer lines in the component).
Contract / storage / lifecycle decisions: no stored-format change. Checklist operations are now immutable (the component reassigns `checkBoxes`); the component still decides when to commit, autosave and re-render. Editor chrome is removed on every save path through one function.
Checks executed and outcomes: Chrome Headless 178/178 (13 new: id repair, nesting, history bounds/ownership, body round trip, chrome stripping, URL extraction); `npm run build` passed (1.52 MB initial, ~299 kB estimated transfer); node util tests 16/16.
Reference build/device/fixture: Node 24 production build; headless Chromium 154. No device.
Before / after performance evidence: none.
Remaining acceptance or blocker: caret/IME and paste are unchanged DOM code without automated interaction coverage (M6.5).
Next dependency: M3.2 layout/gesture ownership.
```

### 2026-10-08 layout/gesture ownership

```text
Package / date: M3.2 layout/gesture boundary / 2026-10-08
Status: implemented and verified by unit tests and the headless-browser harness; no touch hardware
Files / responsibilities changed: new `utils/layout-scheduler.ts` (+ spec); `NotesComponent` uses it for repack scheduling and viewport settling, tracks `renderContextDirty` for `ngAfterViewChecked`, and releases drag/long-press/pull-refresh resources on destroy; `SharedService.searchQueryChanged$` added.
Contract / storage / lifecycle decisions: no data/protocol change. Search text still lives in `SharedService.searchQuery`; its single writer now also emits. Repacks still run outside the Angular zone.
Checks executed and outcomes: Chrome Headless 187/187 (new: scheduler coalescing/settle/dispose, drag released on destroy, no layout after destroy, render context recomputed only after events); `npm run build` passed (1.52 MB initial, ~299 kB transfer); `npm run benchmark:web -- --notes=240` passed: 0 browser errors, no mobile overlap, resize still 24 layouts / 31 style recalculations, all smoke steps passed.
Reference build/device/fixture: Node 24 production build; headless Chromium 154; 240 synthetic notes.
Before / after performance evidence: resize layout/recalc counts unchanged (24/31); per-change-detection string building removed (not separately timed).
Remaining acceptance or blocker: physical touch drag, orientation/foldable settling and 10,000-note re-run were not repeated (M6.4/M6.5).
Next dependency: M3.3 overlay state and callbacks.
```

### 2026-10-08 overlay state and callbacks

```text
Package / date: M3.3 overlay state and callbacks / 2026-10-08
Status: implemented and verified by unit tests and the headless-browser harness; no device
Files / responsibilities changed: `NotesComponent` (`editorOpen`, `setEditorOpen`) and its template; `SharedService.noteEditorOpen$`; `AppComponent.isNoteModalOpen`; `NavComponent` (sidenav) overflow-cue publication inside the zone; `InputComponent` drawing resize callback; notes/sidenav specs.
Contract / storage / lifecycle decisions: no data change. Overlay visibility has one writer (`setEditorOpen`), which applies the binding immediately because callers measure/focus the overlay straight away. Zone.js stays in coalesced mode; unpatched-observer results enter the zone explicitly and only when a bound value changed.
Checks executed and outcomes: Chrome Headless 190/190 (new: editor behavior follows state when inline style is altered, state mirrored to the shared flag, sidenav cue published in-zone only on change); `npm run build` passed (1.52 MB initial, ~299 kB transfer); `npm run benchmark:web -- --notes=240` passed with 0 browser errors, including the real open/close steps "unchanged note closes without network reads" and "keyboard open and focus return".
Reference build/device/fixture: Node 24 production build; headless Chromium 154.
Before / after performance evidence: none; fewer synchronous style reads on scroll/Escape paths.
Remaining acceptance or blocker: native-shell back-button/deep-link behavior with an open editor and screen-reader focus are device checks (M6.4/M6.5).
Next dependency: M3.4 bounded resource lifecycle.
```

### 2026-10-08 bounded resource lifecycle

```text
Package / date: M3.4 bounded resource lifecycle / 2026-10-08
Status: implemented and verified by unit tests, build and the headless-browser harness; the drawing canvas and editor teardown were not exercised in a real browser journey
Files / responsibilities changed: new `utils/disposables.ts` and `utils/drawing-history.ts` (+ specs); `InputComponent` (teardown of listeners/observer/time picker/timers, single canvas encoding per stroke, frame-coalesced body-length cue, bounded drawing history, template undo/redo state); `NotesComponent` (tracked picker-listener timeouts); `OfflineStoreService.releaseMediaUrls` called from `purgePartition`.
Contract / storage / lifecycle decisions: no stored-format change; drawing images are byte-identical PNG data URLs from the same canvas. The undo bound only drops the oldest history, never the current drawing. Media object URLs are released with their partition, not on a size bound, to avoid breaking images still on screen.
Checks executed and outcomes: Chrome Headless 201/201 (new: disposables cancellation/late-attach/idempotence, drawing-history bounds/size accounting, media URL revocation per partition); `npm run build` passed (1.52 MB initial, ~299 kB transfer) — it caught a type error in an edit that the spec compile alone had not; `npm run benchmark:web -- --notes=240` 0 browser errors; `npm run test:sync` passed; `git diff --check` clean.
Reference build/device/fixture: Node 24 production build; headless Chromium 154. No device.
Before / after performance evidence: stroke end now performs one PNG encode instead of two, and undo/redo none; no timings were collected. Memory growth over ten edit cycles (M6.5) was not measured.
Remaining acceptance or blocker: ten-cycle retained-session/listener/bitmap measurement, large-drawing stroke timing, and native-shell/Smart Capture device behavior remain M6.2/M6.5/M6.4 items. M3 is complete at the automated/headless level.
Next dependency: M4 (Android) and M6 acceptance; no M3 follow-up blocks them.
```

### 2026-10-08 nonblocking initialized startup

```text
Package / date: M4.1 nonblocking initialized startup / 2026-10-08
Status: implemented and verified by JVM/Robolectric tests, assembleDebug and lint; no device, so no real startup trace
Files / responsibilities changed: `ui/StartupGate.kt` (new); `KeptScreen` derives signed-in/dark state from ready settings in composition; `Connection.kt` settings-load-failure message; `StartupLifecycleTest` (new).
Contract / storage / lifecycle decisions: no stored-data change. Stored token/theme are read through the existing ready gate; user actions in the session override them explicitly.
Checks executed and outcomes: `./gradlew testDebugUnitTest assembleDebug lintDebug` passed (4 new tests: gate precedence, settings read off the caller thread, unreadable store becomes ready with an actionable message, awaitReady); no other Android code path changed.
Reference build/device/fixture: Robolectric on JVM, debug build. No device or emulator; no cold-start timing or StrictMode run.
Before / after performance evidence: none collected; the change removes one composed login/light frame by construction.
Remaining acceptance or blocker: physical cold/warm start timing, StrictMode on a device, and keystore behaviour on real hardware (M6.2/M6.4).
Next dependency: M4.2 lifecycle and session disposal.
```

### 2026-10-08 lifecycle and session disposal

```text
Package / date: M4.2 lifecycle and session disposal / 2026-10-08
Status: implemented and verified by JVM/Robolectric tests, assembleDebug and lint; no device, so rotation/process-death were not exercised on real Android
Files / responsibilities changed: `KeptApplication` (`ensureStartupRecovery`, configuration-change flag, `scope` now replaceable for tests); `MainActivity` (launch intent once, one-time recovery, foreground handling); `KeptRepository` (`setForeground`, serialized socket reconciliation, single reconnect); `ui/EditorSessionStores.kt` (new) used by `NoteEditor` and `KeptScreen`; `KeptScreen` (saveable open-note id, explicit editor release).
Contract / storage / lifecycle decisions: no stored-data or protocol change. Socket identity is still the immutable connection snapshot. Editor release happens only on an explicit close after `finish()`/recovery has completed, so an in-flight local save is not cancelled.
Checks executed and outcomes: `./gradlew testDebugUnitTest assembleDebug lintDebug` passed with 4 new tests (per-session release and fresh reopen; eight concurrent foreground requests open one socket; stop after start leaves no socket/reconnect over a full reconnect window; startup recovery runs once for repeated calls).
Reference build/device/fixture: Robolectric on JVM, debug build; loopback-refused sockets stand in for the server. No device.
Before / after performance evidence: none; fewer duplicate sockets/recoveries by construction and test.
Remaining acceptance or blocker: real rotation, process-death restoration, and two-launcher/widget interplay need a device (M6.4/M6.5); Compose-level behavior of the saveable editor id is not unit-tested.
Next dependency: M4.3 editor hot paths.
```

### 2026-10-08 editor hot paths

```text
Package / date: M4.3 editor hot paths / 2026-10-08
Status: implemented and verified by JVM/Robolectric tests, assembleDebug and lint; no on-device typing latency measurement
Files / responsibilities changed: `NoteEditorViewModel` (field-aware `change`, debounced/bounded local persistence, `flushLocal`, committed-generation tracking, `finish()` ordering); `Models.kt` (`shallowCopy`, `copyForEdit`, copy-free `sameEditableContent`); `KeptRepository` (`save` single serialization, `queueSync`); `NoteEditor` (touched-field names, ON_STOP flush); `EditorHotPathTest` (new).
Contract / storage / lifecycle decisions: stored note JSON and outbox payloads are byte-compatible (same fields, same single coalesced upsert); the unsaved window while typing is now at most 1 s plus the ON_STOP/close flushes instead of ~0, a deliberate trade for write amplification (a process kill without ON_STOP can lose up to that window).
Checks executed and outcomes: `./gradlew testDebugUnitTest assembleDebug lintDebug` passed; 8 new tests (60-keystroke burst commits at most twice with one outbox entry and the latest text; continuous typing still commits within the bound; flushing a committed draft only queues sync; flush-then-debounce does not duplicate; background flush commits without syncing; untouched images/checklist shared and previous drafts never mutated while unknown fields survive; save does not mutate its argument; comparison ignores server fields without copying). One existing test (`closingANewNoteThatSyncedBeforeBeingEmptiedMovesItToTrash`) exposed the stale-store ordering above and drove the `finish()` fix.
Reference build/device/fixture: Robolectric on JVM, debug build. No device; no typing-latency, jank or allocation trace.
Before / after performance evidence: by test, writes per 60-keystroke burst drop from up to 60 attempted commits to at most 2; no timing collected.
Remaining acceptance or blocker: IME/composition behaviour with real keyboards and large-note typing latency need a device (M6.2/M6.4).
Next dependency: M4.4 narrow home projection work.
```

### 2026-10-08 narrow home projection work

```text
Package / date: M4.4 narrow home projection work / 2026-10-08
Status: implemented and verified by JVM/Robolectric tests, assembleDebug and lint; no device scroll/jank measurement
Files / responsibilities changed: new `ui/HomeState.kt` and `ui/HomeProjector.kt`; `NoteCardUiModel` (content type, one-shot `buildHomeProjection` now delegates to the projector); `KeptScreen` home screen uses them (state delegates, projector, content types); `HomeProjectionTest` (new).
Contract / storage / lifecycle decisions: no Room, protocol or stored-data change. The projector's caches are derived and dropped with the screen; search semantics (title + displayed body + checklist text, case-insensitive, never matching locked notes) and card contents are unchanged and asserted equal to a fresh projection.
Checks executed and outcomes: `./gradlew testDebugUnitTest assembleDebug lintDebug` passed; 9 new tests (unchanged cards reused when one note changes; edit outside the filter yields the identical projection; identical inputs do no work; search text built once per note; locked notes never match and drawer choices follow labels/binders; reminder change rebuilds one card; incremental results equal fresh ones across 5 filters/queries over 6 edit steps; content types; selection/reorder rules).
Reference build/device/fixture: Robolectric on JVM, debug build. No device and no Compose recomposition or frame-time trace.
Before / after performance evidence: by test, a single-note edit in a 40-note collection rebuilds 1 card instead of 40, and a 2-step search parses each note's text once; no timings were collected.
Remaining acceptance or blocker: release-like scroll/search timings on large collections and recomposition counts need a device (M6.2); selection/search state is still not restored across process death (not in scope).
Next dependency: M4.5 reliable native media.
```

### 2026-10-08 reliable native media

```text
Package / date: M4.5 reliable native media / 2026-10-08
Status: implemented and verified by JVM/Robolectric tests, assembleDebug and lint; no device, so no real bitmap-memory or scroll evidence
Files / responsibilities changed: new `data/SharedLoader.kt`; `Media.kt` (profile-scoped, shared, cancellable download; cancellation-safe preview; cache-hit age refresh; decoded cache on `SharedLoader`); new `ui/MediaPreviewSizing.kt`; `KeptScreen.MediaImage` (slot-sized decode, reserved geometry, loading/error/retry); `MediaReliabilityTest` (new).
Contract / storage / lifecycle decisions: no protocol or stored-data change; cache file names are unchanged for the normal single-profile case (the key now derives from the request's snapshot rather than live settings). Only successful loads enter caches; failures are retried on demand.
Checks executed and outcomes: `./gradlew testDebugUnitTest assembleDebug lintDebug` passed; 8 new tests (profile switch mid-download keeps the original profile key; six concurrent requests make one transfer; cache hit makes no request and refreshes age; cancelling while the body streams cancels the call and removes the temporary file; cross-origin media is refused before any request; shared loader runs once, caches only success, retries after failure; decode size buckets/clamps; reserved height follows aspect ratio within the slot). The existing `MediaRequestTest` (last-consumer cancellation) still passes.
Reference build/device/fixture: Robolectric on JVM with a synthetic OkHttp interceptor; no network, device or real bitmaps beyond what Robolectric provides.
Before / after performance evidence: none measured; by test, one transfer instead of N for concurrent identical requests and no transfer after the last consumer leaves.
Remaining acceptance or blocker: real-device bitmap memory/scroll behavior, TalkBack reading of the retry control, and mTLS/gateway media over a real connection (M6.4/M6.5). M4 is complete at the automated level.
Next dependency: M5 (scoped sync/widget effects and backend boundaries) and M6 acceptance; no M4 follow-up blocks them.
```

### 2026-10-08 scoped effects

```text
Package / date: M5.1 committed change/effect scope / 2026-10-08
Status: implemented and verified by JVM/Robolectric tests, assembleDebug and lint; no device, so no widget redraw or alarm delivery observation
Files / responsibilities changed: new `data/Effects.kt` (`EffectScope`, `EffectDispatcher`); `KeptRepository` (scoped `changed`/`reconcile`, equivalent-write skips, scope from snapshot/change-page/occurrence/accepted-reminder results, `requestSync` removed); `KeptApplication.refreshWidgetScope`; `NotesWidget.refresh(context, scope)`; `MainActivity` and `ReminderLifecycleReceiver` (alarms-only reconcile); `NoteEditorViewModel` (queue sync instead of reconcile on a clean close); `ScopedEffectsTest` (new, 14 tests).
Contract / storage / lifecycle decisions: no protocol or stored-data change; outbox semantics for unsent/sent work unchanged (a skipped save is only one whose document is byte-identical and already synced or already queued/in flight/conflicted). Alarm reconciliation remains idempotent and unchanged; it is only called less often.
Checks executed and outcomes: `./gradlew testDebugUnitTest assembleDebug lintDebug` passed. New tests cover scope dependency rules and merging; one widget pass for a burst with the union of notes while alarms ran first; a 40 ms edit stream flushes within the 1 s bound; one edited note refreshes only its widgets and no alarms; archive re-plans alarms; unchanged saves/reorders/trashing/reminders/dismissals/collapses write and notify nothing; an incremental page with one changed and one identical note reports one note and no alarms; unchanged sync and bootstrap do nothing; a remote archive re-plans alarms.
Reference build/device/fixture: Robolectric on JVM with in-memory Room and a fake API; no device.
Before / after performance evidence: by test, one note edit triggers 0 alarm reconciliations and refreshes only dependent widgets (before: both for every edit, after a fixed 250 ms trailing delay); an identical snapshot triggers none; no timings measured.
Remaining acceptance or blocker: widget redraw cost and alarm accuracy on a device (M6.4); widget row identity/IPC bounds are M5.2.
Next dependency: M5.2 durable scalable widget behavior.
```

### 2026-10-08 durable scalable widgets

```text
Package / date: M5.2 durable scalable widget behavior / 2026-10-08
Status: implemented and verified by JVM/Robolectric tests, assembleDebug and lint; no device, so no launcher scroll/anchor or real binder-limit observation
Files / responsibilities changed: `widgets/NotesWidget.kt` (frame-only render, scoped data refresh, `NotesWidgetService`/`NotesWidgetFactory`, `widgetRowId`, `widgetFillIn`, `load`); new `widgets/WidgetActionActivity.kt`; `QuickCreateWidget` (`quickCreateIntent`); `KeptRepository` (`saveLocked`, locked `toggleChecklist`, `flushWidgets`); manifest (service with BIND_REMOTEVIEWS, trampoline activity), `WidgetTrampoline` style; `widgets/WidgetBehaviorTest` (new, 10 tests).
Contract / storage / lifecycle decisions: no protocol or stored-data change; widget actions use the unchanged note.upsert/outbox path; widget filters/profile preferences are unchanged, so existing widgets keep working. The legacy MainActivity itemId path remains for intents created before the upgrade.
Checks executed and outcomes: `./gradlew testDebugUnitTest assembleDebug lintDebug` passed (new tests: complete, ordered 3,000-row collection with unique ids; per-row parcel bounds for huge notes/checklists; id stability across numeric-id acceptance and across colliding temporary ids; unique ids for duplicate/missing item ids; active-profile/label/pinned/archive/trash/signed-out filtering; tap semantics for items/locked/id-less items; toggle through the trampoline commits note+outbox without starting an app activity; row tap opens the note; stale toggle cannot overwrite a later edit; create intents distinct across widgets/kinds).
Reference build/device/fixture: Robolectric on JVM with in-memory Room; RemoteViews are applied and parceled but not drawn by a launcher.
Before / after performance evidence: by test, IPC per row is bounded (<16 KB) where one transaction used to carry every row; no timings.
Remaining acceptance or blocker: scroll-anchor preservation, redraw behavior and tap latency on a real launcher/device (M6.4); TalkBack on widget rows.
Next dependency: M5.3 stable native gestures.
```

### 2026-10-08 stable native gestures

```text
Package / date: M5.3 stable native gestures / 2026-10-08
Status: implemented and verified by JVM tests, assembleDebug and lint; the Compose pointer-input glue (long press, initial-pass tracking, autoscroll frames, TalkBack actions) is not exercised by any automated test and has not run on a device
Files / responsibilities changed: new `ui/NoteReorder.kt` (`NoteReorderController`, `noteReorderGestures`); `ui/KeptScreen.kt` (grid state/holders, `NoteCard` without per-card pointer input or snapshot bounds, `moveNoteBy`/`canMoveNoteBy`, accessibility actions, toolbar uses the shared rule); `NoteReorderTest` (new, 7 tests).
Contract / storage / lifecycle decisions: no protocol or stored-data change; the reorder command and outbox payload are unchanged. The gesture controller is screen-owned state dropped with the home screen; the autoscroll coroutine lives in the gesture's scope and ends with the drag.
Checks executed and outcomes: `./gradlew testDebugUnitTest assembleDebug lintDebug` passed. Tests: hit testing only finds composed cards; geometry reports perform zero snapshot writes; drag starts only on cards and tracks only allowed targets (pin group, gaps keep target, source clears it); one drop per accepted drag and none for cancel/no target; autoscroll retargeting without pointer events; autoscroll ramp/cap/direction and none when idle; single-step moves never cross pinned groups and equal the drag result.
Reference build/device/fixture: JVM unit tests on the pure controller; no Compose UI test dependency is available in this build and no device is attached.
Before / after performance evidence: none measured; by construction, card placement no longer invalidates composition or restarts N gesture nodes.
Remaining acceptance or blocker: on-device verification of long-press-then-drag with the competing grid scroll, autoscroll feel/speed, drag across a card leaving composition, and TalkBack custom actions (M6.4); if a Compose UI-test dependency is approved, a gesture-level test could replace that manual check.
Next dependency: M5.4 focused backend ownership.
```

### 2026-10-08 backend ownership

```text
Package / date: M5.4 focused backend ownership / 2026-10-08
Status: implemented and verified by Node tests; no Docker image build in this slice
Files / responsibilities changed: new `server/note-text.js`, `note-search.js`, `reminder-model.js`, `public-network.js`, `sync-protocol.js`; `server/server.js` (imports replace the moved functions; uses `parseChangesQuery`; unused `dns`/`net` requires removed); `server/sync-routes.js` (ordering/validation/limit through `sync-protocol`); new tests `sync-protocol.test.js` (9) and `domain-modules.test.js` (6); `package.json` script `test:server`.
Contract / storage / lifecycle decisions: no schema, response shape, route or entry-point change. The only behavioral differences are rejections of previously malformed input: a mutation entry that is not an object, lacks a string type, or has an array/string payload or non-string syncId now fails with its own 400 result instead of reaching a handler, and a request with more than 500 mutations fails with 413. A non-integer change cursor is floored.
Checks executed and outcomes: `npm run test:sync`, `test:native`, `test:reminders`, `test:mcp` (21) and the new `test:server` (13) passed; `tsc --allowJs --checkJs` reported no undefined identifiers in `server.js` or the new modules (baseline also 0); `git diff --check` clean.
Reference build/device/fixture: Node test suites with in-process Express and temporary SQLite databases; no representative account or Docker build.
Before / after performance evidence: none (structure only); server.js 8,695 -> 8,295 lines.
Remaining acceptance or blocker: Docker build/run smoke belongs to M6; further extraction of the mutation appliers and snapshot SQL should wait for M5.5 profiling evidence.
Next dependency: M5.5 bounded server work.
```

### 2026-10-08 bounded server work

```text
Package / date: M5.5 bounded server work / 2026-10-08
Status: implemented and verified by Node, Karma, JVM/Robolectric tests, `ng build`, assembleDebug and lint; no representative production account, device or Docker build
Files / responsibilities changed: server — `server.js` (`applyNoteOrder`, `positions` on `note.reorder`/`PATCH /api/notes/reorder`, `accessibleAttachmentRows`, chunked `reminderNoteMap`), new `note-order.js` (position parsing); web — new `utils/note-order.ts`, `NotesService.reorder/planOrder/persistLocalOrder/queueReorder`, `ReminderService.floatNoteToTop`; Android — new `data/NoteOrderPlan.kt`, `KeptRepository.reorder`; shared `test-fixtures/note-order-plan.json`; harness `test-fixtures/performance/server-query-report.mjs`; package scripts `benchmark:server`, `test:scale`, `test:server`.
Contract / storage / lifecycle decisions: additive protocol only (new optional `positions`; `syncIds`/`ids` unchanged); no schema or index change. A new client with an older server falls back to the old full rewrite (server ignores `positions`); an older client with a new server uses the old behaviour. Clients are the authority for the positions they send (per-user table, so only that user's view is affected); a concurrent reorder from another device resolves last-writer-wins, as before.
Checks executed and outcomes: `npm run build` ok; Karma 204/204 (3 new reorder specs); `node --test src/app/utils/*.test.ts` 34/34 incl. 18 planner tests over the shared fixture; `test:sync`, `test:native`, `test:reminders`, `test:mcp` (21), `test:server` (16), `test:scale` (33,000 notes; fails on the previous server at bootstrap) passed; Android `./gradlew testDebugUnitTest assembleDebug lintDebug` passed (planner fixture + 300 random single moves; reorder writes one stored note and queues one position; queued reorders merge positions); `git diff --check` clean.
Reference build/device/fixture: 10,000-note seeded SQLite account on this machine (single run per figure, 15 iterations); 33,000-note account for the variable-limit regression; no network latency, TLS, gateway or real data shapes (inline images, many attachments).
Before / after performance evidence: `note.reorder` for a 9,350-note visible list 18,598 ms → 23.6 ms p50 (p95 100 ms → 28.6 ms in the same harness), 9,350 → 1 sync changes per move; bootstrap at 40,000 notes failed → works at 33,000 in 1.8 s (23 MB). Unchanged: card page ≈59 ms p50, bootstrap 0.8 s at 10 k, mutation 22 ms.
Remaining acceptance or blocker: card-page cost grows linearly with account size (≈3.4 µs/note); revisit with an index or summary table only if a larger real account or p95 target requires it (section 5). Payload bytes for cards (≈1.7 KB each) were not reduced. Production Docker run and cross-client reorder verification between web, Android and a real server are M6.
Next dependency: M6 cross-client verification and release readiness.
```

### 2026-10-08 coverage audit

```text
Package / date: M6.1 automated coverage gaps / 2026-10-08
Status: implemented and verified locally; hosted CI for the new commit pending push
Files / responsibilities changed: `server/server.js` (`applySyncNoteMutation` rejects unknown note types), new `server/client-negotiation.test.js`, `package.json` `test:server`, `.github/workflows/ci.yml` (+`test:server`, `test:scale`), `offline-store.service.spec.ts` (+1 extension-field test).
Contract / storage / lifecycle decisions: no schema or wire change; only a previously accepted-and-misapplied unknown `note.*` type is now rejected with 400 for that entry.
Checks executed and outcomes: `test:server` 17/17, `test:sync`, `test:native`, `test:scale` passed; offline-store Karma spec 39/39.
Reference build/device/fixture: Node 24 child-process server on a temp SQLite DB; Chromium 154 headless; no device.
Before / after performance evidence: none.
Remaining acceptance or blocker: Android coverage was audited, not extended (no Android gap found that a JVM test can close); device-only journeys stay in M6.4/M6.5.
Next dependency: M6.2.
```

### 2026-10-08 release measurements

```text
Package / date: M6.2 repeatable release measurements / 2026-10-08
Status: web and server parts implemented and measured; native journey blocked on hardware
Files / responsibilities changed: `test-fixtures/performance/web-ui-check.mjs` (editor cycles, retained-state sampling, settle wait), `docs/performance.md`, `NotesService.cachedLabels`, `InputComponent.labelsForSave` (local labels first, network only without a local copy), +1 spec in `notes.service.spec.ts`.
Contract / storage / lifecycle decisions: no storage or wire change. Behavior change: the save path no longer refreshes labels from the server before committing; it uses the sync-maintained local copy. A label changed by another user and not yet synced to this device is therefore not merged into this save (the same exposure as editing offline).
Checks executed and outcomes: `npm run build` ok (1.52 MB initial, ~300 KB transfer); `notes.service.spec.ts` Karma 31/31; scale report runs 5x at 100/1,000/10,000; `benchmark:server`.
Reference build/device/fixture: headless Chromium 154, Linux, Node 24, production build, mock API (500 ms detail latency), 10,000-note seeded SQLite server; no device, no real network latency.
Before / after performance evidence: close-and-save median 790 ms -> 285 ms (about 200 ms is the close animation); keystroke-to-frame p95 13 ms; open 70 ms; first closes at 10,000 notes (1.2 s) were warm-start contention and vanish once settled.
Remaining acceptance or blocker: unattributed ~1/cycle listener-counter creep (heap and DOM plateau); no native traces, 60/120 Hz, Firefox/Safari or network-condition (500 ms/loss) matrix; save time without the animation is inferred, not measured.
Next dependency: M6.3.
```
