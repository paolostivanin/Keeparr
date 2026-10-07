# Sync mutation and cursor contract

This documents the current HTTP sync shapes used by the web and native clients. Raw note payloads retain unknown fields; clients must not treat a card projection as an editable document.

## Capability negotiation

`GET /api/client/capabilities` advertises `incrementalMutationResponses`. Older clients may omit incremental options and continue receiving the full-snapshot response.

## Mutation request

`POST /api/sync/mutations` accepts an ordered array of resource mutations. A representative web outbox request is:

```json
{
  "includeSnapshot": false,
  "mutations": [{
    "type": "note.upsert",
    "syncId": "stable-note-identity",
    "operationId": "immutable-operation-identity",
    "payload": { "syncId": "stable-note-identity", "noteTitle": "Example" },
    "lww": {
      "physicalMs": 1791379200000,
      "logical": 0,
      "deviceId": "client-device",
      "operationId": "immutable-operation-identity"
    }
  }]
}
```

Native note edits may additionally provide `baseRevision`; reminder edits may provide `baseScheduleVersion`. These guards are checked by the server against the current accepted resource. A rejected guard returns a conflict result with the latest accessible resource where supported. A successful `operationId` is recorded transactionally with the mutation result; an identical retry replays its acknowledgement rather than reapplying the mutation.

Web field-only changes use `note.patch` with the note identity and an allowlisted `payload.patch`, for example:

```json
{
  "type": "note.patch",
  "syncId": "stable-note-identity",
  "operationId": "immutable-patch-operation",
  "payload": { "id": 42, "patch": { "binder": "Projects" } }
}
```

The client commits its updated local note and patch outbox entry atomically. The server applies only the named fields to the latest accessible note inside the mutation/receipt transaction, preserving unrelated changes made by another client after the local note was read. Retries replay by operation identity. Full-document edits remain separate `note.upsert` operations and retain their revision/conflict semantics.

Web merges use `note.merge` with an ordered list of source `syncId`s and a new merged-note `syncId`. The browser atomically stores the merged document, source trash state, attachment reparenting, pending-reminder selection, and merge outbox intent. Attachment upload payloads retain their source identity; the web sync cycle completes source uploads before sending the merge operation, so a potentially sent upload keeps its original operation data. The server receipt transaction materializes the merged content, reparents attachments, keeps the earliest pending reminder, trashes sources, publishes note/attachment/reminder changes, and schedules external-calendar cleanup after commit. Mutation ordering applies queued source note/reminder writes and source uploads before the merge; merge-target note/reminder/attachment deletions and target uploads run after it.

## Mutation response and cursor handling

The response has one result per submitted mutation, in request order, plus `serverTime` and `serverCursor`. Successful resource mutations return the authoritative resource identity/ID and payload when that operation has one. `includeSnapshot:false` omits the account snapshot.

`serverCursor` is a high-water mark only. It is not a durable client cursor and must never replace the client's current cursor. Clients catch up with `GET /api/sync/changes?cursor=<durable cursor>` and persist the cursor returned by the change feed only after applying that feed page. Requests omitting `includeSnapshot:false` retain the backward-compatible snapshot response.

## Local persistence and replay

- Web IndexedDB stores the full local note and its outbox entry in one transaction. The top-level `operationId` and LWW stamp survive retry unchanged. Staged attachments commit the blob, attachment preview, owning note, and upload intent together.
- Newly persisted note upserts are marked `unsent`; a sync cycle marks them potentially sent before HTTP transport. Only explicitly-unsent updates may be coalesced. Legacy entries without send-state metadata are treated as potentially sent and retained unchanged.
- Android Room stores raw note JSON and the outbox in one transaction. Sent operations are immutable; successors depend on their predecessor and receive the accepted revision after acknowledgement.
- Server receipt replay is keyed by user and operation identity. Reusing an operation identity with a different payload is rejected.
- Resource identity is `syncId`; numeric IDs may change from a local negative value to the server ID without changing the logical note.

## Known rollout boundary

The web editor currently uses note upserts for full-document saves; those saves do not yet send guarded revisions or expose typed conflict/recovery state for a rejected update. Partial field changes use replayable field-only patches. Broader conflict recovery and acknowledgement-chain handling remain W3/C1 deliverables. Web sync cycles use partition-scoped Web Locks with receipt replay as fallback, and incremental feed pages apply resource changes and cursor advancement transactionally.
