import { ChangeDetectorRef, NgZone } from '@angular/core';
import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { BehaviorSubject, Subject } from 'rxjs';
import { CheckboxI, NoteI } from '../../interfaces/notes';
import { NotesComponent } from './notes.component';

declare const Snackbar: { show: (options: any) => void };

describe('NotesComponent overview checklist undo', () => {
  let component: NotesComponent;
  let notes: BehaviorSubject<NoteI[]>;
  let service: any;
  let auth: any;
  let shared: any;
  let show: jasmine.Spy;

  const row = (id: number, extra = {}): CheckboxI => ({ id, data: `Item ${id}`, done: false, ...extra });
  const note = (id = 1, checkBoxes = [row(1), row(2), row(3)]): NoteI => ({
    id, syncId: `note-${id}`, noteTitle: 'Checklist', noteBody: '', checkBoxes, isCbox: true,
    pinned: false, bgColor: '', bgImage: '', labels: [], archived: false, trashed: false
  });
  const current = (id = 1) => notes.value.find(item => item.id === id)!;
  const ids = (id = 1) => current(id).checkBoxes!.map(item => item.id);
  const remove = (id: number, noteId = 1) => component.removeOverviewCheckbox(current(noteId), row(id), new Event('mouseup'));
  const undo = (init: KeyboardEventInit = {}) => component.onOverviewUndoKey(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true, ...init }));
  const toastUndo = () => show.calls.allArgs().map(args => args[0]).filter(options => options.actionText === 'Undo').at(-1).onActionClick;
  const publishRows = (checkBoxes: CheckboxI[]) => notes.next([{ ...current(), checkBoxes }]);

  beforeEach(() => {
    notes = new BehaviorSubject([note()]);
    auth = { currentUser$: new BehaviorSubject({ id: 7 }) };
    shared = {
      note: { all: notes.value }, searchQuery: '', searchScope: new BehaviorSubject('all'),
      noteViewType: new BehaviorSubject('grid'), noteEditorOpen$: new BehaviorSubject(false),
      closeSideBar: new Subject(), closeModal: new Subject(), saveNote: new Subject(),
      openSelectedReminder: new Subject(), searchQueryChanged$: new Subject()
    };
    service = {
      notesList$: notes,
      get: jasmine.createSpy('get').and.callFake(async (id: number) => {
        const found = notes.value.find(item => item.id === id);
        if (!found) throw new Error('Note not found');
        return found;
      }),
      fullDocument: jasmine.createSpy('fullDocument').and.callFake(async (value: NoteI) => value),
      updateKey: jasmine.createSpy('updateKey').and.callFake(async (patch: Partial<NoteI>, id: number) => {
        if (!notes.value.some(item => item.id === id)) throw new Error('Note not found');
        notes.next(notes.value.map(item => item.id === id ? { ...item, ...patch } : item));
      })
    };
    component = new NotesComponent(
      shared, { url: '/', events: new Subject() } as any, auth,
      { reminders$: new BehaviorSubject([]) } as any, new NgZone({ enableLongStackTrace: false }),
      service, {} as ChangeDetectorRef, {} as any, {} as any,
      { preferences$: new BehaviorSubject({}) } as any
    );
    spyOn(component, 'scheduleBuildMasonry');
    show = spyOn(Snackbar, 'show');
  });

  afterEach(() => component.ngOnDestroy());

  for (const id of [1, 2, 3]) {
    it(`restores row ${id} in its original position from the toast`, async () => {
      await remove(id);
      expect(ids()).not.toContain(id);
      expect(show).toHaveBeenCalledWith(jasmine.objectContaining({ text: 'Checklist item deleted', actionText: 'Undo', duration: 4200 }));
      await toastUndo()();
      expect(ids()).toEqual([1, 2, 3]);
    });
  }

  it('keeps the complete stored row instead of the normalized preview row', async () => {
    const original = row(2, { data: '<b>Formatted</b> <a href="https://example.test">link</a>', done: true, indentLevel: 2, future: { keep: true } });
    publishRows([row(1), original, row(3, { indentLevel: 1 })]);
    await remove(2); // The event deliberately carries only a minimal preview row.
    await undo({ ctrlKey: false, metaKey: true });
    expect(current().checkBoxes![1]).toEqual(original);
  });

  it('hydrates truncated previews for both deletion and restoration without dropping hidden rows', async () => {
    const full = note(1, Array.from({ length: 25 }, (_, index) => row(index + 1)));
    notes.next([{ ...full, isCardPreview: true, checkBoxes: full.checkBoxes!.slice(0, 3) }]);
    service.fullDocument.and.callFake(async () => full);
    service.updateKey.and.callFake(async ({ checkBoxes }: Partial<NoteI>) => {
      full.checkBoxes = checkBoxes;
      notes.next([{ ...full, isCardPreview: true, checkBoxes: checkBoxes!.slice(0, 3) }]);
    });
    await remove(2);
    expect(full.checkBoxes!.length).toBe(24);
    await undo();
    expect(full.checkBoxes!.map(item => item.id)).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
    expect(service.fullDocument).toHaveBeenCalledTimes(2);
  });

  it('preserves subsequent changes to other rows and restores beside its next neighbor', async () => {
    await remove(2);
    const edited = row(3, { done: true, data: 'Changed later', indentLevel: 1 });
    publishRows([row(9), row(1), edited, row(10)]);
    await undo();
    expect(ids()).toEqual([9, 1, 2, 3, 10]);
    expect(current().checkBoxes![3]).toEqual(edited);
  });

  it('uses the previous neighbor when the next neighbor is gone', async () => {
    await remove(2);
    publishRows([row(9), row(1), row(10)]);
    await undo();
    expect(ids()).toEqual([9, 1, 2, 10]);
  });

  it('clamps the original position when neither neighbor survives', async () => {
    await remove(3);
    publishRows([row(9)]);
    await undo();
    expect(ids()).toEqual([9, 3]);
  });

  it('undoes successive deletions in reverse order across notes', async () => {
    notes.next([note(), note(2)]);
    await remove(1);
    await remove(2);
    await remove(3, 2);
    await undo();
    expect(ids(2)).toEqual([1, 2, 3]);
    expect(ids()).toEqual([3]);
    await undo();
    expect(ids()).toEqual([2, 3]);
    await undo();
    expect(ids()).toEqual([1, 2, 3]);
  });

  it('serializes rapid deletions from the same stale card', async () => {
    const stale = current();
    await Promise.all([
      component.removeOverviewCheckbox(stale, row(1), new Event('mouseup')),
      component.removeOverviewCheckbox(stale, row(2), new Event('mouseup'))
    ]);
    expect(ids()).toEqual([3]);
    await undo();
    await undo();
    expect(ids()).toEqual([1, 2, 3]);
  });

  it('waits for a pending deletion when Undo is pressed immediately', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    const persist = service.updateKey.and.callFake(async ({ checkBoxes }: Partial<NoteI>) => {
      await gate;
      publishRows(checkBoxes!);
    });
    const deleted = remove(2);
    const restored = undo();
    release();
    await Promise.all([deleted, restored]);
    expect(ids()).toEqual([1, 2, 3]);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('restores only once when toast and keyboard undo are activated together', async () => {
    await remove(2);
    const callback = toastUndo();
    await Promise.all([callback(), undo(), callback()]);
    await callback();
    expect(ids()).toEqual([1, 2, 3]);
    expect(service.updateKey).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a row already restored by sync', async () => {
    await remove(2);
    const synced = row(2, { data: 'Newer content' });
    publishRows([row(1), synced, row(3)]);
    await undo();
    expect(current().checkBoxes![1]).toEqual(synced);
    expect(service.updateKey).toHaveBeenCalledTimes(1);
  });

  it('keeps keyboard history after the toast expires', fakeAsync(() => {
    remove(2);
    flushMicrotasks();
    tick(60_000);
    undo();
    flushMicrotasks();
    expect(ids()).toEqual([1, 2, 3]);
  }));

  it('bounds history to the latest 80 deletions', async () => {
    publishRows(Array.from({ length: 81 }, (_, index) => row(index + 1)));
    for (let id = 1; id <= 81; id++) await remove(id);
    for (let count = 0; count < 80; count++) await undo();
    expect(ids()).toEqual(Array.from({ length: 80 }, (_, index) => index + 2));
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true });
    await component.onOverviewUndoKey(event);
    expect(event.defaultPrevented).toBeFalse();
  });

  it('does not record deletion when the complete note cannot be loaded', async () => {
    service.fullDocument.and.rejectWith(new Error('Unavailable'));
    await remove(2);
    await undo();
    expect(service.updateKey).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(jasmine.objectContaining({ text: jasmine.stringMatching("Couldn't load") }));
  });

  it('reports a failed deletion without offering an undo record', async () => {
    service.updateKey.and.rejectWith(new Error('Storage failed'));
    await remove(2);
    await undo();
    expect(service.updateKey).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(jasmine.objectContaining({ text: jasmine.stringMatching("Couldn't delete") }));
  });

  it('retains a failed restoration for retry', async () => {
    await remove(2);
    service.updateKey.and.rejectWith(new Error('Storage failed'));
    await undo();
    expect(ids()).toEqual([1, 3]);
    expect(show).toHaveBeenCalledWith(jasmine.objectContaining({ text: jasmine.stringMatching("Couldn't restore") }));
    service.updateKey.and.callFake(async ({ checkBoxes }: Partial<NoteI>) => publishRows(checkBoxes!));
    await undo();
    expect(ids()).toEqual([1, 2, 3]);
  });

  it('does not recreate a missing or inaccessible note', async () => {
    await remove(2);
    const callback = toastUndo();
    notes.next([]);
    await callback();
    expect(service.get).toHaveBeenCalledWith(1, { merge: false });
    expect(service.updateKey).toHaveBeenCalledTimes(1);
    expect(notes.value).toEqual([]);
    expect(show).toHaveBeenCalledWith(jasmine.objectContaining({ text: jasmine.stringMatching("Couldn't restore") }));
  });

  it('resolves a locally created note after sync changes its numeric ID', async () => {
    notes.next([note(-20)]);
    await remove(2, -20);
    notes.next([{ ...notes.value[0], id: 42 }]);
    await undo();
    expect(ids(42)).toEqual([1, 2, 3]);
    expect(service.updateKey.calls.mostRecent().args[1]).toBe(42);
  });

  it('does not add hidden checklist rows after a note is converted to text', async () => {
    await remove(2);
    notes.next([{ ...current(), isCbox: false, noteBody: 'Converted', checkBoxes: [] }]);
    await undo();
    expect(service.updateKey).toHaveBeenCalledTimes(1);
    expect(current().noteBody).toBe('Converted');
  });

  it('ignores shortcuts when there is no deletion history', () => {
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true });
    component.onOverviewUndoKey(event);
    expect(event.defaultPrevented).toBeFalse();
  });

  for (const init of [
    { ctrlKey: false }, { key: 'y' }, { shiftKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }
  ]) {
    it(`leaves other keyboard commands untouched: ${JSON.stringify(init)}`, async () => {
      await remove(2);
      const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true, ...init });
      await component.onOverviewUndoKey(event);
      expect(event.defaultPrevented).toBeFalse();
      expect(ids()).toEqual([1, 3]);
    });
  }

  it('respects an already handled shortcut', async () => {
    await remove(2);
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true });
    event.preventDefault();
    await component.onOverviewUndoKey(event);
    expect(ids()).toEqual([1, 3]);
  });

  it('leaves editor undo alone and prevents a stale toast from modifying an open editor', async () => {
    await remove(2);
    component.editorOpen = true;
    await undo();
    await toastUndo()();
    expect(ids()).toEqual([1, 3]);
    component.editorOpen = false;
    await undo();
    expect(ids()).toEqual([1, 2, 3]);
  });

  for (const tag of ['input', 'textarea', 'select', 'div']) {
    it(`preserves native text undo in ${tag === 'div' ? 'contenteditable' : tag}`, async () => {
      await remove(2);
      const field = document.createElement(tag);
      if (tag === 'div') field.contentEditable = 'true';
      document.body.appendChild(field);
      field.focus();
      try {
        await undo();
        expect(ids()).toEqual([1, 3]);
      } finally { field.remove(); }
    });
  }

  it('leaves shortcuts alone while another dialog is visible', async () => {
    await remove(2);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.textContent = 'Reminder dialog';
    document.body.appendChild(dialog);
    try {
      await undo();
      expect(ids()).toEqual([1, 3]);
    } finally { dialog.remove(); }
  });

  it('ignores the synthetic mouse event following a touch deletion', async () => {
    const stale = current();
    await component.removeOverviewCheckbox(stale, row(2), new Event('touchend'));
    await component.removeOverviewCheckbox(stale, row(2), new Event('mouseup'));
    expect(service.updateKey).toHaveBeenCalledTimes(1);
    await undo();
    expect(ids()).toEqual([1, 2, 3]);
  });

  function initializeLifecycle() {
    for (const method of ['syncCurrentPage', 'registerPullToRefresh', 'registerWidgetOpenHandlers']) spyOn<any>(component, method);
    component.ngOnInit();
  }

  it('clears undo history when the signed-in profile changes', async () => {
    initializeLifecycle();
    await remove(2);
    const callback = toastUndo();
    auth.currentUser$.next({ id: 8 });
    await callback();
    await undo();
    expect(service.updateKey).toHaveBeenCalledTimes(1);
  });

  it('retains history for ordinary updates to the same signed-in profile', async () => {
    initializeLifecycle();
    await remove(2);
    auth.currentUser$.next({ id: 7, theme: 'dark' });
    await undo();
    expect(ids()).toEqual([1, 2, 3]);
  });

  it('does not execute queued deletion or toast callbacks after destruction', async () => {
    await remove(2);
    const callback = toastUndo();
    const queued = remove(3);
    component.ngOnDestroy();
    await queued;
    await callback();
    expect(service.updateKey).toHaveBeenCalledTimes(1);
  });
});
