import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoteI } from 'src/app/interfaces/notes';
import { NoteCardActionsComponent } from './note-card-actions.component';

const note: NoteI = {
  id: 23,
  noteTitle: 'Action fixture',
  pinned: false,
  bgColor: '',
  bgImage: '',
  isCbox: false,
  labels: [],
  archived: false,
  trashed: false
};

describe('NoteCardActionsComponent', () => {
  let fixture: ComponentFixture<NoteCardActionsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ declarations: [NoteCardActionsComponent] }).compileComponents();
    fixture = TestBed.createComponent(NoteCardActionsComponent);
    fixture.componentInstance.note = note;
    fixture.detectChanges();
  });

  it('keeps reminder actions synchronous with the originating gesture', () => {
    const parentClick = jasmine.createSpy('parent click');
    const toggleReminder = jasmine.createSpy('toggle reminder');
    fixture.nativeElement.addEventListener('click', parentClick);
    fixture.componentInstance.toggleReminder.subscribe(toggleReminder);
    const alarm = fixture.nativeElement.querySelector('.alarm') as HTMLElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    alarm.dispatchEvent(event);

    expect(parentClick).not.toHaveBeenCalled();
    expect(toggleReminder).toHaveBeenCalledWith({ note, event });
  });

  it('emits the clicked anchor for shared tooltip positioning', () => {
    const openMenu = jasmine.createSpy('open menu');
    fixture.componentInstance.openMoreMenu.subscribe(openMenu);
    const button = fixture.nativeElement.querySelector('.more') as HTMLDivElement;
    button.click();

    expect(openMenu).toHaveBeenCalledWith({ note, button });
  });

  it('emits a restore action for a trashed note', () => {
    fixture.componentRef.setInput('note', { ...note, trashed: true });
    fixture.detectChanges();
    const restore = jasmine.createSpy('restore');
    fixture.componentInstance.restore.subscribe(restore);
    (fixture.nativeElement.querySelector('.restore') as HTMLElement).click();

    expect(restore).toHaveBeenCalledWith(jasmine.objectContaining({ id: note.id, trashed: true }));
  });
});
