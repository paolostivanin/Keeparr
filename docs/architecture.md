# Architecture and ownership map

This document records the current authoritative state and write boundaries while the maintainability plan is delivered incrementally.

## Web client

| Responsibility | Owner | Authority / compatibility |
| --- | --- | --- |
| In-memory ordered notes and identity indexes | `NotesStoreService` | Canonical web collection keyed in memory by `syncId` and numeric ID. `NotesService.notesList$` and `SharedService.note.all` are compatibility facades. |
| Note commands and remote loading | `NotesService` | Owns create/update/delete, card-page loading, realtime events, and local publication. Full-document saves commit through the offline store before asynchronous delivery; some partial operations remain network-first. |
| Durable local notes, attachments, and replay intents | `OfflineStoreService` | IndexedDB is authoritative for cached full documents, attachment blobs, and the outbox. Document/outbox writes use one transaction for note edits and staged attachment uploads. |
| Queue delivery and server change feed | `OfflineSyncService` | Claims the active account partition, submits immutable operation identities, applies server changes, and publishes resource-family deltas. |
| Reminders, labels, binders, selection, navigation | `ReminderService`, domain services, and `SharedService` | Separate state domains; `SharedService` still contains transitional UI/navigation and command responsibilities. |
| Card rendering | `NoteCardPreviewComponent`, `NoteCardActionsComponent`, `NoteCardControlsComponent` | Leaf presentation boundaries. `NotesComponent` still owns the grid, gestures, ordering, overlays, editor opening, and card command handlers. |
| Editor | `InputComponent` | Owns DOM editing and current save snapshot; a durable editor-session abstraction and lifecycle recovery are not yet complete. |

## Native Android

| Responsibility | Owner | Authority / compatibility |
| --- | --- | --- |
| Local documents, Room transactions, and outbox | `KeptRepository` and `KeptDatabase` | Room raw note JSON and the outbox remain authoritative; typed/projection work is derived from those records. |
| Sync/protocol | `KeptRepository`, `NativeProtocol`, and `SyncWorker` | Shared native contract fixtures define wire compatibility; operation IDs and revision guards protect replay and updates. |
| Connection settings and authenticated client snapshots | `Connection` and `ApiClient` | Settings initialize asynchronously; requests capture immutable profile snapshots. |
| Screen/editor state | `KeptScreen`, `NoteCardUiModel`, `NoteEditorViewModel`, and Compose UI | Home card fields are projected off main into immutable `NoteCardUiModel` values; the ViewModel and AndroidView editor remain in place, with full screen extraction and bounded session ownership still planned. |
| Media staging/loading | `Media` | Pending upload files, authenticated OkHttp access, disk cache, and bounded decoded previews are managed here. |

## Backend

| Responsibility | Owner | Authority / compatibility |
| --- | --- | --- |
| HTTP routes, SQLite access, and transaction boundaries | `server/server.js` | The shared SQLite database and post-commit effects remain centralized; preserve their transaction ordering during extraction. |
| Static entry point, hashed assets, and cache policy | `server/static-assets.js` | Mounted by the existing server bootstrap; entry points/workers revalidate while content-hashed assets are immutable and compressible. |
| Client capability negotiation | `server/client-capabilities.js` | Advertises the native protocol and incremental mutation features as an independent route boundary. |
| Native mutation route and response negotiation | `server/sync-routes.js` | The route preserves request-order results, snapshot compatibility, and high-water/cursor separation while injecting transaction-bound mutation operations from the server. |
| Native operation semantics | `server/native-client.js` and sync mutation functions in `server/server.js` | Revision checks, operation receipts, LWW compatibility, resource change cursors, and negotiated incremental replies are covered by protocol tests. |
| Realtime/reminder domain helpers | `server/reminder-recurrence.js`, `server/oauth-mcp.js`, and server services | Existing extracted modules should remain the boundaries when adjacent routes are split. |

## Durable-write invariants

- A successful local note or staged attachment save means the local document and replayable intent have both committed.
- Account partitions include server origin and user identity; switching profiles must not mix cached documents or media.
- Stable resource identity is `syncId`; numeric IDs may be remapped after server acceptance.
- The server change-feed cursor advances only after applying its corresponding changes. A mutation high-water mark is not itself a cursor acknowledgement.
- Card previews are incomplete projections and must not replace a cached full document.

## Transitional facades and migration points

- `NotesService.notesList$` aliases `NotesStoreService.notes$` while consumers migrate to selectors.
- `SharedService.note.all/pinned/unpinned` presents compatibility views over the notes store; `SharedService` still owns unrelated UI and command concerns.
- `NoteI` currently represents both card previews and complete notes with `isCardPreview`; distinct public types remain planned.
- The large Angular notes/editor components and Android `KeptScreen.kt` remain active ownership boundaries pending behavior-preserving extraction.
