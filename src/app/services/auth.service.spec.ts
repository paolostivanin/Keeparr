import { AuthService } from './auth.service';
import { of } from 'rxjs';

describe('AuthService authenticated image HTML', () => {
  it('adds lazy decoding hints only for note previews', () => {
    const auth = new AuthService({} as any);
    const html = '<p>Text</p><img src="https://images.example.test/photo.jpg" alt="Photo">';
    const preview = document.createElement('div');
    preview.innerHTML = auth.authenticatedImageHtml(html, { lazyPreviewImages: true });
    const previewImage = preview.querySelector('img')!;
    expect(previewImage.loading).toBe('lazy');
    expect(previewImage.decoding).toBe('async');

    const editor = document.createElement('div');
    editor.innerHTML = auth.authenticatedImageHtml(html);
    expect(editor.querySelector('img')!.getAttribute('loading')).toBeNull();
    expect(editor.querySelector('img')!.getAttribute('decoding')).toBeNull();
  });

  it('applies a theme choice locally even when the account preference request fails', async () => {
    const auth = new AuthService({} as any);
    const user = { id: 4, username: 'test', theme: 'dark' } as any;
    auth.currentUser$.next(user);
    spyOn(auth, 'updateAccountPreferences').and.rejectWith(new Error('offline'));

    await auth.updateTheme('light');

    expect(document.body.classList.contains('light-theme')).toBeTrue();
    expect(auth.currentUser?.theme).toBe('light');
    expect(JSON.parse(localStorage.getItem('gk_session') || '{}').theme).toBe('light');
  });
});

describe('AuthService media tickets', () => {
  it('uses ?ticket= (never ?token=) and keeps the canonical URL ticket-free', async () => {
    const post = jasmine.createSpy('post').and.returnValue(of({ ticket: 'tkt 1', expiresAt: new Date(Date.now() + 7200_000).toISOString() }));
    const auth = new AuthService({ post } as any);
    auth.currentUser$.next({ id: 1, token: 'session-token' } as any);

    expect(auth.authenticatedImageUrl('/uploads/a.png')).toBe('/api/uploads/images/a.png');
    await auth.ensureMediaTicket();
    expect(post.calls.argsFor(0)[0]).toContain('/auth/media-ticket');

    const url = auth.authenticatedImageUrl('/uploads/a.png');
    expect(url).toBe('/api/uploads/images/a.png?ticket=tkt%201');
    expect(url).not.toContain('token=');
    expect(auth.canonicalImageUrl(url)).toBe('/api/uploads/images/a.png');
    expect(auth.withMediaTicket('/api/proxy-image?url=x')).toBe('/api/proxy-image?url=x&ticket=tkt%201');
  });
});
