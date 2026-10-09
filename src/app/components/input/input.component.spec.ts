import { InputComponent } from './input.component';
import { NoteI } from 'src/app/interfaces/notes';

function makeEditor() {
  const editor = Object.create(InputComponent.prototype) as any;
  const title = { nativeElement: { innerHTML: 'my title' } };
  const body = { nativeElement: { innerHTML: 'my unsaved full draft' } };
  Object.assign(editor, {
    noteTitle: title, noteBody: body, noteMain: { nativeElement: { style: {} } }, notePin: { nativeElement: { dataset: {} } },
    labels: [{ name: 'work', added: false }, { name: 'home', added: true }], isArchived: false, isTrashed: false, binderName: '',
    applyBackgroundImage: jasmine.createSpy('applyBackgroundImage'), updateTextColor: () => undefined,
    noteToEdit: { id: 5, syncId: 'n5', revision: 7, noteTitle: 'title', noteBody: 'body', labels: [] },
    images: [], attachments: [], isDrawingNote: false, isCbox: { next: () => undefined },
    cd: { detectChanges: () => undefined }, auth: { authenticatedImageUrl: (value: string) => value },
    normalizeCheckBoxes: (value: unknown) => value, resetCboxHistory: () => undefined,
    decorateLinksForEditor: (value: string) => value, hasMeaningfulBody: () => true,
    updateHtmlWithCursorPreservation: (element: { innerHTML: string }, html: string) => { element.innerHTML = html; },
    noteSaveSnapshot: () => JSON.stringify({ noteTitle: 'title' }),
    hydrateEditorLinkPreviews: jasmine.createSpy('hydrateEditorLinkPreviews'),
    hydrateInlineImageButtons: jasmine.createSpy('hydrateInlineImageButtons')
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

  it('shows pin, archive, binder and label changes too, so the adopted baseline matches the editor', () => {
    const { editor } = makeEditor();
    spyOn(editor, 'hasUnsavedEdits').and.returnValue(false);

    editor.applyExternalUpdate(remote({
      pinned: true, archived: true, trashed: false, binder: 'Projects', bgImage: '',
      labels: [{ name: 'work', added: true }] as any
    }));

    expect(editor.notePin.nativeElement.dataset.pinned).toBe('true');
    expect(editor.isArchived).toBeTrue();
    expect(editor.binderName).toBe('Projects');
    expect(editor.labels.map((label: { name: string; added: boolean }) => [label.name, label.added])).toEqual([['work', true], ['home', false]]);
    expect(editor.noteToEdit.labels).toEqual([{ name: 'work', added: true } as any]);
    expect(editor.applyBackgroundImage).toHaveBeenCalledWith('');
  });

  it('re-attaches image delete buttons and link previews only when it replaced the body markup', () => {
    const { editor, body } = makeEditor();
    spyOn(editor, 'hasUnsavedEdits').and.returnValue(false);

    editor.applyExternalUpdate(remote({ noteBody: 'my unsaved full draft' }));
    expect(editor.hydrateEditorLinkPreviews).not.toHaveBeenCalled();
    expect(editor.hydrateInlineImageButtons).not.toHaveBeenCalled();

    editor.applyExternalUpdate(remote());
    expect(body.nativeElement.innerHTML).toBe('remote body');
    expect(editor.hydrateEditorLinkPreviews).toHaveBeenCalledTimes(1);
    expect(editor.hydrateInlineImageButtons).toHaveBeenCalledTimes(1);
  });

  it('saves against the editor\'s own base only while a newer version is being held back', () => {
    const { editor } = makeEditor();
    editor.saveBaselineSnapshot = JSON.stringify({ noteTitle: 'the title I started from' });

    expect(editor.editBaseForSave()).toBeUndefined();
    editor.externalUpdatePending = true;
    expect(editor.editBaseForSave()).toEqual({ revision: 7, fields: { noteTitle: 'the title I started from' } });
  });

  describe('when the list changes while the note is open', () => {
    const snapshotOf = (note: NoteI) => JSON.stringify({ title: note.noteTitle, body: note.noteBody });
    function openEditor() {
      const made = makeEditor();
      made.editor.noteSaveSnapshot = snapshotOf;
      made.editor.saveBaselineSnapshot = snapshotOf({ noteTitle: 'title', noteBody: 'body' } as NoteI);
      made.editor.auth.currentUser = { id: 1 };
      spyOn(made.editor, 'applyExternalUpdate');
      return made.editor;
    }

    it('adopts a version written by the same user on another device', () => {
      const editor = openEditor();
      const fromPhone = remote({ noteTitle: 'title', noteBody: 'edited on the phone', lastEditorUserId: 1 });

      editor.onNoteListChanged(fromPhone);

      expect(editor.applyExternalUpdate).toHaveBeenCalledOnceWith(fromPhone);
    });

    it('ignores the echo of the editor\'s own save while it is in flight', () => {
      const editor = openEditor();
      editor.inFlightSaveSnapshot = snapshotOf({ noteTitle: 'title', noteBody: 'typed here' } as NoteI);
      editor.externalUpdatePending = false;

      editor.onNoteListChanged(remote({ noteTitle: 'title', noteBody: 'typed here', lastEditorUserId: 1 }));

      expect(editor.applyExternalUpdate).not.toHaveBeenCalled();
      expect(editor.externalUpdatePending).toBeFalse();
    });

    it('forgets a held-back version once the list matches what the editor derives from', () => {
      const editor = openEditor();
      editor.externalUpdatePending = true;

      editor.onNoteListChanged(remote({ noteTitle: 'title', noteBody: 'body' }));

      expect(editor.externalUpdatePending).toBeFalse();
      expect(editor.applyExternalUpdate).not.toHaveBeenCalled();
    });

    it('never treats a truncated card preview as a newer version', () => {
      const editor = openEditor();

      editor.onNoteListChanged(remote({ noteBody: 'truncated…', isCardPreview: true }));

      expect(editor.applyExternalUpdate).not.toHaveBeenCalled();
    });
  });
});

describe('InputComponent list editing and keyboard handling', () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });
  afterEach(() => host.remove());

  function editorWith(html: string) {
    const body = document.createElement('div');
    body.contentEditable = 'true';
    body.innerHTML = html;
    const title = document.createElement('div');
    title.contentEditable = 'true';
    title.textContent = 'a title';
    host.append(title, body);
    const editor = Object.create(InputComponent.prototype) as any;
    Object.assign(editor, { noteBody: { nativeElement: body }, noteTitle: { nativeElement: title } });
    return { editor, body, title };
  }

  function select(start: Node, startOffset: number, end: Node = start, endOffset = startOffset) {
    const range = document.createRange();
    range.setStart(start, startOffset);
    range.setEnd(end, endOffset);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  const keyEvent = (extra: Partial<KeyboardEvent> = {}) => ({ key: 'Tab', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault: jasmine.createSpy('preventDefault'), ...extra }) as unknown as KeyboardEvent;

  it('only treats a selection inside the body as being in the body', () => {
    const { editor, body, title } = editorWith('<p>text</p>');

    select(title.firstChild!, 2);
    expect(editor.selectionInBody()).toBeFalse();
    select(body.querySelector('p')!.firstChild!, 2);
    expect(editor.selectionInBody()).toBeTrue();
  });

  it('measures the depth of every list item a selection touches, for both list shapes', () => {
    // Chrome writes a nested list beside the item, other shapes put it inside it; the depth is the same.
    const { editor, body } = editorWith('<ul><li>a</li><ul><li>b</li></ul><li>c<ul><li>d</li></ul></li></ul>');
    const items = body.querySelectorAll('li');

    select(items[0].firstChild!, 0, items[3].firstChild!, 1);

    expect(editor.selectedBodyListDepths()).toEqual([1, 2, 1, 2]);
  });

  it('does not indent past four levels when a later line of the selection is already that deep', () => {
    const { editor, body } = editorWith('<ul><li>top</li><ul><ul><ul><li>deep</li></ul></ul></ul></ul>');
    const items = body.querySelectorAll('li');
    select(items[0].firstChild!, 0, items[1].firstChild!, 2);
    const execCommand = spyOn(document, 'execCommand');

    editor.indentBodyList(1);

    expect(execCommand).not.toHaveBeenCalled();
  });

  it('lets Tab leave the editor at the deepest list level instead of trapping it, and still indents above it', () => {
    const { editor, body } = editorWith('<ul><li id="shallow">one</li><ul><ul><ul><li id="deep">four</li></ul></ul></ul></ul>');
    spyOn(editor, 'indentBodyList');
    spyOn(editor, 'scheduleTextHistoryRefresh');

    select(body.querySelector('#deep')!.firstChild!, 1);
    const atMaximum = keyEvent();
    editor.onNoteBodyKeyDown(atMaximum);
    expect(atMaximum.preventDefault).not.toHaveBeenCalled();

    select(body.querySelector('#shallow')!.firstChild!, 1);
    const indentable = keyEvent();
    editor.onNoteBodyKeyDown(indentable);
    expect(indentable.preventDefault).toHaveBeenCalled();
    expect(editor.indentBodyList).toHaveBeenCalledWith(1);
  });

  it('ignores Enter and Tab pressed while an input method is composing in a checklist row', () => {
    const { editor } = editorWith('');
    const composing = keyEvent({ key: 'Enter', isComposing: true });
    const candidate = keyEvent({ key: 'Enter', keyCode: 229 });

    editor.cBoxKeyDown(composing, 1);
    editor.cBoxKeyDown(candidate, 1);

    expect(composing.preventDefault).not.toHaveBeenCalled();
    expect(candidate.preventDefault).not.toHaveBeenCalled();
  });

  it('turns every line of a multi-line paste inside a bullet into its own bullet, skipping blank lines', () => {
    const { editor, body } = editorWith('<ul><li>one</li></ul>');
    select(body.querySelector('li')!.firstChild!, 3);

    editor.insertPlainTextAtCursor(body, 'A\nB\n\nC');

    expect(Array.from(body.querySelectorAll('li')).map(item => item.textContent)).toEqual(['oneA', 'B', 'C']);
    expect(body.querySelectorAll('br').length).toBe(0);
  });

  it('still pastes multi-line text outside a list with line breaks', () => {
    const { editor, body } = editorWith('<div>start</div>');
    select(body.querySelector('div')!.firstChild!, 5);

    editor.insertPlainTextAtCursor(body, 'A\nB');

    expect(body.querySelectorAll('li').length).toBe(0);
    expect(body.querySelectorAll('br').length).toBe(1);
  });
});

