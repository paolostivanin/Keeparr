# Native Android remediation and completion plan

Status: implementation handoff, written on 2026-10-05 after a correctness review of the current uncommitted implementation. This document is a work plan, not evidence that the fixes or release checks have passed.

Product scope and device requirements remain defined by [native-android-plan.md](native-android-plan.md). This document specifies the work needed to make that implementation correct and complete. Follow both documents. The previous claim that only device acceptance remained was inaccurate: there are code defects and unfinished flows as well.

## 1. Instructions for the implementing agent

1. Read this document and the original product plan before editing. Inspect the working tree; the Android project and several server files are presently untracked or modified. Preserve them as existing work.
2. Locate functions by name rather than relying on review line numbers. Re-read relevant callers before changing contracts.
3. Follow the dependency order below. For each behavioral defect, add a failing regression test, implement the fix, and run the affected checks.
4. Use an isolated server instance with two test users. Never run destructive migration, upload, or fault-injection tests against the user's database or real gateway.
5. Retain web-client compatibility and the distinct native application ID `dev.keeparr.android`. Existing web clients must continue to work without adopting native revision checks.
6. Preserve unsynchronized edits, operation IDs, reminder identities, and staged files through migrations/reconnects. Do not reset Room or clear an outbox to make a test pass.
7. Do not add deferred product features: location reminders, AI capture, drawing creation, audio transcription, administration, or a new push backend.
8. Record implementation choices and verification results. Mark a package complete only after its required tests pass. Mark device/gateway checks blocked when prerequisites are unavailable.
9. Do not commit, push, deploy, or replace certificates unless the user separately requests that action.

### Source map

Paths are repository-relative. Native paths in this table are relative to `android-native/app/src/main/java/dev/keeparr/android/`.

| Area | Current files / entry points |
| --- | --- |
| Server schema/IDs | `server/native-client.js`: `initNativeClientSchema`, `occurrenceId` |
| Server synchronization | `server/server.js`: `executeSyncMutation`, `applySyncNoteMutation`, `applySyncReminderMutation`, `syncSnapshotForUser`, `/api/sync/changes` |
| Reminder visibility | `server/server.js`: `reminderNoteMap`, `reminderResponse`, `visibleReminderWhere`, `nativeOccurrencesForUser`, collaborator changes |
| Reminder write/delivery paths | `server/server.js`: reminder CRUD/import, `smartSetReminder`, `startReminderScheduler`, calendar backfills, `sendReminderPush` |
| Image lifecycle | `server/server.js`: `/api/uploads/images`, `syncNoteImagesForNote`, image deletion/backfill |
| Server recurrence | `server/reminder-recurrence.js`, `server/reminder-recurrence.test.js` |
| Native local storage | `data/Database.kt`, exported schemas in `android-native/app/schemas/` |
| Native sync/recovery | `data/KeeparrRepository.kt`, `data/SyncWorker.kt` |
| Native connection/media | `data/Connection.kt`, `data/Media.kt` |
| Editor/home | `ui/NoteEditor.kt`, `ui/KeeparrScreen.kt`, `MainActivity.kt` |
| Android reminders | `reminders/ReminderScheduler.kt`, application/lifecycle receivers |
| Widgets | `widgets/NotesWidget.kt`, `WidgetConfigActivity.kt`, `QuickCreateWidget.kt`, widget layouts/XML and manifest |
| Existing web contracts | `src/app/services/offline-sync.service.ts`, `notes.service.ts`, `note-lock.service.ts`, reminder model/service |
| Existing checks | `server/native-client.test.js`, `server/sync-smoke.test.js`, `android-native/app/src/test/java/dev/keeparr/android/data/NativeContractTest.kt` |

## 2. Review findings and reproducible baseline

The existing builds and smoke tests pass, but they do not exercise the failing paths below.

| ID | Priority | Finding | Evidence / minimal reproduction |
| --- | --- | --- | --- |
| R1 | P0 | Revoked collaborators receive current private note content through personal reminders. | Reproduced on an isolated server: share a note, create the editor's reminder, revoke the editor, change the owner's note body, bootstrap as editor. `notes` excludes the note, but `reminders` includes the new private body. |
| R2 | P1 | Offline repeats generated locally are rejected at delivery. | Code inspection: reconciliation computes a later due time, but `deliver` requires equality with the reminder's original stored `dueAtUtc` unless a server occurrence exists. Offline later occurrences have neither condition. |
| R3 | P1 | Server roll-forward changes occurrence identities and can defeat deduplication. | Reproduced with the actual SQLite migration/trigger: advancing due time changed version 1 to 2; local next occurrence ended in `#v1`, server next occurrence in `#v2`. |
| R4 | P1 | Reminder responses/sync events can contain an old schedule version. | Reproduced in SQLite: `UPDATE ... RETURNING *` returned version 1 while a subsequent `SELECT` returned version 2 after the `AFTER UPDATE` trigger. |
| R5 | P1 | Existing-note editors retain stale revisions after their own successful saves. | Code inspection: the editor only adopts cached revision changes when its ID is negative. Save an existing note, synchronize, edit again without closing the editor: the second operation can use the first operation's stale base. |
| R6 | P1 | Image replay identity disappears during later note edits. | Reproduced on an isolated server: upload with an operation ID, attach the image, edit the note, retry the upload. The retry returns a different URL because relationship rebuilding removed the upload metadata. |
| R7 | P1 | Mutation writes and persistent replay receipts are not atomic. | Code inspection: `executeSyncMutation` applies writes before inserting `native_mutation_results`. A process failure between them leaves a committed operation without its replay result. |
| R8 | P1 | Reminder base-version checks allow two winners. | Reproduced on an isolated server: submit two concurrent updates from the same `baseScheduleVersion`; both succeed. The SQL update lacks a version predicate. |
| R9 | P1 | Editing a formatted checklist string flattens it. | Code inspection: item text is read through `Html.fromHtml(...).toString()` and written through `Html.escapeHtml(...)`, dropping links/formatting. The body-format guard does not cover checklist data. |
| R10 | P1 | Snapshot reconciliation treats some local creations as inaccessible server records. | Code inspection: the preservation exception uses note `baseRevision == 0`; unsynced reminders lack that field. A snapshot after another operation can remove their records and mark their operations conflicted. |
| R11 | P1 | Expired sessions have no nondestructive reauthentication flow. | Code inspection: a 401 leaves `signedIn` true; the route to login is sign-out, which deletes cached records, drafts, and staged files. |
| R12 | P2 | Checklist view-state changes bypass the durable outbox. | Code inspection: `setChecklistCollapsed` updates a note record then directly calls the server. It has no durable retry and is outside the repository's edit mutex. |
| R13 | P2 | Conflict handling is incomplete for different operation types. | Code inspection: `resolve` can store a reminder's `latest` payload as a `note`; generic choices do not describe reminder/action conflicts correctly. Note conflicts with a latest server version have no separate save-as-copy action. |
| R14 | P2 | Clean open editors do not apply incoming changes. | Code inspection: Room observation exists, but the editor mostly retains its initial JSON; external updates and newly uploaded media are not consistently displayed. |

