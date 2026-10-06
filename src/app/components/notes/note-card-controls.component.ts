import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { NoteI } from 'src/app/interfaces/notes';

export interface NoteSelectionAction {
  note: NoteI;
  event: Event;
}

export interface NotePinAction {
  noteId: number;
  pinned: boolean;
}

@Component({
  selector: 'app-note-card-controls',
  template: `
    <div class="check-icon" (click)="select($event)">
      <svg viewBox="0 0 18 18"><path d="m6.61 11.89l-3.11-3.11-1.06 1.06 4.17 4.16 8.95-8.95-1.06-1.05z"/></svg>
    </div>
    <div (click)="togglePin($event)" [class.pinned]="note.pinned" class="pin-icon H pop"
      [attr.data-pop]="!note.pinned ? 'Pin note' : 'Unpin note'"></div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false
})
export class NoteCardControlsComponent {
  @Input({ required: true }) note!: NoteI;

  @Output() selectionChanged = new EventEmitter<NoteSelectionAction>();
  @Output() pinChanged = new EventEmitter<NotePinAction>();

  select(event: Event) {
    event.stopPropagation();
    this.selectionChanged.emit({ note: this.note, event });
  }

  togglePin(event: Event) {
    event.stopPropagation();
    if (this.note.id == null) return;
    this.pinChanged.emit({ noteId: this.note.id, pinned: this.note.pinned });
  }
}
