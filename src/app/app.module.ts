import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { HTTP_INTERCEPTORS, provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { AppComponent } from './app.component';
import { MainComponent } from './components/main/main.component';
import { NavComponent } from './components/sidenav/sidenav.component';
import { NavbarComponent } from './components/navbar/navbar.component';
import { NotesComponent } from './components/notes/notes.component';
import { NoteCardPreviewComponent } from './components/notes/note-card-preview.component';
import { NoteCardControlsComponent } from './components/notes/note-card-controls.component';
import { NoteCardActionsComponent } from './components/notes/note-card-actions.component';
import { InputComponent } from './components/input/input.component';
import { ph } from './pipes/ph.pipe';
import { AppRoutingModule } from './app-routing.module';
import { CboxSortPipe } from './pipes/cbox-sort.pipe';
import { CboxDonePipe } from './pipes/cbox-done.pipe';
import { NotesToolsPipe } from './pipes/notes-tools.pipe';
import { ReminderNotificationComponent } from './components/reminder/reminder-notification.component';
import { LinkPreviewComponent } from './components/link-preview/link-preview.component';
import { UpdateBannerComponent } from './components/update-banner/update-banner.component';
import { MergeDialogComponent } from './components/merge-dialog/merge-dialog.component';
import { AuthExpiredInterceptor } from './services/auth-expired.interceptor';
import { ConnectionHeadersInterceptor } from './services/connection-headers.interceptor';

@NgModule({ declarations: [
        AppComponent,
        MainComponent,
        NavComponent,
        NavbarComponent,
        NotesComponent,
        NoteCardPreviewComponent,
        NoteCardControlsComponent,
        NoteCardActionsComponent,
        InputComponent,
        ph,
        CboxSortPipe,
        CboxDonePipe,
        NotesToolsPipe,
        ReminderNotificationComponent,
        LinkPreviewComponent,
        UpdateBannerComponent,
        MergeDialogComponent,
    ],
    bootstrap: [AppComponent], imports: [BrowserModule,
        FormsModule,
        AppRoutingModule], providers: [
        { provide: HTTP_INTERCEPTORS, useClass: ConnectionHeadersInterceptor, multi: true },
        { provide: HTTP_INTERCEPTORS, useClass: AuthExpiredInterceptor, multi: true },
        provideHttpClient(withInterceptorsFromDi())
    ] })
export class AppModule { }