Priorities: P0 blocks safe handling of shared data; P1 blocks reliable everyday use or release acceptance; P2 completes required behavior/quality. Device absence does not block fixing these defects or writing regression tests.

## 3. Target invariants and contract decisions

Settle these invariants before adding UI or changing protocol versions.

### 3.1 Access and privacy

- Note-linked reminders require both reminder ownership and current note access for any content-bearing read, mutation, enrichment, notification, or calendar export.
- Revocation removes shared notes and dependent previews/media/schedules from ordinary local views. Only explicitly recoverable pending user work remains in a recovery store.
- Historical sync events, occurrence payloads, replay results, and calendar/push paths must not bypass current access checks.
- Standalone reminders have no note dependency; never interpret `noteId = NULL` as a wildcard matching inaccessible notes.
- Locked notes remain a visibility feature, not encryption. Widgets and notifications hide their titles/body/images by default.

### 3.2 Notes, drafts, and operation identity

- A server revision describes the server document. A local draft sequence describes local editing. Do not use one field for both.
- A guarded write checks its base revision atomically with content and related database changes.
- A sent operation has an immutable ID/payload until its outcome is known. New edits must not rewrite an operation that might already be accepted.
- An accepted operation and its replay receipt commit together. Identical replay cannot mutate state again; reused IDs with a different fingerprint are rejected consistently.
- Acknowledging an older draft never replaces newer local work or advances an unrelated draft onto an unseen revision.
- Pin/order/view-state operations are user-specific and do not needlessly rewrite shared content.

### 3.3 Reminder definition, cursor, and occurrence

| Concept | Meaning |
| --- | --- |
| Schedule definition | User-selected anchor due time, timezone, and recurrence rule. |
| `scheduleVersion` | Version of that definition; changes on an actual user schedule edit, not firing/roll-forward. |
| Next-due cursor | Server/device progress through the schedule; legacy `dueAtUtc` may remain this cursor for web compatibility. |
| Original occurrence due | Immutable due time for one logical occurrence, unaffected by snooze or cursor advancement. |
| Occurrence identity | Derived identically on server/device from reminder sync ID, schedule version, and canonical original due time. |
| Occurrence action | Dismiss/snooze state for that occurrence, not destruction of the repeating schedule. |
| Delivery ledger | Device/profile-specific delivery state for the occurrence and explicit snooze delivery. |

Document the wire fields, version negotiation, missed-occurrence retention/catch-up policy, and no-op edit semantics. Protocol version 2 used `scheduleVersion` in occurrence identity while the server incremented it during cursor roll-forward. The definition/cursor split is advertised as protocol version 3 with an explicit capability. Preserve v2 history/IDs through upgrade and give older servers a clear compatibility result.

## 4. Work-package order and tracking

All packages are initially pending. Update status with the relevant test command/evidence as implementation proceeds.

| Package | Priority | Dependencies | Scope | Status |
| --- | --- | --- | --- | --- |
| WP0 | P1 | None | Test harness, fixtures, contract specification | Complete; expected red regression cases captured below |
| WP1 | P0 | WP0 | Access revocation across server/native dependent resources | Complete; revocation regression coverage passes |
| WP2 | P1 | WP0 | Transactional guarded writes and durable replay receipts | Complete; concurrency/crash/replay regression checks pass |
| WP3 | P1 | WP2 | Reminder definition/version semantics and atomic schedule writes | Complete; definition/cursor, protocol v3, fixtures and migration tests pass |
| WP4 | P1 | WP2 | Durable image/attachment replay and native integration | Complete for current replay/edit/restart/delete coverage |
| WP5 | P1 | WP2, WP3 | Native outbox, snapshots, acknowledgement and migrations | Complete for current database/outbox behavior tests |
| WP6 | P1 | WP5 | Editor revision/draft lifecycle and incoming updates | Complete for code/unit coverage; device acceptance is in WP12 |
| WP7 | P1 | WP0, WP6 | Rich-content/checklist preservation and adapters | Complete for adapters/automated round trips; device acceptance is in WP12 |
| WP8 | P1 | WP1, WP3, WP5 | Offline occurrences, alarm delivery and snooze reconciliation | Complete for automated code coverage; device alarm/permission acceptance is in WP12 |
| WP9 | P1 | WP5 | Reauthentication, immutable profiles and mTLS recovery | Complete for automated code coverage; AndroidKeyStore/device acceptance is in WP12 |
| WP10 | P2 | WP5, WP6, WP9 | Typed conflict recovery and durable personal state | Complete for automated code coverage; device acceptance is in WP12 |
| WP11 | P2 | WP1, WP4, WP6, WP8, WP10 | UI/widget completion, accessibility and media cleanup | Complete for code/unit coverage; device/accessibility acceptance is in WP12 |
| WP12 | P1 | All code packages | Integration, upgrade, device/gateway and release gates | Pending |

