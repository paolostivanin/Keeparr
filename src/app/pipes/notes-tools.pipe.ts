import { Pipe, PipeTransform } from '@angular/core';
import { NoteI } from '../interfaces/notes';
import { ReminderService } from '../services/reminder.service';
import { AuthService } from '../services/auth.service';
import { NoteQuery, type NoteSearchScope } from '../utils/note-query';

/** Template adapter over the shared note query semantics. */
@Pipe({
    name: 'notesTools',
    standalone: false
})
export class NotesToolsPipe implements PipeTransform {
  private readonly query = new NoteQuery()

  constructor(private reminderService: ReminderService, private auth: AuthService) {}

  transform(object: NoteI[], type: string, searchQuery = '', searchScope: NoteSearchScope = 'all'): NoteI[] {
    return this.query.select(object, type, searchQuery, searchScope, {
      myUserId: this.auth.currentUser?.id,
      reminders: this.reminderService.reminders$.value
    })
  }
}
