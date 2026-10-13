import { TestBed } from '@angular/core/testing';
import { HTTP_INTERCEPTORS, HttpClient, HttpHeaders, provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { AuthExpiredInterceptor } from './auth-expired.interceptor';
import { AuthService } from './auth.service';
import { ConnectionHeadersInterceptor } from './connection-headers.interceptor';

describe('AuthExpiredInterceptor', () => {
  // Other specs can leave a pending theme behind, which would add a preferences PATCH to the constructor's requests.
  const storageKeys = ['gk_session', 'gk_pending_theme'];
  let previous: (string | null)[];

  beforeEach(() => {
    previous = storageKeys.map(key => localStorage.getItem(key));
    localStorage.removeItem('gk_pending_theme');
    localStorage.setItem('gk_session', JSON.stringify({ id: 1, username: 'test', token: 'session-token' }));
    TestBed.configureTestingModule({
      providers: [
        { provide: HTTP_INTERCEPTORS, useClass: ConnectionHeadersInterceptor, multi: true },
        { provide: HTTP_INTERCEPTORS, useClass: AuthExpiredInterceptor, multi: true },
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting()
      ]
    });
  });

  afterEach(() => {
    storageKeys.forEach((key, index) => {
      const value = previous[index];
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    });
    TestBed.inject(HttpTestingController).verify();
  });

  it('lets AuthService send requests while it is being constructed (no NG0200 cycle)', async () => {
    // The constructor requests a media ticket for the stored session; that must not poison the interceptor chain.
    TestBed.inject(AuthService);
    const http = TestBed.inject(HttpTestingController);
    http.expectOne(request => request.url.endsWith('/auth/media-ticket'))
      .flush({ ticket: 't', expiresAt: new Date(Date.now() + 3600_000).toISOString() });

    const later = firstValueFrom(TestBed.inject(HttpClient).get<{ ok: boolean }>('/api/client/capabilities'));
    http.expectOne('/api/client/capabilities').flush({ ok: true });
    expect(await later).toEqual({ ok: true });
  });

  it('still reports an expired session for authenticated requests', async () => {
    const auth = TestBed.inject(AuthService);
    const http = TestBed.inject(HttpTestingController);
    http.expectOne(request => request.url.endsWith('/auth/media-ticket'))
      .flush({ ticket: 't', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const notify = spyOn(auth, 'notifySessionExpired').and.returnValue(true);

    const request = firstValueFrom(TestBed.inject(HttpClient).get('/api/notes', {
      headers: new HttpHeaders({ Authorization: 'Bearer session-token' })
    }));
    http.expectOne('/api/notes').flush({ error: 'Authentication required.' }, { status: 401, statusText: 'Unauthorized' });

    await expectAsync(request).toBeRejected();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
