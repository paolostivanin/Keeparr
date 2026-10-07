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
});
