import { TestBed } from '@angular/core/testing';
import { HTTP_INTERCEPTORS, HttpClient, HttpHeaders, provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { AuthExpiredInterceptor } from './auth-expired.interceptor';
import { AuthService } from './auth.service';
import { ConnectionHeadersInterceptor } from './connection-headers.interceptor';

describe('AuthExpiredInterceptor', () => {
  let previousSession: string | null;

  beforeEach(() => {
    previousSession = localStorage.getItem('gk_session');
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
    TestBed.inject(HttpTestingController).verify();
    if (previousSession === null) localStorage.removeItem('gk_session');
    else localStorage.setItem('gk_session', previousSession);
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