A package may be split into focused patches, but its invariant must stay coherent across server/native changes. Avoid broad formatting rewrites of `server/server.js`.

### WP0 baseline captured on 2026-10-05

- Shared recurrence/content fixtures are in `test-fixtures/native-contract.json`; Node and Android tests load the same inputs.
- The native server test uses isolated `DATA_DIR`, `UPLOAD_DIR`, `ATTACHMENT_DIR`, and `TAKEOUT_TMP_DIR`; it can restart against the same SQLite file, drop a successful HTTP response, and kill the process at named mutation failpoints in test mode.
- The test server's scheduler can be advanced through the test-only `/api/test/reminders/tick` route. Node recurrence accepts a deterministic `nowMs`; Android repository tests inject `NativeApi`, `ConnectionProfile`, `Clock`, alarm and notification interfaces.
- Native Room tests cover local transaction/coalescing, profile partitioning, an in-flight edit, accepted revision publication, session-expiry cache retention, stale snapshot behavior and offline alarm delivery. Editor snapshot policy has clean/dirty tests.
- Initial baseline reproduced R1, R3, R4, R6, R7 and R8 in `npm run test:native`, and local edit blocking, R2, R9 and R10 in `./gradlew testDebugUnitTest`. WP1 fixed R1; WP2 fixed R7/R8 and verifies crash/replay/interleaving; WP3 fixed R3/R4; WP4 fixed R6. The previously failing R2/R9 cases were addressed in WP8/WP7 follow-up; `./gradlew testDebugUnitTest`, `npm run test:native`, and `npm run test:sync` pass as of 2026-10-05. R10 and the broader package/device gates remain open.
- WP1 verification on the isolated two-user server now checks bootstrap, direct note/reminder reads, incremental reminder events/cursors, replay receipts, ICS, private image authorization, and occurrence visibility after revoke. Android Room tests check preservation of dirty drafts while removing ordinary note/reminder/occurrence/attachment records. R1-specific checks pass; R2–R10 regressions remain red for their ordered work packages.

## 5. WP0 — meaningful regression harness and contract fixtures

### Implementation

1. Establish an isolated server fixture with unique port/database and `DATA_DIR`, `UPLOAD_DIR`, `ATTACHMENT_DIR`, and `TAKEOUT_TMP_DIR` inside a temporary test directory. Remove it after server shutdown.
2. Provide request helpers preserving HTTP status and mutation results, including expected failures, replay, two-user requests, multipart uploads, and restart against the same database.
3. Add a deterministic clock/scheduler-tick seam. Tests must not wait for arbitrary wall-clock intervals to cover firing/roll-forward.
4. Add injectable native seams for profiles, network API, clock, alarms and notification sink. Use real in-memory Room for local transactions; fake platform boundaries where appropriate.
5. Add behavior tests for `KeeparrRepository` and editor state transitions, not just JSON copying/comparator helpers. A pinned MockWebServer dependency may be used for network outcomes.
6. Create shared recurrence/content fixtures in a source-controlled test directory containing only synthetic data. Both implementations should consume the same expected inputs/outputs.
7. Write the final protocol contract here or in a linked document: result types, canonical IDs, version checks, replay semantics and revocation outcomes.

### Exit check

The harness reproduces R1–R11 without production data. It can simulate lost responses, restart between transaction phases, editing during an in-flight request, and delivery after multiple offline recurrences.

## 6. WP1 — close revocation leaks and clean dependent resources

Status: complete for current behavioral coverage. The follow-up tests cover reminder/bootstrap, direct reminder listing, ICS, image access, occurrence visibility, and native recovery/cleanup. Continue to rerun them after later transaction, snapshot, and occurrence changes.

### Server changes

1. Add a reusable access predicate/helper for note-linked reminder visibility. Apply it to bootstrap, reminder list/CRUD, content enrichment, occurrence reads/actions, scheduling/push, ICS feeds, and calendar backfills/updates.
2. Never enrich an inaccessible reminder with current note content. Decide whether to omit it or expose a content-free suspended/tombstoned state; document the policy. Do not convert it into a standalone reminder retaining private text.
3. On sharing removal/leave, emit user-specific note/dependent-resource removals. Stop content-bearing presence/delivery events for the removed recipient.
4. Audit `/api/sync/changes` for queued historical payloads. Handle visibility without breaking cursor progression: filtering must not cause replay loops or incorrect `hasMore`.
5. Preserve personal ownership and `(userId, noteId)` uniqueness. Suspension/revocation must not alter another user's reminder/calendar identity/action.
6. Replay receipts must not return stored private payloads to revoked callers. Preserve acknowledgement of an already accepted operation without reapplying it; omit inaccessible content.
7. Audit occurrence bodies/images and asynchronous push/calendar tasks, not just foreground endpoints.

### Native changes

1. In one Room transaction, preserve genuinely pending drafts/files, remove ordinary records/dependent schedules, and freeze related outbox work as access-revoked.
2. Cancel alarms and visible notifications for removed resources; update app/widgets and remove profile-scoped cached media.
3. Recheck access/local existence at alarm dispatch and widget action time; queued callbacks can arrive after cancellation.
4. Keep recovery records outside home/search/widget/notification queries. A clean editor must not manufacture a pending draft merely because access was removed.

### Required regression tests

- Owner changes title/body/images/checklist after revocation; the removed user's bootstrap, changes, reminder/occurrence APIs, ICS, notifications and media reveal none of the new content.
- Personal reminders remain independent while access is valid; losing access affects only the revoked user's delivery.
- Standalone reminders remain visible/usable.
- Revocation with pending note/media edits preserves recovery work, freezes sending, clears normal views and cancels delivery.
- Regranting access follows a documented resume policy instead of automatically sending a stale recovered draft.

