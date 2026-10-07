import type { NoteI } from '../interfaces/notes';
import { EDITOR_DRAFT_FIELDS, type EditorDraftField } from './editor-session';
import { noteColorToHex } from './note-color';

/**
 * Field-level three-way merge for guarded note saves. `base` is the accepted
 * server state an edit started from, `local` is the saved document, `latest`
 * is what the server holds now. Fields the user did not change always follow
 * the server, so concurrent labels, organization, and personal state survive.
 */

export type GuardFields = Partial<Pick<NoteI, EditorDraftField>>;

export function pickGuardFields(note: NoteI): GuardFields {
  const picked: Record<string, unknown> = {};
  for (const field of EDITOR_DRAFT_FIELDS) picked[field] = structuredClone((note as unknown as Record<string, unknown>)[field] ?? null);
  return picked as GuardFields;
}

/** Representation-independent value used only to compare fields. */
export function canonicalNoteField(note: GuardFields | NoteI, field: EditorDraftField): string {
  const value = (note as Record<string, unknown>)[field];
  switch (field) {
    case 'labels':
      return JSON.stringify(((value as NoteI['labels']) || []).filter(label => label.added !== false).map(label => label.name).sort());
    case 'checkBoxes':
      return JSON.stringify(((value as NoteI['checkBoxes']) || []).map(item => ({
        id: item.id, done: !!item.done, data: item.data ?? '', indentLevel: item.indentLevel || 0
      })));
    case 'images':
      return JSON.stringify(((value as NoteI['images']) || []).map(image => ({
        id: image.id, dataUrl: image.dataUrl, name: image.name || '', placement: image.placement || 'bottom'
      })));
    case 'bgColor':
      return noteColorToHex(String(value || ''));
    case 'pinned': case 'isCbox': case 'archived': case 'trashed':
      return String(!!value);
    default:
      return String(value ?? '');
  }
}

export function changedNoteFields(from: GuardFields | NoteI, to: GuardFields | NoteI): EditorDraftField[] {
  return EDITOR_DRAFT_FIELDS.filter(field => canonicalNoteField(from, field) !== canonicalNoteField(to, field));
}

export interface GuardedMergeResult {
  merged: NoteI;
  /** Fields changed both locally and on the server to different values. */
  conflicts: EditorDraftField[];
  /** Fields the user changed (relative to the base). */
  localFields: EditorDraftField[];
}

export function mergeGuardedNote(base: GuardFields, local: NoteI, latest: NoteI): GuardedMergeResult {
  const localFields = changedNoteFields(base, local);
  const conflicts = localFields.filter(field =>
    canonicalNoteField(latest, field) !== canonicalNoteField(base, field)
    && canonicalNoteField(latest, field) !== canonicalNoteField(local, field));
  const merged = overlayNoteFields(latest, local, localFields.filter(field => !conflicts.includes(field)));
  return { merged, conflicts, localFields };
}

/** `latest` with the listed fields taken from `local`. */
export function overlayNoteFields(latest: NoteI, local: NoteI, fields: readonly EditorDraftField[]): NoteI {
  const next = { ...latest } as Record<string, unknown>;
  for (const field of fields) next[field] = structuredClone((local as unknown as Record<string, unknown>)[field]);
  return next as unknown as NoteI;
}
