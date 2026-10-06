import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CheckboxI, NoteAttachmentI, NoteI, NoteImageI } from 'src/app/interfaces/notes';
import { AuthService } from 'src/app/services/auth.service';
import { normalizeIndentLevel, normalizeIndentLevels } from 'src/app/utils/checkbox-indent';

export type NoteBodySegment = { type: 'html'; value: string } | { type: 'url'; value: string };

export interface NotePreviewMeta {
  rawBody: string;
  title: string;
  bgKey: string;
  urls: string[];
  linkOnly: boolean;
  textColor: string;
  displayBody: string;
  bodySegments: NoteBodySegment[];
  hiddenLinkCount: number;
  visibleUrls: string[];
}

export interface NoteCheckboxAction {
  note: NoteI;
  checkbox: CheckboxI;
  event: Event;
}

export interface NotePreviewImageAction {
  image: NoteImageI;
  event: Event;
}

export interface NotePreviewAttachmentAction {
  attachment: NoteAttachmentI;
  event: Event;
}

interface NoteCardPresentation {
  readonly hasVisibleTitle: boolean;
  readonly isHybrid: boolean;
  readonly checklistItems: readonly CheckboxI[];
  readonly completedChecklistCount: number;
  readonly checklistPreview: { readonly items: readonly CheckboxI[]; readonly more: number };
}

@Component({
  selector: 'app-note-card-preview',
  templateUrl: './note-card-preview.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false
})
export class NoteCardPreviewComponent {
  @Input({ required: true }) note!: NoteI;
  @Input({ required: true }) meta!: NotePreviewMeta;
  @Input() lockedPreviewHidden = false;
  @Input() moveCompletedChecklistItemsToBottom = true;
  @Input() ownerOnline = false;

  @Output() open = new EventEmitter<NoteI>();
  @Output() toggleCheckbox = new EventEmitter<NoteCheckboxAction>();
  @Output() removeCheckbox = new EventEmitter<NoteCheckboxAction>();
  @Output() downloadImage = new EventEmitter<NotePreviewImageAction>();
  @Output() downloadInlineImage = new EventEmitter<Event>();
  @Output() removeLabel = new EventEmitter<{ note: NoteI; label: NoteI['labels'][number] }>();
  @Output() downloadAttachment = new EventEmitter<NotePreviewAttachmentAction>();

  private cachedPresentation?: { note: NoteI; meta: NotePreviewMeta; moveCompleted: boolean; value: NoteCardPresentation };

  constructor(public auth: AuthService) {}

  get presentation(): NoteCardPresentation {
    const cached = this.cachedPresentation;
    if (cached && cached.note === this.note && cached.meta === this.meta
      && cached.moveCompleted === this.moveCompletedChecklistItemsToBottom) return cached.value;

    const titleText = (this.note.noteTitle || '')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;|&#160;|&#x[a-f0-9]*a0;/gi, '')
      .trim();
    const bodyText = (this.note.noteBody || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    const sourceItems = this.note.checkBoxes || [];
    const visibleItems = this.moveCompletedChecklistItemsToBottom
      ? sourceItems.filter(item => !item.done)
      : sourceItems;
    const checklistItems = normalizeIndentLevels(visibleItems);
    const checklistPreview: CheckboxI[] = [];
    let usedLines = 0;
    for (const item of checklistItems) {
      const length = this.htmlPlainText(item.data).length;
      const lines = length <= 34 ? 1 : length <= 72 ? 2 : 3;
      if (checklistPreview.length && (checklistPreview.length >= 7 || usedLines + lines > 11)) break;
      checklistPreview.push(item);
      usedLines += lines;
    }
    const value: NoteCardPresentation = Object.freeze({
      hasVisibleTitle: titleText.length > 0,
      isHybrid: !!this.note.isCbox && bodyText.length > 0,
      checklistItems: Object.freeze(checklistItems),
      completedChecklistCount: sourceItems.filter(item => item.done).length,
      checklistPreview: Object.freeze({
        items: Object.freeze(checklistPreview),
        more: Math.max(0, checklistItems.length - checklistPreview.length)
      })
    });
    this.cachedPresentation = { note: this.note, meta: this.meta, moveCompleted: this.moveCompletedChecklistItemsToBottom, value };
    return value;
  }

  checkboxIndentPx(checkbox: CheckboxI) {
    return normalizeIndentLevel(checkbox.indentLevel) * 28;
  }

  trackBodySegment(index: number, segment: NoteBodySegment) {
    return `${index}:${segment.type}:${segment.value}`;
  }

  imageSrc(src: string) {
    return this.auth.authenticatedImageUrl(src);
  }

  ownerIsOtherUser() {
    return !!(this.note.ownerUserId && this.auth.currentUser?.id && this.note.ownerUserId !== this.auth.currentUser.id);
  }

  trackImage(_index: number, image: NoteImageI) {
    return image.id;
  }

  trackLabel(_index: number, label: NoteI['labels'][number]) {
    return label.id ?? label.name;
  }

  trackAttachment(_index: number, attachment: NoteAttachmentI) {
    return attachment.id;
  }

  private htmlPlainText(value?: string | null) {
    const element = document.createElement('div');
    element.innerHTML = String(value || '');
    return (element.textContent || element.innerText || '').replace(/\s+/g, ' ').trim();
  }

  toggleCheckboxFromEvent(checkbox: CheckboxI, event: Event) {
    event.stopPropagation();
    event.preventDefault();
    this.toggleCheckbox.emit({ note: this.note, checkbox, event });
  }

  removeCheckboxFromEvent(checkbox: CheckboxI, event: Event) {
    event.stopPropagation();
    event.preventDefault();
    this.removeCheckbox.emit({ note: this.note, checkbox, event });
  }

  downloadImageFromEvent(image: NoteImageI, event: Event) {
    this.downloadImage.emit({ image, event });
  }

  removeLabelFromEvent(label: NoteI['labels'][number], event: Event) {
    event.stopPropagation();
    this.removeLabel.emit({ note: this.note, label });
  }

  downloadAttachmentFromEvent(attachment: NoteAttachmentI, event: Event) {
    event.stopPropagation();
    this.downloadAttachment.emit({ attachment, event });
  }

  attachmentIcon(attachment: NoteAttachmentI) {
    const extension = attachment.originalName.split('.').pop()?.toLowerCase() || '';
    if (attachment.mimeType.startsWith('image/')) return 'image';
    if (attachment.mimeType.includes('pdf')) return 'picture_as_pdf';
    if (['txt', 'md', 'csv', 'json', 'xml'].includes(extension)) return 'description';
    if (['zip', 'rar', '7z', 'gz', 'tar'].includes(extension)) return 'folder_zip';
    if (['xls', 'xlsx', 'ods'].includes(extension)) return 'table_chart';
    if (['ppt', 'pptx', 'odp'].includes(extension)) return 'slideshow';
    return 'draft';
  }

  formatFileSize(size: number) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

}