## 7. WP2 — atomic guarded saves and persistent replay

### Implementation

1. Transactionally combine access/base-version checks, resource changes, personal state belonging to the operation, sync-log entries, and accepted replay receipt.
2. Address the shared asynchronous SQLite connection explicitly. Merely putting `BEGIN/COMMIT` around a native route is insufficient: legacy requests, timers and helpers can interleave and accidentally join its transaction.
3. Implement a transaction-aware database layer or isolated transactional connection/context with appropriate locking/busy handling. All helpers inside the operation must use that context.
4. Use SQL revision predicates and affected-row checks. Cover creates/unique sync IDs, updates, deletes/tombstones, and concurrent access changes.
5. Store a canonical fingerprint and authoritative accepted result in the transaction. Identical replay survives restart; mismatched replay gives a deterministic error.
6. Publish WebSocket events/external side effects only after commit. Define retry of post-commit work without rolling back acceptance or duplicating external actions.
7. Treat files separately from SQLite rollback: stage first, retain durable ownership/references, and clean abandoned files through bounded recovery. Destructive file changes need recoverable database state.
8. Keep legacy overwrite behavior explicit. Legacy content edits invalidate native revisions; personal pin/view-state changes should not pretend to be shared content edits.

### Required regression tests

- Two users save one note from the same base: one accepted write, one conflict with the accessible latest document.
- A web edit invalidates a stale native base.
- Accepted replay after response loss/restart adds no revision, sync event or resource.
- Inject failure before receipt insertion, before commit, and after commit/before response. Pre-commit leaves neither partial mutation nor receipt; post-commit replays cleanly.
- Legacy writes/scheduler ticks cannot be committed/rolled back inside another request's transaction.
- Reused operation ID/different payload cannot alter state.

## 8. WP3 — atomic reminder definition/version semantics

### Implementation

1. Replace the blanket `dueAtUtc` trigger behavior. Distinguish schedule edits from next-due advancement; ordinary firing must not increment the definition version.
2. Persist an anchor/definition separately if needed, keeping legacy due-time semantics. Migrate without changing reminder IDs, sync IDs, calendar IDs, ownership or due-time interpretation.
3. Centralize normalization/writes across native sync, web CRUD, imports, smart actions and calendar paths. Assign sync identities and emit changes at creation, not just the next startup.
4. Validate `baseScheduleVersion` and include it in update/delete predicates inside WP2 transactions. Specify create bases and existing `(userId, noteId)` collision handling.
5. Canonicalize equivalent dates/timezones/rules before detecting changes. No-op saves must not invalidate delivery.
6. Return authoritative post-write values; do not publish pre-trigger `RETURNING` versions.
7. Preserve personal boundaries in CRUD, snooze, dismiss, delete, import and calendar cleanup. Note edits must not rewrite another user's schedule.
8. Specify inactive/revoked/deleted schedule behavior and historical action acknowledgement without scheduling new delivery.
9. Advertise the new definition-version semantics explicitly and require native protocol version 3 before a client depends on them; keep old web REST behavior backward compatible.

### Required regression tests

- Same-base concurrent update/update and update/delete yield one winner; test concurrent create collisions.
- A user schedule edit increments once; advancement/no-op edits do not.
- Responses, changes and bootstrap report the same authoritative version/identity.
- Migration preserves user/standalone reminders and sync/calendar IDs; rerun safely, including sequence behavior.
- Import/smart-created reminders have distinct nonempty sync IDs and synchronize immediately.
- Cross-user CRUD/sync/actions are denied before side effects and leave the other row unchanged.

WP3 implementation notes: `scheduleAnchorAtUtc` is backfilled from legacy `dueAtUtc`; firing advances the cursor without changing `scheduleVersion`; native sync requests declare whether they changed a definition via the payload version; and protocol capability version 3 advertises definition-version semantics. Shared cross-language fixtures include restoring the anchor day after a monthly clamp.

## 9. WP4 — durable media identity and acknowledgement

### Server changes

1. Persist upload identity independently of rebuildable `note_images` relationships. Prefer a durable receipt keyed by user/operation ID rather than the only receipt living on an ephemeral relationship.
2. Bind it to immutable uploaded content/type and accepted resource. Reject mismatched reuse; deduplicate concurrent retries with transactional uniqueness.
3. Retain it through note edits, relationship rebuilds, restart and retry. Define receipt retention/tombstones for genuinely deleted media so replay cannot silently duplicate it.
4. Check uploaded/linked image and attachment permissions. Knowing a filename/sync ID must not bypass access.
5. Preserve web multipart compatibility. Stable attachment IDs must be bound to the correct note/access as well as uniqueness.

### Native changes

1. Persist upload and image-link stages separately where necessary. Freeze sent link IDs/payloads until outcomes are known.
2. Apply accepted upload/link responses to Room immediately, including authoritative revision/media records. Later uploads must see earlier accepted state.
3. Treat SSL/DNS/timeouts, lost responses, retryable server errors and missing note dependencies as retryable, not permanent conflicts because an error code is negative.
4. Acknowledge a staged file only after its required server resource/link is accepted and the local acknowledgement is durable.
5. Keep files on access/conflict errors and provide recovery/discard choices. A recovered note cannot silently claim inaccessible server-only attachments were copied.
6. Partition staged uploads by profile/user; cleanup must not delete another profile's files.

### Required regression tests

- Replay before/after linking, after another note edit, and after restart returns the same image resource.
- Concurrent replay creates one resource; changed-content reuse is rejected.
- Two sequential images both remain linked/displayed without stale-revision conflict.
- Crash after server acceptance/before local acknowledgement: no duplicates, lost files or changed fingerprints.
- Attachment identity reuse cannot reparent it onto a different note.

