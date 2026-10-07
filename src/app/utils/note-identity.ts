import type { NoteI } from '../interfaces/notes';

/**
 * Whether a freshly read copy of a note is, for display purposes, the note already on screen. When it is,
 * the existing object is kept so cards, per-note caches and presence flags are not rebuilt by a republication
 * of the whole collection. Anything that can change what a card shows must be covered here; the cheap
 * revision/stamp fields settle almost every case and the rest guard changes that do not bump them.
 */
export function sameDisplayedNote(shown: NoteI, fresh: NoteI): boolean {
  if (shown === fresh) return true;
  return shown.syncId === fresh.syncId
    && shown.id === fresh.id
    && shown.revision === fresh.revision
    && shown.updatedAt === fresh.updatedAt
    && shown.lwwOperationId === fresh.lwwOperationId
    && shown.lwwPhysicalMs === fresh.lwwPhysicalMs
    && shown.lwwLogical === fresh.lwwLogical
    && !!shown.isCardPreview === !!fresh.isCardPreview
    && shown.sortOrder === fresh.sortOrder
    && !!shown.pinned === !!fresh.pinned
    && !!shown.archived === !!fresh.archived
    && !!shown.trashed === !!fresh.trashed
    && shown.noteTitle === fresh.noteTitle
    && shown.noteBody === fresh.noteBody
    && shown.ownerDisplayName === fresh.ownerDisplayName
    && shown.ownerUsername === fresh.ownerUsername
    && shown.ownerAvatarDataUrl === fresh.ownerAvatarDataUrl
    && shown.ownerAvatarPreset === fresh.ownerAvatarPreset
    && (shown.attachments?.length ?? 0) === (fresh.attachments?.length ?? 0)
    && (shown.checkBoxes?.length ?? 0) === (fresh.checkBoxes?.length ?? 0)
    && JSON.stringify(shown.images ?? []) === JSON.stringify(fresh.images ?? [])
    && JSON.stringify(shown.labels ?? []) === JSON.stringify(fresh.labels ?? [])
    && JSON.stringify(shown.collaborators?.map(({ online, ...person }) => person) ?? [])
      === JSON.stringify(fresh.collaborators?.map(({ online, ...person }) => person) ?? [])
    && JSON.stringify(shown.checkBoxes ?? []) === JSON.stringify(fresh.checkBoxes ?? []);
}
