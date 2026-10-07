import { ChangeDetectorRef, ElementRef, NgZone } from '@angular/core';
import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { BehaviorSubject, Subject } from 'rxjs';
import { NoteI } from '../../interfaces/notes';
import { NotesComponent } from './notes.component';

describe('NotesComponent responsiveness', () => {
  let component: NotesComponent;
  let shared: any;
  let notesService: any;
  let zone: NgZone;
  let modalContainer: HTMLDivElement;
  const preview: NoteI = {
    id: 1, noteTitle: 'A note', noteBody: 'Truncated preview', isCardPreview: true,
    pinned: false, bgColor: '', bgImage: '', isCbox: false, labels: [], archived: false, trashed: false
  };

  beforeEach(() => {
    shared = {
      note: { all: [preview], id: 0 },
      noteViewType: new BehaviorSubject('grid'),
      searchScope: new BehaviorSubject('all'),
      searchQuery: '', selectedNoteIds: new BehaviorSubject([]), saveNote: new Subject(),
    };
    notesService = { hasMoreNotes: false, get: jasmine.createSpy('get') };
    zone = new NgZone({ enableLongStackTrace: false });
    component = new NotesComponent(
      shared, {} as any, {} as any, {} as any, zone, notesService,
      { detectChanges: () => {} } as ChangeDetectorRef, {} as any,
      { ensureUnlocked: () => Promise.resolve(true) } as any, {} as any
    );
    modalContainer = document.createElement('div');
    component.modalContainer = new ElementRef(modalContainer);
    component.modal = new ElementRef(document.createElement('div'));
    spyOn<any>(component, 'prepareModalOpenAnimation');
    spyOn<any>(component, 'prepareModalCloseAnimation');
    spyOn<any>(component, 'positionModalAtRest');
    spyOn<any>(component, 'schedulePostModalPaginationCheck');
    spyOn<any>(component, 'scheduleIPadMasonrySettle');
  });

  afterEach(() => {
    document.removeEventListener('mousedown', component.mouseDownEvent);
  });

  it('acknowledges opening a card before its full note arrives', fakeAsync(() => {
    let resolve!: (note: NoteI) => void;
    notesService.get.and.returnValue(new Promise<NoteI>(r => resolve = r));
    component.openModal(null, preview);
    flushMicrotasks();
    expect(modalContainer.style.display).toBe('block');
    expect(component.editorLoading).toBeTrue();
    const fullNote = { ...preview, noteBody: 'The complete note', isCardPreview: false };
    resolve(fullNote);
    flushMicrotasks();
    expect(component.editorLoading).toBeFalse();
    expect(component.clickedNoteData).toBe(fullNote);
    component.closeModal();
    tick(250);
  }));

  it('ignores a full-note response after cancelling the editor', fakeAsync(() => {
    let resolve!: (note: NoteI) => void;
    notesService.get.and.returnValue(new Promise<NoteI>(r => resolve = r));
    component.openModal(null, preview);
    flushMicrotasks();
    component.onEscapeKey(new KeyboardEvent('keydown', { key: 'Escape' }));
    tick(250);
    resolve({ ...preview, noteBody: 'Late response', isCardPreview: false });
    flushMicrotasks();
    expect(modalContainer.style.display).toBe('none');
    expect(component.clickedNoteData).toBe(preview);
    expect(component.editorLoading).toBeFalse();
  }));

  it('does not open a truncated card for editing when hydration fails', fakeAsync(() => {
    notesService.get.and.returnValue(Promise.reject(new Error('Network unavailable')));
    component.openModal(null, preview);
    flushMicrotasks();
    expect(component.editorLoading).toBeFalse();
    expect(component.editorLoadError).toContain('Could not open');
    const save = spyOn(shared.saveNote, 'next');
    component.onEscapeKey(new KeyboardEvent('keydown', { key: 'Escape' }));
    tick(250);
    expect(save).not.toHaveBeenCalled();
    expect(modalContainer.style.display).toBe('none');
  }));

  it('stops increasing the render window once all loaded notes are visible', () => {
    component.visibleNoteLimit = shared.note.all.length;
    const layout = spyOn(component, 'scheduleBuildMasonry');
    component.increaseVisibleNoteLimit();
    expect(component.visibleNoteLimit).toBe(shared.note.all.length);
    expect(layout).not.toHaveBeenCalled();
  });

  it('returns a bounded variable-height list window for a large loaded collection', () => {
    const root = document.createElement('div');
    const group = document.createElement('div');
    group.className = 'notes-layout';
    group.dataset['listGroup'] = 'unpinned';
    root.appendChild(group);
    component.mainContainer = new ElementRef(root);
    shared.noteViewType.next('list');
    const notes = Array.from({ length: 10_000 }, (_, index) => ({
      ...preview,
      id: index + 1,
      syncId: `note-${index + 1}`
    }));

    const window = component.noteListWindow(notes, 'unpinned');

    expect(window.notes.length).toBeLessThan(40);
    expect(window.start).toBeLessThan(10_000);
    expect(window.topSpacer + window.bottomSpacer).toBeGreaterThan(0);
  });

  it('does not read layout dimensions when checking an unchanged masonry signature', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { get: () => { throw new Error('Forced layout read'); } });
    component.mainContainer = new ElementRef(container);
    (component as any).lastMasonrySignature = (component as any).masonrySignature();
    expect(() => component.scheduleBuildMasonry()).not.toThrow();
  });

  it('coalesces repeated bottom-scroll callbacks while an expansion is pending', fakeAsync(() => {
    shared.note.all = Array.from({ length: 1000 }, (_, index) => ({
      ...preview,
      id: index + 1,
      syncId: `note-${index + 1}`
    }));
    component.visibleNoteLimit = 24;
    const root = document.documentElement;
    const descriptor = Object.getOwnPropertyDescriptor(root, 'scrollHeight');
    Object.defineProperty(root, 'scrollHeight', { configurable: true, value: 500 });
    spyOn(component, 'scheduleBuildMasonry');

    try {
      component.onWindowScroll();
      component.onWindowScroll();
      expect(component.visibleNoteLimit).toBe(24 + 80);
      tick(1000);
      expect((component as any).scrollExpansionPending).toBeFalse();
    } finally {
      if (descriptor) Object.defineProperty(root, 'scrollHeight', descriptor);
      else delete (root as any).scrollHeight;
    }
  }));

});