WP4 implementation notes: `native_upload_receipts` persists content fingerprints and resource tombstones independently of image relationships/attachment rows. Image relationship rebuilding retains operation metadata; attachment/image retries reject changed content; delete paths tombstone receipts. The isolated server suite verifies replay after edit/restart and rejection after deletion. Large-file/cache budgets and request loss on real Android/API paths remain part of WP12.

## 10. WP5 — native outbox/snapshot correctness and upgrade safety

### Implementation

1. Model server identity/base, local draft sequence, pending intent, immutable sent operation, and typed retry/conflict/access state explicitly in Room. Export schema and add nondestructive migrations.
2. Coalesce only known-unsent work. Editing behind an in-flight/unknown-result operation queues a successor instead of replacing the original ID/payload.
3. Use explicit dependencies: note creation/acknowledgement precedes reminder/upload/organization operations. Do not rely on `rowid`, which changes with `REPLACE`.
4. Do not hold a global edit mutex throughout network synchronization. Claim a batch transactionally, request outside the edit critical section, acknowledge/reconcile with sequence checks.
5. Preserve every local-only resource during bootstrap/snapshots, including reminders/media; remove the note-only `baseRevision == 0` heuristic.
6. Apply canonical result identities when an upsert resolves to an existing personal reminder. Remap dependents, avoiding local/server copies under different sync IDs.
7. Apply snapshots/cursors atomically without replacing dirty drafts. Specify reconciliation of skipped pending records after acknowledgement so cursor advancement cannot hide their latest state.
8. Retain rejected work until acceptance or user resolution. Distinguish transient error, revision conflict, access loss, validation and incompatibility.
9. Migrate pending/conflicted operations/files from version-1 Room without destructive fallback; preserve replay identities when acceptance is unknown.

### Required regression tests

- Offline note + reminder + two uploads survive every intermediate snapshot and synchronize in dependency order.
- Editing during requests survives acknowledgement of older work.
- Lost accepted response + new edit + app restart replays the first operation unchanged and retains later work.
- Bootstrap preserves local-only reminders, removes revoked ordinary content, and isolates recovered drafts.
- Queued reorder/view-state operations converge to deterministic per-user state.
- Open a pre-change database with pending/conflicted work and verify migration/restart.

WP5 implementation notes: Room outbox schema version 3 removes the resource-level uniqueness constraint, records `queued`/`in_flight`/`conflict` state, creation order and operation dependencies, and migrates v1 rows through explicit v1→v2→v3 migrations. `KeeparrRepository.sync` now serializes network sync separately from local edits, claims immutable operations, drains newly unblocked work, retries the same in-flight operation after uncertainty, and advances successor revisions from accepted results. Robolectric tests cover migration, database reopen, snapshot retention, successor revision, profile partitioning, canonical reminder IDs and an offline note+reminder+two-upload flush using fake API/media ports. Reminder identity remapping has direct repository coverage. The previous R2/R9 failures are now green in the full Android unit suite; broader WP7/WP8 acceptance remains open.

## 11. WP6 — editor revision, persistence and incoming updates

### Implementation

1. Use a lifecycle-aware editor controller/ViewModel backed by the repository. Separate loaded base, draft, locally persisted sequence and incoming server version.
2. Adopt IDs/revisions from own accepted saves for existing/new notes. Rebase only onto the draft's accepted predecessor, never an unseen external revision.
3. Apply external changes when clean. When dirty, retain the draft and show incoming/conflict state without replacing text or moving the cursor.
4. Persist drafts independently of remote debounce. Survive rotation/recreation/background/process death instead of relying on `remember` plus a 600 ms timer.
5. Suppress synthetic edits on programmatic styled-text resets; avoid flattening, save loops and unnecessary selection resets.
6. Refresh media, collaborator metadata and accessible locked state without replacing dirty content.
7. Revocation stops autosave/presence, cancels dependencies, preserves genuine local edits and hides/closes content. Do not enqueue a clean unchanged note by default.
8. Distinguish saving/local-persisted/sync/conflict status; network errors still report whether the draft is saved locally.

### Required regression tests

- Edit/save/sync/edit an existing note in one session does not conflict with its own save.
- Clean editors apply web edits; dirty editors keep text/base and show incoming status.
- Rapid typing plus lifecycle recovery restores the latest locally acknowledged draft.
- Own acceptance/external saves interleave without silently rebasing over external content.
- Programmatic reset/media refresh generates no content mutation.

WP6 implementation notes (2026-10-05): `NoteEditorViewModel` owns lifecycle-scoped draft state and locally persists rapid edits with generation checks. Dirty state remains set until an accepted server snapshot arrives; later typing during an in-flight save is rebased only onto that operation's exact accepted predecessor. Changed external snapshots are surfaced without replacing the local draft, and local-persist failure is distinct from sync failure. The server mutation result carries its exact committed note payload; the editor refreshes collaborator/media metadata and immediately gates content against the current or incoming lock hash. Robolectric coverage verifies rapid local persistence, incoming-versus-accepted snapshots, and an edit during a blocked network save. Repository tests cover Room reopen, accepted revision publication and revocation recovery. Full Android unit tests pass. Device-specific cursor/media acceptance remains part of WP12.

## 12. WP7 — rich-content preservation and adapters

### Implementation

1. Create synthetic fixtures for plain paragraphs, links, inline styles, nested checklists, rich item strings, structured item data, inline images, drawing data URLs/SVG, attachments, unknown attributes/fields, locked notes and unsupported bodies.
2. Decide supported format for each editable body/item, not just `noteBody`. Rich item strings must not enter a plain-text replacement path.
3. Implement loss-aware native adapters. Preserve unknown fields and original markup when the relevant content was not edited.
4. Keep unsupported bodies/items read-only with readable previews/media where feasible. Retain originals verbatim; never delete entries solely because the editor cannot represent them.
5. Toggle/reorder/indent changes only intended fields, preserving identity, nested content, links and unrelated metadata.
6. Copy/share is an explicit export; plain-text exports must not replace stored rich content.
7. Verify cached/authenticated drawing and inline-image viewing. Drawing creation stays deferred.
8. Audit actual Android parser/serializer behavior; a regex tag allowlist alone proves no attribute/format round trip.

