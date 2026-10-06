import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { NoteI } from 'src/app/interfaces/notes';
import { ReminderI } from 'src/app/interfaces/reminder';

export interface NoteAnchorAction {
  note: NoteI;
  button: HTMLDivElement;
}

export interface NoteEventAction {
  note: NoteI;
  event: Event;
}

@Component({
  selector: 'app-note-card-actions',
  templateUrl: './note-card-actions.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false
})
export class NoteCardActionsComponent {
  @Input({ required: true }) note!: NoteI;
  @Input() activeReminder?: ReminderI;
  @Input() displayedReminder?: ReminderI;
  @Input() displayedReminderLabel = '';
  @Input() reminderPickerOpen = false;
  @Input() pendingDateLabel = '';
  @Input() trashCountdownLabel = '';

  @Output() toggleReminder = new EventEmitter<NoteEventAction>();
  @Output() clearReminder = new EventEmitter<NoteEventAction>();
  @Output() reschedulePastReminder = new EventEmitter<NoteEventAction>();
  @Output() confirmPendingDate = new EventEmitter<void>();
  @Output() cancelPendingDate = new EventEmitter<void>();
  @Output() openCollaborators = new EventEmitter<NoteAnchorAction>();
  @Output() openColorMenu = new EventEmitter<NoteAnchorAction>();
  @Output() openImagePicker = new EventEmitter<NoteEventAction>();
  @Output() toggleArchive = new EventEmitter<NoteI>();
  @Output() openMoreMenu = new EventEmitter<NoteAnchorAction>();
  @Output() removeForever = new EventEmitter<NoteEventAction>();
  @Output() restore = new EventEmitter<NoteI>();

  reminderClicked(event: Event) {
    event.stopPropagation();
    this.toggleReminder.emit({ note: this.note, event });
  }

  clearReminderClicked(event: Event) {
    event.stopPropagation();
    this.clearReminder.emit({ note: this.note, event });
  }

  rescheduleClicked(event: Event) {
    event.stopPropagation();
    this.reschedulePastReminder.emit({ note: this.note, event });
  }

  openCollaboratorsClicked(button: HTMLDivElement) {
    this.openCollaborators.emit({ note: this.note, button });
  }

  openColorMenuClicked(button: HTMLDivElement) {
    this.openColorMenu.emit({ note: this.note, button });
  }

  openImagePickerClicked(event: Event) {
    event.stopPropagation();
    this.openImagePicker.emit({ note: this.note, event });
  }

  openMoreMenuClicked(button: HTMLDivElement) {
    this.openMoreMenu.emit({ note: this.note, button });
  }

  removeForeverClicked(event: Event) {
    event.stopPropagation();
    this.removeForever.emit({ note: this.note, event });
  }

  restoreClicked(event: Event) {
    event.stopPropagation();
    this.restore.emit(this.note);
  }
}
