import { InputComponent } from './input.component';
import { NoteI } from 'src/app/interfaces/notes';

function makeEditor() {
  const editor = Object.create(InputComponent.prototype) as any;
  const title = { nativeElement: { innerHTML: 'my title' } };
  const body = { nativeElement: { innerHTML: 'my unsaved full draft' } };
  Object.assign(editor, {
    noteTitle: title, noteBody: body, noteMain: { nativeElement: { style: {} } },
    noteToEdit: { id: 5, syncId: 'n5', revision: 7, noteTitle: 'title', noteBody: 'body', labels: [] },
    images: [], attachments: [], isDrawingNote: false, isCbox: { next: () => undefined },
    cd: { detectChanges: () => undefined }, auth: { authenticatedImageUrl: (value: string) => value },
    normalizeCheckBoxes: (value: unknown) => value, resetCboxHistory: () => undefined,
    decorateLinksForEditor: (value: string) => value, hasMeaningfulBody: () => true,
    updateHtmlWithCursorPreservation: (element: { innerHTML: string }, html: string) => { element.innerHTML = html; },
    noteSaveSnapshot: () => JSON.stringify({ noteTitle: 'title' })
  });
  return { editor, title, body };
}

const remote = (extra: Partial<NoteI> = {}) => ({
  id: 5, syncId: 'n5', revision: 8, noteTitle: 'remote title', noteBody: 'remote body', checkBoxes: [], images: [], attachments: [],
  isCbox: false, labels: [], ...extra
}) as NoteI;

describe('InputComponent incoming updates', () => {
  it('never replaces the editor with a truncated card preview', () => {
    const { editor, body } = makeEditor();
    spyOn(editor, 'hasUnsavedEdits').and.returnValue(false);

    editor.applyExternalUpdate(remote({ isCardPreview: true, noteBody: 'truncated…' }));

    expect(body.nativeElement.innerHTML).toBe('my unsaved full draft');
  });

  it('keeps what the user typed and remembers that a newer version was held back', () => {
    const { editor, body, title } = makeEditor();
    spyOn(editor, 'hasUnsavedEdits').and.returnValue(true);

    editor.applyExternalUpdate(remote());

    expect(body.nativeElement.innerHTML).toBe('my unsaved full draft');
    expect(title.nativeElement.innerHTML).toBe('my title');
    expect(editor.externalUpdatePending).toBeTrue();
  });

  it('applies the update when the editor is clean and adopts it as the new base', () => {
    const { editor, body } = makeEditor();
    editor.externalUpdatePending = true;
    spyOn(editor, 'hasUnsavedEdits').and.returnValue(false);

    editor.applyExternalUpdate(remote());

    expect(body.nativeElement.innerHTML).toBe('remote body');
    expect(editor.noteToEdit.revision).toBe(8);
    expect(editor.externalUpdatePending).toBeFalse();
  });

  it('saves against the editor\'s own base only while a newer version is being held back', () => {
    const { editor } = makeEditor();
    editor.saveBaselineSnapshot = JSON.stringify({ noteTitle: 'the title I started from' });

    expect(editor.editBaseForSave()).toBeUndefined();
    editor.externalUpdatePending = true;
    expect(editor.editBaseForSave()).toEqual({ revision: 7, fields: { noteTitle: 'the title I started from' } });
  });
});