WP7 implementation notes (2026-10-05): the server stores opaque note properties in a migrated `extraFields` column and returns them alongside known fields. `npm run test:native` verifies create/read, legacy-client sync omission, web PATCH, clone and merge round trips, including deterministic first-source precedence for conflicting merge fields. Robolectric tests exercise Android `Html`/`EditText` serialization, the Jsoup rich-item adapter, structured checklist toggle/reorder/indent preservation, and repository sync retaining unsupported body markup, rich checklist strings, drawing data, attachment metadata and unknown fields. Device-specific and release end-to-end acceptance remains under WP12.

### Required regression tests

- Edit a rich checklist item without losing formatting/link, or verify it stays read-only until supported.
- Toggle/reorder/indent structured/rich entries without changing unrelated JSON/markup.
- Native edit -> server -> web -> native preserves supported content; unsupported originals survive edits to other fields verbatim.
- Exercise actual adapters and repository/server paths. Copying a `JSONObject` is not sufficient round-trip evidence.

## 13. WP8 — offline occurrences, alarms and actions

### Implementation

1. Extract a pure, testable planner using persisted definition, cursor, ledger and occurrence actions.
2. Compute later local occurrences under a stable definition version; persist enough state to validate/deliver offline after cursors move.
3. Share canonical identity/recurrence fixtures with the server. Server firing reconciles to an existing device occurrence, not a new notification identity.
4. Dispatch validates current version, note access/active state, occurrence action and snooze time. Do not require equality with the original reminder cursor for later valid occurrences.
5. Edits/deletes, archive/trash/revocation and logout cancel queued/visible stale delivery even when callbacks are already enqueued.
6. Rebuild alarms for reboot/unlock/update/time/permission/foreground recovery. Prevent reconstruction races that invalidate the alarm currently being delivered.
7. Check notification permission, global enablement and channel importance. Recheck exact-alarm access, handle SecurityException, and use documented fallback/status.
8. Use deterministic notification IDs and durable recovery states. `notify()` and Room are not atomic; test failure windows rather than claiming they are.
9. Persist snooze/dismiss with original identity. Reconnect after an offline snooze deadline acknowledges historical state without rejecting merely because its time is past or scheduling a duplicate.
10. Specify bounded history, catch-up and notification grouping. Do not silently drop occurrences via arbitrary loop counts or repeatedly reschedule invalid alarms every 500 ms.
11. Preserve recurrence options such as move-to-top and timezone when merely opening/saving a dialog.
12. Status shows actual next delivery, including snoozes, and permission/channel status, not merely minimum legacy due time.

### Required regression tests

- At least three daily occurrences deliver offline without an active process/server occurrence records.
- Local delivery followed by server firing/sync creates no duplicate notification/advancement.
- Explicit same-due schedule edits create a valid new version; old alarms cannot deliver.
- Offline snooze/dismiss, including reconnect after deadline, converges without destroying recurrence.
- Delete/archive/trash/revoke before dispatch prevents stale/private notification.
- Shared fixtures cover DST gaps/overlaps, month-end/leap years, custom intervals, non-hour offsets and invalid zones. Align overlap-offset preference explicitly.
- Permission/channel denial does not mark delivery falsely; exact-alarm denial uses fallback.

WP8 implementation notes (2026-10-05): Android now uses a pure `ReminderPlanner` with a 100,000-occurrence validation bound. It delivers the seven most recent missed occurrences individually and folds older misses into one deterministic summary notification, tracked separately so schedule edits/revocation cancel it. Per-profile delivery ledgers and deterministic notification IDs cover the `notify()`/Room crash window. Queued alarms/actions are validated against current schedule version, recurrence anchor and local note state; stale actions are rejected. Expired offline snoozes are acknowledged without scheduling a duplicate. Notification/channel denial cancels alarms without marking delivery, exact-alarm `SecurityException` falls back to inexact delivery, and settings computes the next delivery including snoozes. The dialog preserves timezone and `moveToTopOnTrigger`. Server action validation recognizes later valid occurrences after its cursor advances and accepts historical snooze acknowledgements. Shared fixtures cover DST gap/overlap, leap year, non-hour offset and invalid-zone fallback. Robolectric and server regression suites pass; actual reboot/permission/device acceptance remains under WP12.

## 14. WP9 — authentication and mTLS/profile recovery

### Implementation

1. Model observable connection states: configured, authenticated, session expired, gateway denied, certificate attention required, incompatible and offline. A nonempty token is not sufficient state.
2. Reauthenticate the same profile/account without clearing Room/cursors/drafts/ledgers/widgets/files. Resume its jobs only after authentication/capabilities succeed.
3. Validate returned account identity. A different account keeps the old data isolated and requires explicit transition; never send old operations as the new user.
4. Bind requests/clients to immutable profile snapshots. Connection testing must not temporarily change live global origin/token/headers during worker/media activity.
5. Align configuration with DataStore and protocol envelopes with Kotlin serialization. Preserve arbitrary document fields through raw JSON/extension maps. Migrate settings/encrypted credentials nondestructively without a plaintext secret copy.
6. Scope credentials/headers to origins, keep normal trust/hostname verification and reject forwarding on redirects/external media. Key managers capture aliases instead of reading mutable globals.
7. Rebuild clients after certificate selection, including the same alias after grant renewal/replacement; resume foreground sockets/background jobs correctly.
8. Background missing grants retain cache and persist actionable status. Only foreground setup launches the chooser.
9. Keystore/decrypt failures are recoverable setup/authentication states, not silent resets. Secrets stay out of backups/diagnostics.
10. Separate reauthentication from destructive sign-out; clear only the confirmed profile and enumerate actual pending work.

