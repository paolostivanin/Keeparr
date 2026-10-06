import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoteI } from 'src/app/interfaces/notes';
import { NoteCardControlsComponent } from './note-card-controls.component';

const note: NoteI = {
  id: 12,
  noteTitle: 'Controls fixture',
  pinned: false,
  bgColor: '',
  bgImage: '',
  isCbox: false,
  labels: [],
  archived: false,
  trashed: false
};

describe('NoteCardControlsComponent', () => {
  let fixture: ComponentFixture<NoteCardControlsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ declarations: [NoteCardControlsComponent] }).compileComponents();
    fixture = TestBed.createComponent(NoteCardControlsComponent);
    fixture.componentInstance.note = note;
    fixture.detectChanges();
  });

  it('emits selection without allowing the pointer event to open the editor', () => {
    const selection = jasmine.createSpy('selection');
    const parentClick = jasmine.createSpy('parent click');
    fixture.componentInstance.selectionChanged.subscribe(selection);
    fixture.nativeElement.addEventListener('click', parentClick);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    fixture.nativeElement.querySelector('.check-icon').dispatchEvent(event);
    expect(parentClick).not.toHaveBeenCalled();
    expect(selection).toHaveBeenCalledWith({ note, event });
  });

  it('emits the current pin state for the page owner to persist', () => {
    const pin = jasmine.createSpy('pin');
    fixture.componentInstance.pinChanged.subscribe(pin);
    fixture.nativeElement.querySelector('.pin-icon').click();
    expect(pin).toHaveBeenCalledWith({ noteId: 12, pinned: false });
  });
});
