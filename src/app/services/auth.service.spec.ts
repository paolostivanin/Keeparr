import { AuthService } from './auth.service';

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