WP9 implementation notes (2026-10-05): API requests, sync runs, media transfers and realtime sockets now use immutable redacted `ConnectionSnapshot`s; connection testing no longer swaps live global settings. TLS key managers capture the selected alias, and reselection increments an alias revision so selecting the same certificate rebuilds the client. Reauthentication validates capabilities before applying credentials, prompts before changing account/profile, retains Room state, and resumes sync only after confirmation. Session expiry is an observable connection state with an in-place sign-in path. Logout clears only the active profile's pending media files, and stale editor/background work cannot enqueue under a newly active profile. Realtime authentication now accepts the bearer header; legacy query-token clients remain compatible. Connection preferences use DataStore with `SharedPreferencesMigration`; encrypted credential ciphertext is migrated as-is, and decryption failures retain it while prompting recovery. Typed Kotlin-serialization mutation envelopes keep document payloads as raw JSON objects so extension fields round-trip. Robolectric tests cover legacy preference migration/reopen, immutable request snapshots, alias reselection invalidation, account-switch policy, previous-profile write rejection and expired-session cache retention. Real AndroidKeyStore/concurrent mTLS account-transition acceptance remains under WP12.

### Required regression tests

- Expire a session with edits/uploads, reauthenticate and replay without loss/duplicates.
- Login as another user cannot cross cached content/jobs/credentials between profiles.
- Connection testing during worker/media requests maintains one consistent intended origin/token/header set per request.
- Reselecting the same alias actually rebuilds clients.
- Missing/expired/revoked certificates retain cache; transient errors retain retryable operations.
- Migration preserves mappings/encrypted secrets; logs/export contain no tokens/passwords/headers/note content/certificate material.

## 15. WP10 — typed conflicts and durable personal state

### Implementation

1. Replace boolean `keepDraft` with typed choices/resource handlers.
2. Note conflicts offer compare, keep server, explicit guarded replacement and save-as-copy even with a latest server version. Checklist comparison shows item differences, not only title/body.
3. Reminder conflicts operate on reminders, never `note` records. Define schedule comparison/retry/discard; actions distinguish deleted schedules, revoked access and historical acknowledgement.
4. Revalidate version/access at resolution; a further change produces another recoverable conflict.
5. Copy recovery keeps drafts/recoverable files, resets identity/sharing metadata, and does not claim inaccessible server-only attachments were copied.
6. Retain the only recovery payload until a replacement is durably queued or explicitly discarded.
7. Queue checklist-collapse through durable user-state operations. Pin/order/view state must not rewrite shared content or vanish on bootstrap.
8. Provide outgoing copy/share; recovery content remains outside normal previews until restored explicitly.

### Required regression tests

- Every note resolution choice keeps the expected content/files.
- Reminder/action choices cannot create malformed notes or silently discard unresolved schedules.
- Post-revocation copy with files creates a usable note linking only accessible/reuploaded media.
- Offline collapse change survives restart/sync and matches native/web per-user state without changing another user's preference.

WP10 implementation notes (2026-10-05): `ConflictResolution` distinguishes replace, use-server, save-as-copy and discard paths. Note replacement rebases the draft on the latest guarded revision; reminder replacement bumps schedule version and never writes reminder payloads into note records. The conflict UI compares note bodies and checklist items. Copy recovery rehomes staged uploads, strips inaccessible server-only attachment/image references, and queues the copy before releasing the source recovery payload. Checklist collapse is a separate durable `note.view-state` outbox mutation; the server stores it per user and emits incremental note snapshots. Android/server tests cover note/reminder isolation, note rebase/copy/discard, staged-upload retention, view-state survival through Room reopen/sync, and independent owner/collaborator preferences. Device-specific conflict/accessibility acceptance remains under WP12.

## 16. WP11 — planned UI/widgets and profile-scoped cleanup

### Notes/editor

- Finish drag ordering with correct pin/filter semantics, drag feedback and accessible move actions. It must not unexpectedly move filtered-out notes or reorder on normal edits.
- Preserve grid/list ordering, large-font usability, keyboard behavior and theme contrast/colors.
- Show local saving, pending, failed, conflict and recovery states accurately.
- Verify labels/binders, archive/trash/restore, sharing/presence, photo/file picking, incoming text/URL/image shares, outgoing copy/share and offline search against original requirements.
- Preserve full recurrence options/custom intervals and accessible reminder management.

### Widgets

1. Share profile/repository/order/filter contracts; no separate token or network-only source.
2. Use reliable activity PendingIntents to open notes and broadcast checklist actions. Validate current background-launch restrictions instead of assuming a broadcast-to-activity trampoline works.
3. Provide scrollable access to the full single-note checklist; eight hard-coded interactive rows must not be the only way to access later entries.
4. Include both note/checklist creation in the collection action area, deterministic persisted configuration and actionable status/open/refresh controls.
5. Match app pinned sections, inactive/binder filtering and sequence. Verify unsynced tie-breakers and independent widget configurations/IDs.
6. Budget text by characters/bytes before RemoteViews, not only max lines. Bound thumbnails/collection memory without limiting accounts to a recent-note subset.
7. Retain private/cached rows through offline/process/reboot/session errors; reject stale wrong-profile/inaccessible/missing-item actions.
8. Refresh on local edits/reorders/pins, successful sync and explicit cached refresh even when network fails.

### Media/diagnostics

- Profile-partition pending files/cache metadata; bounded eviction never deletes unacknowledged uploads or another profile's work.
- Keep authenticated/drawing previews useful offline and explain unavailable media without flattening/saving it.
- Export useful redacted diagnostics off the UI thread and test the exported content.

