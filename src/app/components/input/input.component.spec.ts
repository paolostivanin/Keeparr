import { InputComponent } from './input.component';
import { NoteI } from 'src/app/interfaces/notes';
import { ChecklistHistory } from 'src/app/utils/checklist-model';
import { EditorSessionTracker, emptyEditorDraft } from 'src/app/utils/editor-session';

function makeEditor() {
  const editor = Object.create(InputComponent.prototype) as any;
  const title = { nativeElement: { innerHTML: 'my title' } };
  const body = { nativeElement: { innerHTML: 'my unsaved full draft' } };
  Object.assign(editor, {
    noteTitle: title, noteBody: body, noteMain: { nativeElement: { style: {} } }, notePin: { nativeElement: { dataset: {} } },
    labels: [{ name: 'work', added: false }, { name: 'home', added: true }], isArchived: false, isTrashed: false, binderName: '',
    applyNoteSurface: jasmine.createSpy('applyNoteSurface'), noteColor: '', noteBgImage: '',
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
    expect(editor.noteBgImage).toBe('');
    expect(editor.applyNoteSurface).toHaveBeenCalled();
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

describe('InputComponent checklist paste', () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });
  afterEach(() => host.remove());

  function checklistEditor() {
    const row = document.createElement('div');
    row.contentEditable = 'true';
    row.textContent = 'headtail';
    host.append(row);
    const editor = Object.create(InputComponent.prototype) as any;
    Object.assign(editor, {
      checkBoxes: [{ id: 1, done: false, data: 'headtail', indentLevel: 1 }, { id: 2, done: false, data: 'next', indentLevel: 0 }],
      cboxSuggestionEligibleIds: new Set<number>(), inputLength: { value: { title: 0, body: 0, cb: 0 }, next: () => undefined },
      cboxPh: { nativeElement: document.createElement('div') }, cd: { detectChanges: () => undefined },
      syncCboxDomIntoModel: () => undefined, pushCboxHistorySnapshot: jasmine.createSpy('pushCboxHistorySnapshot'),
      queueCoEditAutosave: () => undefined, onCboxInput: () => undefined
    });
    return { editor, row };
  }

  const pasteEvent = (text: string, currentTarget?: HTMLElement) => ({
    clipboardData: { getData: () => text }, currentTarget, preventDefault: jasmine.createSpy('preventDefault')
  }) as unknown as ClipboardEvent;

  it('adds one row per pasted line after the row at its indent and keeps the text behind the caret on the last one', () => {
    const { editor, row } = checklistEditor();
    const range = document.createRange();
    range.setStart(row.firstChild!, 4);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const event = pasteEvent('A < B\r\n\r\nC\nD', row);

    editor.onCboxPaste(event, 1);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(row.textContent).toBe('headA < B');
    expect(editor.checkBoxes.map((cb: any) => cb.data)).toEqual(['headtail', 'C', 'Dtail', 'next']);
    expect(editor.checkBoxes.map((cb: any) => cb.id)).toEqual([1, 3, 4, 2]);
    expect(editor.checkBoxes.map((cb: any) => cb.indentLevel)).toEqual([1, 1, 1, 0]);
    expect(editor.pushCboxHistorySnapshot).toHaveBeenCalledTimes(1);
  });

  it('escapes pasted markup', () => {
    const { editor, row } = checklistEditor();
    editor.onCboxPaste(pasteEvent('one\n<b>two</b>', row), 1);
    expect(editor.checkBoxes[1].data).toBe('&lt;b&gt;two&lt;/b&gt;');
  });

  it('inserts a single pasted line as plain text instead of leaving the clipboard markup to the browser (W16)', () => {
    const { editor, row } = checklistEditor();
    row.focus();
    const range = document.createRange();
    range.setStart(row.firstChild!, 4);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const event = pasteEvent('<b>x</b> line\n', row);

    editor.onCboxPaste(event, 1);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(row.textContent).toBe('head<b>x</b> linetail');
    expect(row.querySelector('b')).toBeNull();
    expect(editor.checkBoxes.length).toBe(2);
  });

  it('appends one row per line when pasting into the empty "List item" row', () => {
    const { editor } = checklistEditor();
    const event = pasteEvent('x\ny\nz');

    editor.onCboxPhPaste(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(editor.checkBoxes.map((cb: any) => cb.data)).toEqual(['headtail', 'next', 'x', 'y', 'z']);
    expect(editor.pushCboxHistorySnapshot).toHaveBeenCalledTimes(1);
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

describe('InputComponent note surface', () => {
  let noteMain: HTMLElement;
  beforeEach(() => document.body.classList.remove('light-theme'));
  afterEach(() => { noteMain?.remove(); document.body.classList.remove('light-theme'); });

  function surfaceEditor() {
    noteMain = document.createElement('div');
    noteMain.className = 'note-main note-surface';
    noteMain.style.backgroundColor = 'var(--note-bg-eff, rgb(1, 2, 3))';
    document.body.appendChild(noteMain);
    const editor = Object.create(InputComponent.prototype) as any;
    Object.assign(editor, {
      noteMain: { nativeElement: noteMain }, noteTitle: { nativeElement: { innerHTML: '' } }, notePin: { nativeElement: { dataset: {} } },
      noteColor: '', noteBgImage: '', images: [], labels: [], isCbox: { value: false }, isEditing: false,
      currentCheckBoxesForSave: () => [], auth: { canonicalImageUrl: (value: string) => value }
    });
    return editor;
  }
  const shown = () => getComputedStyle(noteMain).backgroundColor;

  it('shows the dark variant under the dark theme and the stored color under the light theme, without a re-render', () => {
    const editor = surfaceEditor();
    editor.noteColor = '#fff8b8';
    editor.applyNoteSurface();

    expect(shown()).toBe('rgb(124, 74, 3)');
    document.body.classList.add('light-theme');
    expect(shown()).toBe('rgb(255, 248, 184)');
    document.body.classList.remove('light-theme');
    expect(shown()).toBe('rgb(124, 74, 3)');
  });

  it('never saves a dark variant, whichever theme is active', () => {
    const editor = surfaceEditor();
    editor.noteColor = '#fff8b8';
    editor.applyNoteSurface();

    expect(editor.liveEditorNote().bgColor).toBe('#fff8b8');
    document.body.classList.add('light-theme');
    expect(editor.liveEditorNote().bgColor).toBe('#fff8b8');
    expect(noteMain.style.backgroundColor).toContain('var(');
  });

  it('keeps the stored background image and uses the text color of the active theme over it', () => {
    const editor = surfaceEditor();
    editor.noteBgImage = 'url(/assets/images/backgrounds/groceries.svg)';
    editor.applyNoteSurface();

    expect(editor.hasBackgroundImage).toBeTrue();
    expect(editor.liveEditorNote().bgImage).toBe('url(/assets/images/backgrounds/groceries.svg)');
    expect(noteMain.style.getPropertyValue('--note-bg-image-dark')).toBe('url("/assets/images/backgrounds/groceries_dark.svg")');
    expect(getComputedStyle(noteMain).getPropertyValue('--note-fg-eff')).toBe('#e8eaed');
    document.body.classList.add('light-theme');
    expect(getComputedStyle(noteMain).getPropertyValue('--note-fg-eff')).toBe('#202124');
  });

  it('removes the color variables when the color is cleared', () => {
    const editor = surfaceEditor();
    editor.noteColor = '#fff8b8';
    editor.applyNoteSurface();
    editor.noteColor = '';
    editor.applyNoteSurface();

    expect(noteMain.style.getPropertyValue('--note-bg')).toBe('');
    expect(shown()).toBe('rgb(1, 2, 3)');
  });
});

describe('InputComponent opening, closing and incoming versions', () => {
  function stubs(extra: Record<string, unknown> = {}) {
    const editor = Object.create(InputComponent.prototype) as any;
    const closeModal = { next: jasmine.createSpy('closeModal') };
    Object.assign(editor, {
      notePin: { nativeElement: { dataset: { pinned: 'false' } } }, noteMain: { nativeElement: document.createElement('div') },
      noteColor: '', noteBgImage: '', images: [], attachments: [], pendingAttachmentFiles: [], labels: [], labelsDirty: false,
      isArchived: false, isTrashed: false, binderName: '', isCbox: { value: false, next: () => undefined },
      selectedCollaboratorIds: [], pendingReminderDate: null, pendingReminderLocation: null, drawingDirty: false,
      auth: { canonicalImageUrl: (value: string) => value, canonicalImageHtml: (value: string) => value, authenticatedImageUrl: (value: string) => value },
      Shared: { closeModal }, endEditorSession: jasmine.createSpy('endEditorSession'),
      notesService: { update: jasmine.createSpy('update').and.resolveTo(), editorSessions: () => undefined },
      currentCheckBoxesForSave: () => [], cboxInput: undefined, cboxPh: undefined,
      autosavesInFlight: new Set(), createInFlight: undefined,
      ...extra
    });
    return { editor, closeModal };
  }

  it('keeps the title and body of a drawing note, and a drawing opened and closed untouched writes nothing (W1)', async () => {
    const drawing = { id: 'drawing', dataUrl: 'data:image/png;base64,AAAA', name: 'Drawing|bg:none', placement: 'top' as const };
    const note = { id: 5, syncId: 'n5', revision: 3, noteTitle: 'Sketch of the plan', noteBody: '<div>notes beside it</div>', pinned: false, bgColor: '', bgImage: '', isCbox: false, checkBoxes: [], images: [drawing], labels: [], binder: '', archived: false, trashed: false } as NoteI;
    const hiddenStandIn = document.createElement('div');
    hiddenStandIn.hidden = true;
    const { editor, closeModal } = stubs({ isEditing: true, isDrawingNote: true, noteToEdit: note, images: [drawing], noteTitle: { nativeElement: hiddenStandIn }, noteBody: undefined });
    editor.saveBaselineSnapshot = editor.noteSaveSnapshot(note);
    spyOn(editor, 'syncDrawingImage');

    expect(editor.editorTitleHtml()).toBe('Sketch of the plan');
    expect(editor.editorBodyHtml()).toBe('<div>notes beside it</div>');
    expect(editor.liveEditorNote().noteTitle).toBe('Sketch of the plan');

    await editor.saveNote();

    expect(editor.syncDrawingImage).not.toHaveBeenCalled();
    expect(editor.notesService.update).not.toHaveBeenCalled();
    expect(closeModal.next).toHaveBeenCalledWith(true);
  });

  it('encodes a drawing only when it changed or was never encoded', () => {
    const { editor } = stubs({ isDrawingNote: true, images: [{ id: 'drawing' }] });
    expect(editor.drawingNeedsEncoding()).toBeFalse();
    editor.drawingDirty = true;
    expect(editor.drawingNeedsEncoding()).toBeTrue();
    editor.drawingDirty = false;
    editor.images = [];
    expect(editor.drawingNeedsEncoding()).toBeTrue();
  });

  it('returns a saved composer to new-note mode so the next save creates another note', async () => {
    const { editor } = stubs({
      isEditing: true, noteToEdit: { id: 5, syncId: 'saved-note' },
      noteTitle: { nativeElement: document.createElement('div') }, noteBody: { nativeElement: document.createElement('div') },
      notePin: { nativeElement: { dataset: {} } }, cboxSuggestionEligibleIds: new Set(), cboxSuggestionDraftValues: new Map(),
      dismissedCboxSuggestionIds: new Set(), resetCboxHistory: () => undefined, clearDrawingSelection: () => undefined,
      drawingHistory: { reset: () => undefined }, isCbox: { next: () => undefined }, inputLength: { next: () => undefined },
      activePointers: new Map(), applyNoteSurface: () => undefined
    });
    spyOn(editor, 'saveNoteNow').and.resolveTo();

    editor.reset();
    await editor.saveNote();

    expect(editor.isEditing).toBeFalse();
    expect(editor.noteToEdit.id).toBeUndefined();
    expect(editor.saveNoteNow).toHaveBeenCalledOnceWith(true);
  });

  it('writes an incoming hybrid version after the templates exist, so closing keeps the body (W2)', () => {
    const body = document.createElement('div');
    const title = document.createElement('div');
    const { editor } = stubs({
      isEditing: true, isDrawingNote: false, noteTitle: { nativeElement: title }, noteBody: undefined,
      noteToEdit: { id: 5, syncId: 'n5', revision: 7, noteTitle: 'title', noteBody: '' },
      checkBoxes: [], cboxDragImage: undefined, resetCboxHistory: () => undefined, normalizeCheckBoxes: (value: unknown) => value,
      decorateLinksForEditor: (value: string) => value, hasMeaningfulBody: (value: string) => !!value,
      hydrateEditorLinkPreviews: () => undefined, hydrateInlineImageButtons: () => undefined,
      updateHtmlWithCursorPreservation: (element: HTMLElement, html: string) => { element.innerHTML = html; },
      noteSaveSnapshot: () => '{}', hasUnsavedEdits: () => false
    });
    // The body element only exists once the hybrid mode has been rendered.
    editor.cd = { detectChanges: () => { editor.noteBody = { nativeElement: body }; } };

    editor.applyExternalUpdate(remote({ isCbox: true, noteBody: '<div>kept</div>', checkBoxes: [{ id: 1, done: false, data: 'a', indentLevel: 0 }] }));

    expect(body.innerHTML).toBe('<div>kept</div>');
    expect(editor.isHybridNote).toBeTrue();
    expect(editor.noteToEdit.noteBody).toBe('<div>kept</div>');
  });

  it('puts an image dropped on a checklist into a body above it and keeps every item (W3)', async () => {
    const insertInlineImage = jasmine.createSpy('insertInlineImage');
    const next = jasmine.createSpy('next');
    const body = { innerHTML: '<div><br></div>' };
    const { editor } = stubs({
      isEditing: false, isHybridNote: false, isCbox: { value: true, next },
      fileToImage: async () => ({ id: 'i', dataUrl: '/x.png', name: 'x', placement: 'bottom' }), insertInlineImage,
      noteBody: undefined, updateInputLength: () => undefined, queueCoEditAutosave: () => undefined,
      cd: { detectChanges: () => { editor.noteBody = { nativeElement: body }; } }
    });

    await editor.addImageFiles([new File(['x'], 'x.png', { type: 'image/png' })]);

    expect(next).not.toHaveBeenCalled();
    expect(editor.isHybridNote).toBeTrue();
    expect(insertInlineImage).toHaveBeenCalledTimes(1);
  });

  it('creates one note when the outside click or Back repeats during a slow create (W13)', async () => {
    let release!: () => void;
    const { editor } = stubs({ isEditing: false });
    const saveNoteNow = spyOn(editor, 'saveNoteNow').and.callFake(() => new Promise<void>(resolve => { release = resolve; }));

    const first = editor.saveNote();
    const second = editor.saveNote();
    const third = editor.saveNote(false);
    expect(saveNoteNow).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    release();
    await first;

    editor.isEditing = false;
    editor.saveNote();
    expect(saveNoteNow).toHaveBeenCalledTimes(2);
  });

  it('closing waits for a pending autosave, so the updates run one after another (W14)', async () => {
    const order: string[] = [];
    let finishAutosave!: () => void;
    const { editor } = stubs({ isEditing: true });
    spyOn(editor, 'saveNoteNow').and.callFake((closeAfterSave: boolean) => {
      if (!closeAfterSave) {
        order.push('autosave:start');
        return new Promise<void>(resolve => { finishAutosave = () => { order.push('autosave:end'); resolve(); }; });
      }
      order.push('close:start');
      return Promise.resolve();
    });

    editor.saveNote(false);
    const closing = editor.saveNote(true);
    await Promise.resolve();
    expect(order).toEqual(['autosave:start']);
    finishAutosave();
    await closing;

    expect(order).toEqual(['autosave:start', 'autosave:end', 'close:start']);
  });

  it('restores a recovered draft without overwriting what was typed before it loaded (W15)', () => {
    const base = emptyEditorDraft();
    const tracker = new EditorSessionTracker('p', 'new', null, () => base);
    const record = { ...tracker.snapshot, draft: { ...base, noteTitle: 'old draft title', noteBody: '<div>old draft body</div>' }, dirtyFields: ['noteTitle', 'noteBody'] as any };
    const loaded: NoteI[] = [];
    const { editor } = stubs({
      isEditing: false, userInputSinceOpen: true, noteTitle: { nativeElement: { innerHTML: 'typed title' } },
      noteBody: { nativeElement: { innerHTML: '' } }, hasMeaningfulBody: () => false,
      loadNoteIntoEditor: (note: NoteI) => loaded.push(note), editorSessionPersister: { put: () => undefined },
      noteSaveSnapshot: () => '{}'
    });

    editor.restoreEditorSession(tracker, record);

    expect(loaded.length).toBe(1);
    expect(loaded[0].noteTitle).toBe('typed title');
    expect(loaded[0].noteBody).toBe('<div>old draft body</div>');
  });

  it('restores everything when nothing was typed meanwhile, and nothing when everything was', () => {
    const base = emptyEditorDraft();
    const tracker = new EditorSessionTracker('p', 'new', null, () => base);
    const record = { ...tracker.snapshot, draft: { ...base, noteTitle: 'draft title' }, dirtyFields: ['noteTitle'] as any };
    const loaded: NoteI[] = [];
    const { editor } = stubs({
      isEditing: false, userInputSinceOpen: false, loadNoteIntoEditor: (note: NoteI) => loaded.push(note),
      editorSessionPersister: { put: () => undefined }, noteSaveSnapshot: () => '{}'
    });
    editor.restoreEditorSession(tracker, record);
    expect(loaded[0].noteTitle).toBe('draft title');

    loaded.length = 0;
    editor.userInputSinceOpen = true;
    editor.noteTitle = { nativeElement: { innerHTML: 'typed' } };
    editor.noteBody = { nativeElement: { innerHTML: '' } };
    editor.hasMeaningfulBody = () => false;
    editor.restoreEditorSession(tracker, record);
    expect(loaded.length).toBe(0);
  });
});

describe('InputComponent checklist rows', () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });
  afterEach(() => { host.remove(); window.getSelection()?.removeAllRanges(); });

  function rowsEditor(rows: Array<{ id: number; data: unknown; done?: boolean; indentLevel?: number }>) {
    const container = document.createElement('div');
    host.append(container);
    const history = new ChecklistHistory();
    const editor = Object.create(InputComponent.prototype) as any;
    const render = () => {
      container.replaceChildren();
      for (const cb of editor.checkBoxes) {
        if (typeof cb.data !== 'string') continue;
        const el = document.createElement('div');
        el.contentEditable = 'true';
        el.dataset['cboxId'] = String(cb.id);
        el.innerHTML = cb.data;
        container.append(el);
      }
    };
    Object.assign(editor, {
      checkBoxes: rows.map(row => ({ done: false, indentLevel: 0, ...row })),
      cboxHistory: history, cboxSuggestionEligibleIds: new Set<number>(), cboxSuggestionDraftValues: new Map<number, string>(),
      dismissedCboxSuggestionIds: new Set<number>(), inputLength: { value: { title: 0, body: 0, cb: 0 }, next: () => undefined },
      preferences: { value: { moveCompletedChecklistItemsToBottom: false } }, noteToEdit: {}, isCbox: { value: true },
      cboxPh: { nativeElement: document.createElement('div') }, queueCoEditAutosave: () => undefined,
      noteContainer: { nativeElement: container }, cd: { detectChanges: render }, completedCboxSuggestions: () => []
    });
    editor.syncCboxDomIntoModel = () => {
      editor.checkBoxes = editor.checkBoxes.map((cb: any) => {
        const el = container.querySelector<HTMLElement>(`[data-cbox-id="${cb.id}"]`);
        return el ? { ...cb, data: el.innerHTML } : cb;
      });
    };
    render();
    history.reset(editor.checkBoxes);
    const rowEl = (id: number) => container.querySelector<HTMLElement>(`[data-cbox-id="${id}"]`)!;
    const caret = (el: Node, offset: number) => {
      const range = document.createRange();
      range.setStart(el, offset);
      range.collapse(true);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    };
    const key = (extra: Partial<KeyboardEvent>) => ({ key: 'Enter', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 13, preventDefault: jasmine.createSpy('preventDefault'), ...extra }) as unknown as KeyboardEvent;
    /** Presses a key in a row: the event targets that row's element. */
    const press = (id: number, init: Partial<KeyboardEvent>) => {
      const event = key({ ...init, target: rowEl(id) } as Partial<KeyboardEvent>);
      editor.cBoxKeyDown(event, id);
      return event;
    };
    return { editor, container, rowEl, caret, key, press, render };
  }

  it('Enter splits the row at the caret and keeps formatting on both sides (P4)', () => {
    const { editor, rowEl, caret, press } = rowsEditor([{ id: 1, data: '<b>hel</b>lo world' }, { id: 2, data: 'next' }]);
    const row = rowEl(1);
    row.focus();
    caret(row.lastChild!, 2);

    const event = press(1, { key: 'Enter' });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(editor.checkBoxes.map((cb: any) => [cb.id, cb.data])).toEqual([[1, '<b>hel</b>lo'], [3, ' world'], [2, 'next']]);
    expect(document.activeElement).toBe(rowEl(3));
  });

  it('Enter at the end of a row adds an empty row and leaves the text alone', () => {
    const { editor, rowEl, caret, press } = rowsEditor([{ id: 1, data: 'milk' }]);
    caret(rowEl(1).firstChild!, 4);
    press(1, { key: 'Enter' });
    expect(editor.checkBoxes.map((cb: any) => cb.data)).toEqual(['milk', '']);
  });

  it('Backspace at the true start merges the row into the previous visible row and puts the caret at the junction (W4)', () => {
    const { editor, rowEl, caret, press } = rowsEditor([{ id: 1, data: 'Milk' }, { id: 2, data: '<b>shake</b>' }]);
    caret(rowEl(2).firstChild!, 0);

    const event = press(2, { key: 'Backspace' });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(editor.checkBoxes.map((cb: any) => cb.data)).toEqual(['Milk<b>shake</b>']);
    const selection = window.getSelection()!;
    const probe = document.createRange();
    probe.setStart(rowEl(1), 0);
    probe.setEnd(selection.anchorNode!, selection.anchorOffset);
    expect(probe.toString()).toBe('Milk');
  });

  it('undo and redo of a row merge retain the merged text (history integration)', () => {
    const { editor, rowEl, caret, press } = rowsEditor([{ id: 1, data: 'Milk' }, { id: 2, data: 'shake' }]);
    caret(rowEl(2).firstChild!, 0);
    press(2, { key: 'Backspace' });
    expect(editor.checkBoxes.map((cb: any) => cb.data)).toEqual(['Milkshake']);

    press(1, { key: 'z', ctrlKey: true });
    expect(editor.checkBoxes.map((cb: any) => [cb.id, cb.data])).toEqual([[1, 'Milk'], [2, 'shake']]);
    press(1, { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(editor.checkBoxes.map((cb: any) => cb.data)).toEqual(['Milkshake']);
  });

  it('structural undo after typing preserves the newly typed row text', () => {
    const { editor, rowEl, caret, press } = rowsEditor([{ id: 1, data: 'milk' }]);
    const row = rowEl(1);
    row.innerHTML = 'milkshake';
    editor.onCboxInput(1, row);
    caret(row.firstChild!, row.textContent!.length);
    press(1, { key: 'Enter' });

    press(1, { key: 'z', ctrlKey: true });
    expect(editor.checkBoxes.map((cb: any) => cb.data)).toEqual(['milkshake']);
  });

  it('Backspace does nothing special inside later text of a row, and not before the start (W4)', () => {
    const { editor, rowEl, caret, press } = rowsEditor([{ id: 1, data: 'a' }, { id: 2, data: '<b>x</b>milk' }]);
    caret(rowEl(2).lastChild!, 0); // after <b>x</b>: offset 0 of a later text node
    const event = press(2, { key: 'Backspace' });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(editor.checkBoxes.length).toBe(2);
  });

  it('Backspace in an empty row deletes it and focuses the end of the previous row (W4)', () => {
    const { editor, rowEl, caret, press } = rowsEditor([{ id: 1, data: 'one' }, { id: 2, data: '' }]);
    caret(rowEl(2), 0);
    press(2, { key: 'Backspace' });
    expect(editor.checkBoxes.map((cb: any) => cb.id)).toEqual([1]);
    expect(document.activeElement).toBe(rowEl(1));
    expect(window.getSelection()!.anchorOffset).toBe(3);
  });

  it('Backspace merges into the previous visible row, not a hidden one in between (W4, A15)', () => {
    const { editor, rowEl, caret, press } = rowsEditor([{ id: 1, data: 'a' }, { id: 2, data: 'hidden', done: true }, { id: 3, data: 'c' }]);
    editor.preferences.value.moveCompletedChecklistItemsToBottom = true;
    // The completed row is in the collapsed section: it is not in the DOM.
    rowEl(2).remove();
    caret(rowEl(3).firstChild!, 0);
    press(3, { key: 'Backspace' });
    expect(editor.checkBoxes.map((cb: any) => [cb.id, cb.data])).toEqual([[1, 'ac'], [2, 'hidden']]);
  });

  it('creates rows from typed text only: Ctrl+V, Enter and Space create nothing in the placeholder (W5)', () => {
    const { editor, key } = rowsEditor([]);
    const addCheckBox = spyOn(editor, 'addCheckBox');
    const paste = key({ key: 'v', ctrlKey: true });
    editor.cboxPhKeyDown(paste);
    expect(paste.preventDefault).not.toHaveBeenCalled();
    const enter = key({ key: 'Enter' });
    editor.cboxPhKeyDown(enter);
    expect(enter.preventDefault).toHaveBeenCalled();
    editor.cboxPh.nativeElement.textContent = ' ';
    editor.cboxPhInput();
    expect(addCheckBox).not.toHaveBeenCalled();
    expect(editor.cboxPh.nativeElement.childNodes.length).toBe(0);
  });

  it('makes a row from typed text, escaped, and waits for an input method to finish composing (W5)', () => {
    const { editor } = rowsEditor([]);
    const addCheckBox = spyOn(editor, 'addCheckBox');
    spyOn(editor, 'focusLastCboxInput');
    editor.cboxPh.nativeElement.textContent = 'ni';
    editor.cboxPhInput({ isComposing: true } as unknown as Event);
    expect(addCheckBox).not.toHaveBeenCalled();
    editor.cboxPh.nativeElement.textContent = 'a < b';
    editor.cboxPhInput();
    expect(addCheckBox).toHaveBeenCalledOnceWith('a &lt; b');
  });

  it('Ctrl+Z restores a deleted row and Ctrl+Shift+Z / Ctrl+Y bring the deletion back (W11)', () => {
    const { editor, press } = rowsEditor([{ id: 1, data: 'a' }, { id: 2, data: 'b' }]);
    editor.checkBoxes = editor.checkBoxes.filter((cb: any) => cb.id !== 2);
    editor.cboxHistory.push(editor.checkBoxes);

    const undo = press(1, { key: 'z', ctrlKey: true });
    expect(undo.preventDefault).toHaveBeenCalled();
    expect(editor.checkBoxes.map((cb: any) => cb.id)).toEqual([1, 2]);

    press(1, { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(editor.checkBoxes.map((cb: any) => cb.id)).toEqual([1]);
    press(1, { key: 'z', metaKey: true });
    press(1, { key: 'y', ctrlKey: true });
    expect(editor.checkBoxes.map((cb: any) => cb.id)).toEqual([1]);
  });

  it('leaves Ctrl+Z to the browser while the latest change is typed text (W11)', () => {
    const { editor, press } = rowsEditor([{ id: 1, data: 'a' }]);
    editor.cboxHistory.textInput();
    const undo = press(1, { key: 'z', ctrlKey: true });
    expect(undo.preventDefault).not.toHaveBeenCalled();
  });

  it('keeps the caret where a mouse press put it, but still moves it to the end on keyboard focus (W17)', async () => {
    const { editor, rowEl, caret } = rowsEditor([{ id: 1, data: 'middle of a row' }]);
    const row = rowEl(1);
    const focusEvent = { target: row } as unknown as FocusEvent;
    editor.rememberTextHistoryTarget = () => undefined;

    row.focus();
    editor.cboxInputMouseDown();
    caret(row.firstChild!, 3);
    editor.cboxInputFocus(focusEvent);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(window.getSelection()!.anchorOffset).toBe(3);

    caret(row.firstChild!, 3);
    editor.cboxInputFocus(focusEvent);
    await new Promise(resolve => setTimeout(resolve, 10));
    const toCaret = document.createRange();
    toCaret.setStart(row, 0);
    toCaret.setEnd(window.getSelection()!.anchorNode!, window.getSelection()!.anchorOffset);
    expect(toCaret.toString().length).toBe('middle of a row'.length);
  });

  it('shows a structured row as a label and never as markup (W18)', () => {
    const { editor } = rowsEditor([]);
    expect(editor.isStructuredRow({ id: 1, done: false, data: { type: 'keeparr-future-item' } })).toBeTrue();
    expect(editor.isStructuredRow({ id: 2, done: false, data: '<b>x</b>' })).toBeFalse();
  });

  it('Show checkboxes keeps an inline image in the body and never makes an item from its delete button (W9)', () => {
    const body = document.createElement('div');
    body.innerHTML = '<div>a</div><div class="inline-note-image-wrap" contenteditable="false"><img class="inline-note-image" src="/api/uploads/images/abc.png" alt="pic">'
      + '<button type="button" data-inline-image-tool="delete"><span class="material-symbols-outlined">close</span></button></div><div><br></div><div>b</div>';
    host.append(body);
    const restored: string[] = [];
    spyOn(window, 'requestAnimationFrame').and.returnValue(0); // the focus-the-new-row frame must not outlive this test
    const { editor } = rowsEditor([]);
    Object.assign(editor, {
      noteBody: { nativeElement: body }, isHybridNote: false, isCbox: { value: false, next: () => undefined },
      auth: { canonicalImageHtml: (value: string) => value }, hasMeaningfulBody: (value: string) => !!value,
      decorateLinksForEditor: (value: string) => value, resetCboxHistory: () => undefined, updateInputLength: () => undefined,
      restoreBodyHtmlAfterTemplateSwap: (html: string) => restored.push(html)
    });

    editor.showCheckboxes();

    expect(editor.checkBoxes.map((cb: any) => cb.data)).toEqual(['a', 'b']);
    expect(editor.isHybridNote).toBeTrue();
    expect(restored.join('')).toContain('inline-note-image-wrap');
    expect(restored.join('')).not.toContain('data-inline-image-tool');
  });

  it('Hide checkboxes puts the kept body back without dead preview cards and decorates it afresh (W10)', () => {
    const body = document.createElement('div');
    body.innerHTML = '<span class="editor-link-preview-slot" contenteditable="false" data-url="https://x.test/" data-original-html="https://x.test/" data-hydrated="true">'
      + '<span class="editor-link-preview-card"><button class="editor-link-preview-remove"></button></span></span>';
    host.append(body);
    const { editor } = rowsEditor([{ id: 1, data: 'item' }]);
    const decorated: string[] = [];
    Object.assign(editor, {
      noteBody: { nativeElement: body }, isHybridNote: true, isCbox: { value: true, next: () => undefined },
      auth: { canonicalImageHtml: (value: string) => value }, decorateLinksForEditor: (html: string) => { decorated.push(html); return 'decorated body'; },
      hydrateEditorLinkPreviews: jasmine.createSpy('hydrateEditorLinkPreviews'), hydrateInlineImageButtons: jasmine.createSpy('hydrateInlineImageButtons'),
      resetCboxHistory: () => undefined, updateInputLength: () => undefined, updateCheckboxMenuLabel: () => undefined,
      placeCaretAtEnd: () => undefined
    });
    spyOn(window, 'confirm').and.returnValue(true);

    editor.hideCheckboxes();

    expect(decorated.length).toBe(1);
    expect(decorated[0]).not.toContain('editor-link-preview-card');
    expect(decorated[0]).toContain('https://x.test/');
    expect(decorated[0]).toContain('<div>item</div>');
    expect(body.innerHTML).toBe('decorated body');
    expect(editor.hydrateEditorLinkPreviews).toHaveBeenCalled();
    expect(editor.hydrateInlineImageButtons).toHaveBeenCalled();
  });
});

describe('InputComponent title and formatting scope', () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });
  afterEach(() => { host.remove(); window.getSelection()?.removeAllRanges(); });

  function textEditor() {
    const title = document.createElement('div');
    title.contentEditable = 'true';
    const body = document.createElement('div');
    body.contentEditable = 'true';
    body.innerHTML = '<div>first</div>';
    const rowContainer = document.createElement('div');
    const row = document.createElement('div');
    row.contentEditable = 'true';
    row.dataset['cboxId'] = '1';
    row.textContent = 'row text';
    rowContainer.append(row);
    host.append(title, body, rowContainer);
    const editor = Object.create(InputComponent.prototype) as any;
    Object.assign(editor, {
      noteTitle: { nativeElement: title }, noteBody: { nativeElement: body }, noteContainer: { nativeElement: host },
      isEditing: false, isDrawingNote: false, isCbox: { value: false }, noteToEdit: {},
      scheduleSelectionFormattingUpdate: () => undefined, updateInputLength: () => undefined, queueCoEditAutosave: () => undefined
    });
    const select = (node: Node, offset = 1, end = offset) => {
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, end);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    };
    const click = () => ({ preventDefault: () => undefined, stopPropagation: () => undefined }) as unknown as Event;
    return { editor, title, body, row, select, click };
  }

  it('applies no formatting command in the title (W7)', () => {
    const { editor, title, select, click } = textEditor();
    title.textContent = 'a title';
    select(title.firstChild!, 0, 3);
    const exec = spyOn(document, 'execCommand');
    for (const command of ['bold', 'italic', 'underline', 'clear', 'h1', 'h2', 'body', 'bullet', 'indent', 'outdent'] as const) editor.applyTextFormat(command, click());
    expect(exec).not.toHaveBeenCalled();
    expect(editor.blockFormatEnabled()).toBeFalse();
  });

  it('blocks Ctrl+B/I/U in the title and moves Enter to the body (W7)', () => {
    const { editor, title, body } = textEditor();
    const event = (init: Partial<KeyboardEvent>) => ({ key: 'b', ctrlKey: true, metaKey: false, altKey: false, isComposing: false, keyCode: 66, preventDefault: jasmine.createSpy('preventDefault'), ...init }) as unknown as KeyboardEvent;
    for (const letter of ['b', 'i', 'u', 'B']) {
      const keyEvent = event({ key: letter });
      editor.onNoteTitleKeyDown(keyEvent);
      expect(keyEvent.preventDefault).toHaveBeenCalled();
    }
    const other = event({ key: 'a' });
    editor.onNoteTitleKeyDown(other);
    expect(other.preventDefault).not.toHaveBeenCalled();

    const enter = event({ key: 'Enter', ctrlKey: false, keyCode: 13 });
    editor.onNoteTitleKeyDown(enter);
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(document.activeElement).toBe(body);
    title.blur();
  });

  it('applies inline commands in the body and in rows, block commands only in the body (W7)', () => {
    const { editor, body, row, select, click } = textEditor();
    const exec = spyOn(document, 'execCommand').and.returnValue(true);

    select(row.firstChild!, 0, 3);
    editor.applyTextFormat('bold', click());
    editor.applyTextFormat('clear', click());
    expect(exec.calls.allArgs().map(args => args[0])).toEqual(['bold', 'removeFormat']);
    expect(editor.blockFormatEnabled()).toBeFalse();
    exec.calls.reset();
    editor.applyTextFormat('h1', click());
    editor.applyTextFormat('bullet', click());
    expect(exec).not.toHaveBeenCalled();

    select(body.querySelector('div')!.firstChild!, 0, 3);
    editor.applyTextFormat('h1', click());
    editor.applyTextFormat('italic', click());
    expect(exec.calls.allArgs().map(args => args[0])).toEqual(['formatBlock', 'italic']);
    expect(editor.blockFormatEnabled()).toBeTrue();
  });

  it('lets the floating bar follow selections in rows but not in the title (W7)', () => {
    const { editor, title, row } = textEditor();
    title.textContent = 'a title';
    const rangeIn = (node: Node) => { const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 3); return range; };
    expect(editor.selectionBelongsToTextEditor(rangeIn(title.firstChild!))).toBeFalse();
    expect(editor.selectionBelongsToTextEditor(rangeIn(row.firstChild!))).toBeTrue();
  });

  it('reads an emptied title (a lone <br>) as empty and keeps an unchanged legacy title as it was (W7)', () => {
    const { editor, title } = textEditor();
    title.innerHTML = '<br>';
    expect(editor.editorTitleHtml()).toBe('');
    editor.isEditing = true;
    editor.noteToEdit = { noteTitle: 'Caff&#232;' };
    title.innerHTML = 'Caff&#232;';
    expect(editor.editorTitleHtml()).toBe('Caff&#232;');
    title.textContent = 'Tom & <Jerry>';
    expect(editor.editorTitleHtml()).toBe('Tom &amp; &lt;Jerry&gt;');
  });

  it('keeps the mobile formatting bar open while the caret moves in the text, and closes it on other taps (W12)', () => {
    const { editor, body, row } = textEditor();
    editor.shouldUseMobileFormattingBar = () => true;
    editor.showTextFormatting = true;
    const tap = (target: Element) => editor.onDocumentMouseDown({ target, button: 0 } as unknown as MouseEvent);
    tap(body);
    expect(editor.showTextFormatting).toBeTrue();
    tap(row);
    expect(editor.showTextFormatting).toBeTrue();
    tap(host);
    expect(editor.showTextFormatting).toBeFalse();
  });

  it('pastes plain text with editing commands, so Ctrl+Z undoes the paste and the caret ends after it (W6)', () => {
    const { editor, body, select } = textEditor();
    body.innerHTML = '<div>start</div>';
    body.focus();
    select(body.querySelector('div')!.firstChild!, 5);

    editor.insertPlainTextAtCursor(body, ' pasted');

    expect(body.textContent).toBe('start pasted');
    expect(window.getSelection()!.anchorNode!.textContent).toContain('pasted');
    expect(window.getSelection()!.anchorOffset).toBe('start pasted'.length);
    document.execCommand('undo');
    expect(body.textContent).toBe('start');
  });

  it('keeps long pastes off the command path (W6)', () => {
    const { editor, body, select } = textEditor();
    body.innerHTML = '<div>x</div>';
    body.focus();
    select(body.querySelector('div')!.firstChild!, 1);
    const exec = spyOn(document, 'execCommand');
    const text = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n');

    editor.insertPlainTextAtCursor(body, text);

    expect(exec).not.toHaveBeenCalled();
    expect(body.querySelectorAll('br').length).toBe(599);
  });

  describe('link preview decoration', () => {
    function decorating(html: string, richLinkPreviews: boolean) {
      const { editor, body } = textEditor();
      body.innerHTML = html;
      Object.assign(editor, {
        destroyed: false, editorPreviewGeneration: 0, preferences: { value: { richLinkPreviews } },
        auth: { canonicalImageHtml: (value: string) => value, authenticatedImageHtml: (value: string) => value },
        hydrateEditorLinkPreviews: jasmine.createSpy('hydrate'), hydrateInlineImageButtons: jasmine.createSpy('buttons')
      });
      const rewrite = spyOn(editor, 'updateHtmlWithCursorPreservation').and.callThrough();
      return { editor, body, rewrite };
    }

    it('does not rewrite the body after a paste when previews are off or no link changed (W6)', () => {
      const off = decorating('<div>plain https://a.test text</div>', false);
      off.editor.decorateCurrentBodyLinks();
      expect(off.rewrite).not.toHaveBeenCalled();

      const on = decorating('<div>no links at all</div>', true);
      on.editor.decorateCurrentBodyLinks();
      expect(on.rewrite).not.toHaveBeenCalled();

      const decorated = decorating('<div><span class="editor-link-preview-slot" data-url="https://a.test" data-original-html="https://a.test"></span></div>', true);
      decorated.editor.decorateCurrentBodyLinks();
      expect(decorated.rewrite).not.toHaveBeenCalled();
    });

    it('decorates a newly pasted URL, keeping the caret handling and the image buttons (W6)', () => {
      const { editor, body, rewrite } = decorating('<div>see https://a.test now</div>', true);
      editor.decorateCurrentBodyLinks();
      expect(rewrite).toHaveBeenCalledTimes(1);
      expect(body.querySelector('.editor-link-preview-slot')).not.toBeNull();
      expect(editor.hydrateInlineImageButtons).toHaveBeenCalled();
    });

    it('removes leftover slots when previews are turned off (W6)', () => {
      const { editor, body, rewrite } = decorating('<div><span class="editor-link-preview-slot" data-url="https://a.test" data-original-html="https://a.test"></span></div>', false);
      editor.decorateCurrentBodyLinks();
      expect(rewrite).toHaveBeenCalledTimes(1);
      expect(body.querySelector('.editor-link-preview-slot')).toBeNull();
      expect(body.textContent).toContain('https://a.test');
    });

    it('can show an existing anchor as text and undo that change', () => {
      const { editor, body } = decorating('<div>placeholder</div>', true);
      const slot = document.createElement('span');
      slot.className = 'editor-link-preview-slot';
      slot.dataset['url'] = 'https://example.test';
      slot.dataset['originalHtml'] = '<a href="https://example.test">link</a>';
      const button = (editor as any).editorPreviewRemoveButton() as HTMLButtonElement;
      slot.append(button);
      body.replaceChildren(slot);
      editor.onNoteBodyInput = () => undefined;
      button.click();

      expect(body.querySelector('a')?.getAttribute('href')).toBe('https://example.test');
      document.execCommand('undo');
      expect(body.querySelector('.editor-link-preview-slot')).not.toBeNull();
    });
  });

  it('removes an inline image through the browser edit stack so Undo restores it', () => {
    const { editor, body } = textEditor();
    body.innerHTML = '<div>before</div><div class="inline-note-image-wrap" contenteditable="false"><img src="/api/uploads/images/a.png"><button data-inline-image-tool="delete">x</button></div><div><br></div><div>after</div>';
    editor.onNoteBodyInput = () => undefined;
    body.focus();
    const button = body.querySelector('[data-inline-image-tool]')!;

    editor.onNoteBodyClick({ target: button, preventDefault: () => undefined, stopPropagation: () => undefined } as unknown as Event);

    expect(body.querySelector('.inline-note-image-wrap')).toBeNull();
    document.execCommand('undo');
    expect(body.querySelector('.inline-note-image-wrap')).not.toBeNull();
  });

  describe('Backspace at the start of a line (contract section 4)', () => {
    const backspace = () => ({ key: 'Backspace', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 8, preventDefault: jasmine.createSpy('preventDefault') }) as unknown as KeyboardEvent;
    function replay(html: string, startAt: (body: HTMLElement) => [Node, number]) {
      const { editor, body, select } = textEditor();
      editor.scheduleTextHistoryRefresh = () => undefined;
      editor.onNoteBodyInput = () => undefined;
      body.innerHTML = html;
      body.focus();
      select(...startAt(body));
      const event = backspace();
      editor.onNoteBodyKeyDown(event);
      return { event, html: body.innerHTML };
    }

    it('removes the bullet of a middle list item and splits the list (fixture backspace-bullet-middle-of-list)', () => {
      const { event, html } = replay('<ul><li>a</li><li>b</li><li>c</li></ul>', body => [body.querySelectorAll('li')[1].firstChild!, 0]);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(html).toBe('<ul><li>a</li></ul><div>b</div><ul><li>c</li></ul>');
    });

    it('turns a heading into a plain line', () => {
      const { event, html } = replay('<div>x</div><h2>a</h2>', body => [body.querySelector('h2')!.firstChild!, 0]);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(html).toBe('<div>x</div><div>a</div>');
    });

    it('removes the bullet of the only item under a plain line without bulleting the line above (fixture backspace-first-bullet-under-plain)', () => {
      const { html } = replay('<div>x</div><ul><li>a</li></ul>', body => [body.querySelector('li')!.firstChild!, 0]);
      expect(html).toBe('<div>x</div><div>a</div>');
    });

    it('drops one quote level at the start of a quote line (fixture backspace-quote-start)', () => {
      const { event, html } = replay('<blockquote><div>a</div></blockquote>', body => [body.querySelector('div')!.firstChild!, 0]);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(html).toBe('<div>a</div>');
    });

    it('a second Backspace merges the plain line into the item above, which the browser does by itself (fixture backspace-second-press-merges)', () => {
      const { event } = replay('<ul><li>a</li></ul><div>b</div>', body => [body.querySelector('div')!.firstChild!, 0]);
      expect(event.preventDefault).not.toHaveBeenCalled();
      document.execCommand('delete');
      const body = host.querySelectorAll<HTMLElement>('[contenteditable]')[1];
      expect(body.innerHTML).toBe('<ul><li>ab</li></ul>');
    });

    it('leaves a plain character delete to the browser', () => {
      const { event } = replay('<ul><li>ab</li></ul>', body => [body.querySelector('li')!.firstChild!, 1]);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });
});

describe('InputComponent text drops', () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });
  afterEach(() => { host.remove(); window.getSelection()?.removeAllRanges(); });

  function drop(target: HTMLElement, data: Record<string, string>, editor: any) {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
    const rect = target.getBoundingClientRect();
    target.addEventListener('drop', event => editor.onTextDrop(event as DragEvent), { once: true });
    const event = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: rect.left + 4, clientY: rect.top + rect.height / 2 });
    target.dispatchEvent(event);
    return event;
  }

  it('inserts dropped html as plain text in the body (W16)', () => {
    const body = document.createElement('div');
    body.contentEditable = 'true';
    body.style.cssText = 'font:16px sans-serif;min-height:40px;width:300px';
    body.textContent = 'text';
    host.append(body);
    const editor = Object.create(InputComponent.prototype) as any;
    Object.assign(editor, { noteBody: { nativeElement: body }, noteTitle: { nativeElement: document.createElement('div') }, queueEditorLinkDecoration: () => undefined });

    const event = drop(body, { 'text/html': '<b style="color:red">bold</b>', 'text/plain': 'bold' }, editor);

    expect(event.defaultPrevented).toBeTrue();
    expect(body.querySelector('b')).toBeNull();
    expect(body.textContent).toContain('bold');
  });

  it('inserts a dropped multi-line text as one line in the title (W16)', () => {
    const title = document.createElement('div');
    title.contentEditable = 'true';
    title.style.cssText = 'font:16px sans-serif;min-height:40px;width:300px';
    host.append(title);
    const editor = Object.create(InputComponent.prototype) as any;
    Object.assign(editor, { noteBody: undefined, noteTitle: { nativeElement: title }, onNoteTitleInput: jasmine.createSpy('onNoteTitleInput') });

    drop(title, { 'text/plain': 'one\ntwo' }, editor);

    expect(title.querySelector('br')).toBeNull();
    expect(title.textContent).toBe('one two');
    expect(editor.onNoteTitleInput).toHaveBeenCalled();
  });

  it('leaves file drops and moved inline images to the editor (W16)', () => {
    const body = document.createElement('div');
    host.append(body);
    const editor = Object.create(InputComponent.prototype) as any;
    Object.assign(editor, { noteBody: { nativeElement: body }, draggedInlineObject: document.createElement('div') });
    const event = drop(body, { 'text/plain': 'x' }, editor);
    expect(event.defaultPrevented).toBeFalse();
  });
});
