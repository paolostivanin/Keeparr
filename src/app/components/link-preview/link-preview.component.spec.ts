import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LinkPreviewComponent } from './link-preview.component';
import { NotesService } from 'src/app/services/notes.service';
import { AuthService } from 'src/app/services/auth.service';

describe('LinkPreviewComponent', () => {
  let fixture: ComponentFixture<LinkPreviewComponent>;
  let getLinkPreview: jasmine.Spy;

  beforeEach(async () => {
    getLinkPreview = jasmine.createSpy('getLinkPreview').and.resolveTo({
      title: 'Loaded preview', description: 'Description', image: null,
      url: 'https://example.test/page', domain: 'example.test'
    });
    await TestBed.configureTestingModule({
      declarations: [LinkPreviewComponent],
      providers: [
        { provide: NotesService, useValue: { getLinkPreview, peekLinkPreviewCache: () => null } },
        { provide: AuthService, useValue: { token: '', authenticatedImageUrl: (value: string) => value } }
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA]
    }).compileComponents();
    fixture = TestBed.createComponent(LinkPreviewComponent);
    fixture.componentInstance.url = 'https://example.test/page';
    fixture.detectChanges();
  });

  it('publishes async results into its OnPush view', async () => {
    await fixture.componentInstance.fetchPreview();
    fixture.detectChanges();

    expect(getLinkPreview).toHaveBeenCalledOnceWith('https://example.test/page');
    expect(fixture.nativeElement.textContent).toContain('Loaded preview');
    expect(fixture.nativeElement.textContent).toContain('example.test');
  });

  it('renders a resolved preload immediately without fetching it again', () => {
    const cached = { title: 'Preloaded', description: null, image: null, url: 'https://cached.example.test/page', domain: 'cached.example.test' };
    (fixture.componentInstance as any).notesService.peekLinkPreviewCache = () => cached;
    fixture.componentInstance.url = 'https://cached.example.test/page';
    fixture.detectChanges();

    expect(fixture.componentInstance.loading).toBeFalse();
    expect(fixture.componentInstance.preview).toBe(cached);
    expect(getLinkPreview).not.toHaveBeenCalled();
  });
});
