import { Component, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NoteI } from 'src/app/interfaces/notes';
import { AuthService } from 'src/app/services/auth.service';
import { NoteCardPreviewComponent, NotePreviewMeta } from './note-card-preview.component';

const meta: NotePreviewMeta = {
  rawBody: 'Body',
  title: 'Title',
  bgKey: '',
  urls: [],
  linkOnly: false,
  textColor: '#202124',
  displayBody: 'Body',
  bodySegments: [{ type: 'html', value: 'Body' }],
  hiddenLinkCount: 0,
  visibleUrls: []
};

function note(id: number, title: string): NoteI {
  return {
    id,
    noteTitle: title,
    noteBody: 'Body',
    pinned: false,
    bgColor: '',
    bgImage: '',
    isCbox: false,
    labels: [],
    archived: false,
    trashed: false
  };
}

@Component({
  template: `@for (item of notes; track item.id) {
    <app-note-card-preview [note]="item" [meta]="previewMeta" [ownerOnline]="item.ownerOnline === true"></app-note-card-preview>
  }`,
  standalone: false
})
class PreviewHostComponent {
  notes = [note(1, 'First note'), note(2, 'Second note')];
  previewMeta = meta;
}

describe('NoteCardPreviewComponent', () => {
  let fixture: ComponentFixture<PreviewHostComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [NoteCardPreviewComponent, PreviewHostComponent],
      providers: [{ provide: AuthService, useValue: { currentUser: { id: 1 }, authenticatedImageUrl: (value: string) => value } }],
      schemas: [CUSTOM_ELEMENTS_SCHEMA]
    }).compileComponents();
    fixture = TestBed.createComponent(PreviewHostComponent);
    fixture.detectChanges();
  });

  it('skips unchanged card subtrees during an unrelated parent check', () => {
    const cards = fixture.debugElement.queryAll(By.directive(NoteCardPreviewComponent));
    const firstTitle = cards[0].nativeElement.querySelector('.title').textContent.trim();
    fixture.componentInstance.notes[1].noteTitle = 'Mutated without a new card value';
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    expect(cards[0].nativeElement.querySelector('.title').textContent.trim()).toBe(firstTitle);
    expect(cards[1].nativeElement.querySelector('.title').textContent.trim()).toBe('Second note');
  });

  it('updates only the card whose immutable note input changed', () => {
    fixture.componentInstance.notes = [
      fixture.componentInstance.notes[0],
      { ...fixture.componentInstance.notes[1], noteTitle: 'Updated note' }
    ];
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const cards = fixture.debugElement.queryAll(By.directive(NoteCardPreviewComponent));
    expect(cards[1].componentInstance.note.noteTitle).toBe('Updated note');
    expect(cards[0].nativeElement.querySelector('.title').textContent.trim()).toBe('First note');
    expect(cards[1].nativeElement.querySelector('.title').textContent.trim()).toBe('Updated note');
  });

  it('emits the complete note when its preview is opened', () => {
    const card = fixture.debugElement.queryAll(By.directive(NoteCardPreviewComponent))[0];
    const open = jasmine.createSpy('open');
    card.componentInstance.open.subscribe(open);
    card.nativeElement.querySelector('.note-preview-open').click();
    expect(open).toHaveBeenCalledWith(fixture.componentInstance.notes[0]);
  });

  it('updates presence from a narrow input when the cached note object is unchanged', () => {
    const card = fixture.debugElement.queryAll(By.directive(NoteCardPreviewComponent))[0];
    const sharedNote = { ...fixture.componentInstance.notes[0], ownerUserId: 2, ownerUsername: 'collaborator' };
    fixture.componentInstance.notes = [sharedNote, fixture.componentInstance.notes[1]];
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    expect(card.nativeElement.querySelector('.mini-glyph')).toBeNull();

    sharedNote.ownerOnline = true;
    fixture.componentRef.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    expect(card.nativeElement.querySelector('.mini-glyph.online')).not.toBeNull();
  });
});
