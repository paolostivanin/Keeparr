import { Component, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NoteI } from 'src/app/interfaces/notes';
import { AuthService } from 'src/app/services/auth.service';
import { NoteSurfacePipe } from 'src/app/pipes/note-surface.pipe';
import { NoteCardPreviewComponent, NotePreviewMeta } from './note-card-preview.component';

const meta: NotePreviewMeta = {
  rawBody: 'Body',
  title: 'Title',
  bgKey: '',
  urls: [],
  linkOnly: false,
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
      declarations: [NoteCardPreviewComponent, PreviewHostComponent, NoteSurfacePipe],
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

  it('treats a checklist note as hybrid when its body holds visible text, an image or an embed, like the editor (W20)', () => {
    const hybrid = (noteBody: string) => {
      fixture.componentInstance.notes = [{ ...note(9, 'List'), isCbox: true, noteBody, checkBoxes: [{ id: 1, done: false, data: 'a', indentLevel: 0 }] }];
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      return (fixture.debugElement.query(By.directive(NoteCardPreviewComponent)).componentInstance as NoteCardPreviewComponent).presentation.isHybrid;
    };
    expect(hybrid('<div class="inline-note-image-wrap" contenteditable="false"><img class="inline-note-image" src="/api/uploads/images/a.png" alt=""></div><div><br></div>')).toBeTrue();
    expect(hybrid('<table><tbody><tr><td>x</td></tr></tbody></table>')).toBeTrue();
    expect(hybrid('<div>text</div>')).toBeTrue();
    expect(hybrid('<div>&nbsp;</div><div><br></div>')).toBeFalse();
    expect(hybrid('')).toBeFalse();
  });

  it('exposes the stored color as light and dark variables and lets the theme pick (P2.2)', () => {
    document.body.classList.remove('light-theme');
    fixture.componentInstance.notes = [{ ...note(9, 'Cream'), bgColor: '#fff8b8' }];
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const main = fixture.nativeElement.querySelector('.note-main') as HTMLElement;
    try {
      expect(main.classList.contains('note-surface')).toBeTrue();
      expect(getComputedStyle(main).getPropertyValue('--note-bg-eff').trim()).toBe('#7c4a03');
      expect(getComputedStyle(main).getPropertyValue('--note-fg-eff').trim()).toBe('#e8eaed');
      document.body.classList.add('light-theme');
      expect(getComputedStyle(main).getPropertyValue('--note-bg-eff').trim()).toBe('#fff8b8');
      expect(getComputedStyle(main).getPropertyValue('--note-fg-eff').trim()).toBe('#202124');
      expect(getComputedStyle(main).getPropertyValue('--note-link-eff').trim()).toBe('#1a73e8');
    } finally {
      document.body.classList.remove('light-theme');
    }
  });

  it('opens from the keyboard on the card itself but not from keys pressed in a control inside it', () => {
    const card = fixture.debugElement.queryAll(By.directive(NoteCardPreviewComponent))[0];
    const open = jasmine.createSpy('open');
    card.componentInstance.open.subscribe(open);
    const target = card.nativeElement.querySelector('.note-preview-open') as HTMLElement;
    expect(target.tabIndex).toBe(0);

    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(open).toHaveBeenCalledTimes(2);

    const inner = document.createElement('button');
    target.appendChild(inner);
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(open).toHaveBeenCalledTimes(2);
    inner.remove();
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