### Exit check

Every original code-backed UI/widget requirement has concrete implementation and behavioral evidence; device/launcher checks remain explicit in WP12.

WP11 implementation notes (2026-10-05): manual reorder is limited to unsearched Home/Pinned views, rejects cross-pin-group moves and hides drag affordances in other filters. Multi-select now exposes owner-only bulk Trash with confirmation; individual Trash is confirmed and trashed notes have a visible Restore action. Widgets use fixed-height note cards in a scrollable grid, have no toolbar, and use a single floating create-note button; the separate quick-create widget still offers note and checklist creation. Single-note checklist widgets expose every item as its own scroll row and use explicit activity PendingIntents for open/toggle. Note editor and widget text choose foreground contrast from note background colors. The server field uses URL keyboard settings and app label/icon match Keeparr. Per-widget filters remain independent. Media cache eviction and sign-out cleanup are profile-scoped; redacted diagnostics are assembled/written off the UI thread and tested for secret/content exclusion. Robolectric coverage checks widget item completeness, reorder policy, redaction, cache isolation and bulk trash/restore queuing. Font scaling, keyboard/accessibility, launcher/background-start, and real widget behavior remain device acceptance under WP12.

## 17. WP12 — verification matrix and release gates

### Commands

From the repository root:

```bash
npm run test:native
npm run test:sync
npm run test:reminders
npm run build
git diff --check
```

From `android-native/`:

```bash
./gradlew testDebugUnitTest assembleDebug
./gradlew lintDebug
```

### Current verification — 2026-10-05

- Passed: `npm run test:native`, `npm run test:sync`, `npm run test:reminders` (10 cases), `npm run test:mcp` (21 cases), `npm run build`, `./gradlew testDebugUnitTest assembleDebug lintDebug`, and `git diff --check`.
- `adb devices -l` reports no attached devices. The real Cloudflare/mTLS gateway and target launchers are not provisioned in this environment, so device rows below remain pending.
- Debug APK: `android-native/app/build/outputs/apk/debug/app-debug.apk`. No release signing/publishing workflow or key was created.

Wire new behavioral tests into these tasks or document their exact new commands. Shared server/auth changes also require affected suites such as `npm run test:mcp`. An unchanged smoke suite is not evidence for paths it never exercises.

Use the documented release-build/signing workflow for performance after establishing it; do not create a new publishing key or release silently. Record cache/grid/widget storage, memory and latency with a large synthetic account.

### Device/gateway evidence matrix

| Scenario | Required environment | Required evidence |
| --- | --- | --- |
| Installed-certificate connection | Real Cloudflare policy and installed Android certificate | Setup test, login, bootstrap, authenticated upload/download, realtime and closed-app widget refresh succeed. |
| Credential recovery | Same gateway; expired session and certificate replace/revoke/regrant | Cache/pending work survive; same-profile login and alias renewal restore all entry points. |
| Offline delivery | Persisted schedule, process removed, network off | One-shot and multiple repeats arrive; notification actions work locally. |
| Lifecycle recovery | Reboot after unlock, update, clock/timezone change | Schedules reconstruct, old-version callbacks do not deliver, no duplicate notifications. |
| Permissions | Notification/exact-alarm permissions and disabled channel | Accurate status and contractual fallback/retained-occurrence behavior. |
| Collaboration | Two accounts plus existing web app | Clean updates, dirty conflicts, personal reminders, owner-only actions and revocation pass. |
| Widgets | OnePlus launcher and another launcher/device | Order/filter/resize/toggle/open/create/offline/reboot and touch targets pass. |
| OS compatibility | API 26, 31, 33, 34 and user's Android 16 device | Installation and relevant behavior recorded; unavailable combinations remain pending. |
| Content/accessibility | Synthetic rich/locked notes, TalkBack, large fonts | Real edits preserve content; previews/actions remain readable, usable and private. |
| Performance | Release build and large synthetic cache | Measured scrolling/search/cache/widget memory/latency meet recorded targets. |

Force-stop is a separate Android limitation. Do not count expected stopped-state suppression as an ordinary-process-death failure; verify reopening reconstructs delivery. Record whether each test killed the process, swiped the task or force-stopped the package.

### Reference capture and deployment readiness

1. When available, re-extract installed Keep/Keeparr APK sets and record versions/checksums/UI captures in ignored `android-native/references/`.
2. Keep personal notes, APKs, certificates, gateway secrets and credentials out of source control; committed fixtures are synthetic.
3. Record precise prerequisites/blockers. Missing devices/gateway credentials mean pending checks, not completion.
4. Update the product checkpoint and tracking table with real completion, protocol/migration notes and verification.
5. Final handoff lists changed files, schema/compatibility details, test results, remaining blockers and debug APK path.

## 18. Definition of done

- [ ] R1–R14 have behavioral regression coverage and fixes, or reviewed contract changes supersede findings with equivalent acceptance evidence.
- [ ] Revocation prevents shared-content access across direct, derived and historical delivery paths.
- [ ] Guarded operations/receipts commit atomically and replay after crashes/restarts.
- [ ] Draft/outbox/file migrations preserve work and immutable operation identity.
- [ ] Server/native definitions, recurrence and occurrence IDs agree; offline repeats/actions pass.
- [ ] Actual native/web adapter round trips preserve rich/unknown/locked content.
- [ ] Reauthentication and certificate/grant recovery retain cached/unsynchronized work.
- [ ] Every original code-backed app/widget feature is implemented and reviewed against acceptance.
- [ ] Relevant server/web and native behavioral tests, builds and lint pass; genuine pre-existing failures are documented.
- [ ] The device/gateway/launcher/accessibility/performance matrix has evidence, or final status explicitly remains incomplete with blockers listed.

Do not label this release-ready because an APK builds, existing unit tests pass, or feature buttons are present.