describe('InputComponent formatting bars', () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });
  afterEach(() => host.remove());

  function editorWithText() {
    const noteMain = document.createElement('div');
    noteMain.style.cssText = 'position:relative;height:500px;padding-top:140px;width:600px';
    const title = document.createElement('div');
    title.contentEditable = 'true';
    const body = document.createElement('div');
    body.contentEditable = 'true';
    body.style.cssText = 'font:16px/24px sans-serif';
    body.innerHTML = '<div>first line of text</div><div>second line of text</div><div>third line of text</div>';
    noteMain.append(title, body);
    host.append(noteMain);
    const toolbar = document.createElement('div');
    toolbar.className = 'text-format-toolbar';
    const trigger = document.createElement('button');
    trigger.className = 'text-format-trigger';
    host.append(toolbar, trigger);
    const editor = Object.create(InputComponent.prototype) as any;
    Object.assign(editor, {
      noteMain: { nativeElement: noteMain }, noteTitle: { nativeElement: title }, noteBody: { nativeElement: body },
      isCbox: { value: false }, isDrawingNote: false, destroyed: false, showTextFormatting: false, showSelectionFormatting: false,
      pointerSelecting: false, shouldUseMobileFormattingBar: () => false, canFormatText: () => true
    });
    return { editor, body, noteMain, toolbar, trigger, outside: noteMain };
  }

  const mouseDown = (target: Element, button = 0) => ({ target, button }) as unknown as MouseEvent;

  describe('the bar opened with the A button', () => {
    it('closes on a click outside it, but not on the bar or on its A buttons', () => {
      const { editor, toolbar, trigger, body } = editorWithText();
      const mobileTrigger = document.createElement('button');
      mobileTrigger.className = 'mobile-icon format';
      host.append(mobileTrigger);

      for (const inside of [toolbar, trigger, mobileTrigger]) {
        editor.showTextFormatting = true;
        editor.onDocumentMouseDown(mouseDown(inside));
        expect(editor.showTextFormatting).withContext(inside.className).toBeTrue();
      }
      editor.onDocumentMouseDown(mouseDown(body));
      expect(editor.showTextFormatting).toBeFalse();
    });

    it('closes on Escape before the note sees it, and leaves Escape alone when it is closed', () => {
      const { editor } = editorWithText();
      const event = { preventDefault: jasmine.createSpy('preventDefault'), stopPropagation: jasmine.createSpy('stopPropagation') } as unknown as Event;

      editor.onEditorEscape(event);
      expect(event.preventDefault).not.toHaveBeenCalled();

      editor.showTextFormatting = true;
      editor.onEditorEscape(event);
      expect(editor.showTextFormatting).toBeFalse();
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
    });
  });

  describe('the floating bar over a selection', () => {
    function selectLines(body: HTMLElement, from: 'top' | 'bottom') {
      const first = body.children[0].firstChild!;
      const last = body.children[1].firstChild!;
      const selection = window.getSelection()!;
      // Dragging from the second line up to the first is a backward selection.
      if (from === 'top') selection.setBaseAndExtent(first, 2, last, 6);
      else selection.setBaseAndExtent(last, 6, first, 2);
    }

    it('is above the first line when the selection is extended downwards', () => {
      const { editor, body, noteMain } = editorWithText();
      selectLines(body, 'top');

      editor.updateSelectionFormatting();

      const firstLine = body.children[0].getBoundingClientRect();
      expect(editor.showSelectionFormatting).toBeTrue();
      expect(parseFloat(editor.selectionFormattingStyle.top)).toBeLessThan(firstLine.top - noteMain.getBoundingClientRect().top);
    });

    it('is below the last line when the selection is extended upwards, so the first line stays reachable', () => {
      const { editor, body, noteMain } = editorWithText();
      selectLines(body, 'bottom');

      editor.updateSelectionFormatting();

      const secondLine = body.children[1].getBoundingClientRect();
      expect(editor.showSelectionFormatting).toBeTrue();
      expect(parseFloat(editor.selectionFormattingStyle.top)).toBeGreaterThanOrEqual(secondLine.bottom - noteMain.getBoundingClientRect().top);
    });

    it('stays hidden while the mouse button is held and appears when it is released', () => {
      const { editor, body } = editorWithText();
      selectLines(body, 'bottom');

      editor.onDocumentMouseDown(mouseDown(body.children[0]));
      editor.updateSelectionFormatting();
      expect(editor.showSelectionFormatting).toBeFalse();

      spyOn(editor, 'scheduleSelectionFormattingUpdate').and.callFake(() => editor.updateSelectionFormatting());
      editor.onDocumentMouseUp();
      expect(editor.showSelectionFormatting).toBeTrue();
    });

    it('is not waiting for a drag that did not start in the text', () => {
      const { editor, toolbar } = editorWithText();
      spyOn(editor, 'scheduleSelectionFormattingUpdate');

      editor.onDocumentMouseDown(mouseDown(toolbar));
      editor.onDocumentMouseUp();

      expect(editor.pointerSelecting).toBeFalse();
      expect(editor.scheduleSelectionFormattingUpdate).not.toHaveBeenCalled();
    });
  });
});
