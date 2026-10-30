import { inertDiv } from '../utils/inert-html';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { firstValueFrom, BehaviorSubject } from 'rxjs';
import { environment } from 'src/environments/environment';
import { AuthSessionI, UserI, UserRole, UserTheme } from '../interfaces/users';

type LoginResponse = {
  token: string
  user: UserI
}

export interface McpAccessSettings {
  enabled: boolean
  allowLockedNotes: boolean
  allowPermanentDelete: boolean
  token: { prefix: string; createdAt: string; lastUsedAt: string | null } | null
  accessToken?: string
}

export interface OAuthConnection {
  id: number
  clientId: string
  clientName: string
  resource: string
  scopes: string[]
  authorizedAt: string
  lastUsedAt: string | null
}

export interface OAuthAccessSettings {
  enabled: boolean
  allowLockedNotes: boolean
  allowPermanentDelete: boolean
  connections: OAuthConnection[]
}

export interface ExternalAccessCapabilities {
  allowLockedNotes: boolean
  allowPermanentDelete: boolean
}

export interface OidcConfig {
  enabled: boolean
  name: string
}

export interface OidcLinkStatus {
  enabled: boolean
  providerName: string
  connected: boolean
  identityEmail: string
  connectedAt: string | null
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private readonly sessionKey = 'gk_session';
  private readonly pendingThemeKey = 'gk_pending_theme';
  private readonly apiUrl = environment.apiUrl;
  private lastSessionExpiredNoticeAt = 0;
  private suppressSessionExpiredUntil = 0;
  currentUser$ = new BehaviorSubject<AuthSessionI | null>(this.getStoredSession());

  constructor(private http: HttpClient) {
    this.applyTheme(this.currentUser?.theme || 'light');
    window.addEventListener('online', this.retryPendingTheme);
    if (this.currentUser && localStorage.getItem(this.pendingThemeKey)) this.retryPendingTheme();
    if (this.token) void this.ensureMediaTicket();
    document.addEventListener('error', this.retryImageWithTicket, true);
  }

  // Media tickets: short-lived read-only credentials for <img> URLs, since session tokens never go in URLs.
  private mediaTicketValue = '';
  private mediaTicketExpiresAt = 0;
  private mediaTicketRequest: Promise<string> | null = null;
  private mediaTicketTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly mediaTicketRefreshLeadMs = 10 * 60 * 1000;
  mediaTicket$ = new BehaviorSubject<string>('');

  get mediaTicket() {
    return this.mediaTicketValue;
  }

  async ensureMediaTicket(force = false): Promise<string> {
    if (!this.token) return '';
    if (!force && this.mediaTicketValue && Date.now() < this.mediaTicketExpiresAt - 60_000) return this.mediaTicketValue;
    if (this.mediaTicketRequest) return this.mediaTicketRequest;
    const sessionToken = this.token;
    const request = (async () => {
      try {
        const result = await firstValueFrom(this.http.post<{ ticket: string, expiresAt: string }>(
          `${this.apiUrl}/auth/media-ticket`, {}, { headers: this.authHeaders() }
        ));
        if (this.token !== sessionToken) return '';
        const expiresAt = Date.parse(result.expiresAt);
        this.mediaTicketValue = result.ticket;
        this.mediaTicketExpiresAt = Number.isFinite(expiresAt) ? expiresAt : Date.now() + 2 * 60 * 60 * 1000;
        this.mediaTicket$.next(result.ticket);
        this.scheduleMediaTicketRefresh();
        return result.ticket;
      } catch {
        return this.mediaTicketValue;
      } finally {
        this.mediaTicketRequest = null;
      }
    })();
    this.mediaTicketRequest = request;
    return request;
  }

  private scheduleMediaTicketRefresh() {
    if (this.mediaTicketTimer) clearTimeout(this.mediaTicketTimer);
    const delay = Math.max(30_000, this.mediaTicketExpiresAt - Date.now() - this.mediaTicketRefreshLeadMs);
    this.mediaTicketTimer = setTimeout(() => { void this.ensureMediaTicket(true); }, delay);
  }

  private clearMediaTicket() {
    if (this.mediaTicketTimer) clearTimeout(this.mediaTicketTimer);
    this.mediaTicketTimer = undefined;
    this.mediaTicketValue = '';
    this.mediaTicketExpiresAt = 0;
    this.mediaTicketRequest = null;
    this.mediaTicket$.next('');
  }

  /** Appends the current media ticket to an API media URL (uses `&` when a query already exists). */
  withMediaTicket(url: string) {
    const ticket = this.mediaTicketValue;
    if (!ticket) {
      void this.ensureMediaTicket();
      return url;
    }
    return `${url}${url.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket)}`;
  }

  // Images rendered before a ticket existed (or after it expired) fail once; re-point them at a fresh ticket.
  private retryImageWithTicket = (event: Event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !this.token) return;
    const src = img.getAttribute('src') || '';
    if (!/\/(?:uploads\/images\/|proxy-image)/.test(src) || src.startsWith('blob:') || src.startsWith('data:')) return;
    const previous = src.match(/[?&]ticket=([^&]+)/)?.[1] || '';
    if (img.dataset['ticketRetry'] === previous) return;
    img.dataset['ticketRetry'] = previous;
    void this.ensureMediaTicket(!!previous).then(ticket => {
      if (!ticket || encodeURIComponent(ticket) === previous || !img.isConnected) return;
      const base = src.replace(/([?&])ticket=[^&]*&?/, '$1').replace(/[?&]$/, '');
      img.setAttribute('src', `${base}${base.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket)}`);
    });
  };

  /** Like authenticatedImageUrl but waits for a ticket first; for fetch()-based callers. */
  async authenticatedImageUrlReady(value: string) {
    await this.ensureMediaTicket();
    return this.authenticatedImageUrl(value);
  }

  get currentUser() {
    return this.currentUser$.value;
  }

  get token() {
    return this.currentUser?.token || '';
  }

  get isAdmin() {
    return this.currentUser?.role === 'admin';
  }

  authHeaders() {
    return new HttpHeaders({ Authorization: `Bearer ${this.token}` });
  }

  isAuthExpiredError(error: unknown) {
    return error instanceof HttpErrorResponse && error.status === 401;
  }

  notifySessionExpired(error?: unknown) {
    if (error && !this.isAuthExpiredError(error)) return false;
    if (Date.now() < this.suppressSessionExpiredUntil) return true;
    const now = Date.now();
    if (now - this.lastSessionExpiredNoticeAt < 4000) return true;
    this.lastSessionExpiredNoticeAt = now;
    try {
      (window as any).Snackbar?.show({
        pos: 'bottom-left',
        text: 'Session expired. Please sign in again before saving.',
        duration: 5200
      });
    } catch {}
    return true;
  }

  suppressSessionExpiredNotice(durationMs = 8000) {
    this.suppressSessionExpiredUntil = Math.max(this.suppressSessionExpiredUntil, Date.now() + durationMs);
  }

  canonicalImageUrl(value: string) {
    const raw = String(value || '').trim();
    const offlineMap = (window as typeof window & { __keeparrOfflineMediaCanonical?: Map<string, string> }).__keeparrOfflineMediaCanonical;
    const offlineCanonical = offlineMap?.get(raw);
    if (offlineCanonical) return offlineCanonical;
    if (!raw || raw.startsWith('data:')) return raw;
    let pathname = raw;
    try {
      const parsed = new URL(raw, window.location.origin);
      const allowedOrigins = new Set([window.location.origin]);
      if (this.apiUrl.startsWith('http')) allowedOrigins.add(new URL(this.apiUrl).origin);
      if (!allowedOrigins.has(parsed.origin)) return raw;
      pathname = parsed.pathname;
    } catch {}
    const match = pathname.match(/^(?:\/uploads\/|\/api\/uploads\/images\/)([^/?#]+)$/);
    if (!match) return raw;
    return `/api/uploads/images/${match[1]}`;
  }

  authenticatedImageUrl(value: string) {
    const raw = String(value || '').trim();
    const offlineMap = (window as typeof window & { __keeparrOfflineMediaCanonical?: Map<string, string> }).__keeparrOfflineMediaCanonical;
    if (offlineMap?.has(raw)) return raw;
    const canonical = this.canonicalImageUrl(value);
    if (!canonical.startsWith('/api/uploads/images/')) return canonical;
    const imageUrl = this.apiUrl.startsWith('http') ? `${this.apiUrl}${canonical.slice('/api'.length)}` : canonical;
    if (!this.token) return imageUrl;
    return this.withMediaTicket(imageUrl);
  }

  authenticatedImageHtml(html: string, options: { lazyPreviewImages?: boolean } = {}) {
    const div = inertDiv(html || '');
    div.querySelectorAll<HTMLImageElement>('img[src]').forEach(img => {
      img.setAttribute('src', this.authenticatedImageUrl(img.getAttribute('src') || img.src));
      if (options.lazyPreviewImages) {
        img.loading = 'lazy';
        img.decoding = 'async';
      }
    });
    return div.innerHTML;
  }

  canonicalImageHtml(html: string) {
    const div = inertDiv(html || '');
    div.querySelectorAll<HTMLImageElement>('img[src]').forEach(img => {
      img.setAttribute('src', this.canonicalImageUrl(img.getAttribute('src') || img.src));
    });
    return div.innerHTML;
  }

  async hasUsers() {
    const result = await firstValueFrom(this.http.get<{ hasUsers: boolean }>(`${this.apiUrl}/setup/status`));
    return result.hasUsers;
  }

  async setupTokenRequired() {
    const result = await firstValueFrom(this.http.get<{ setupTokenRequired?: boolean }>(`${this.apiUrl}/setup/status`));
    return result.setupTokenRequired === true;
  }

  async listUsers() {
    return await firstValueFrom(this.http.get<UserI[]>(`${this.apiUrl}/users`, { headers: this.authHeaders() }));
  }

  async createInitialAdmin(username: string, displayName: string, password: string, totpSecret?: string, totpToken?: string, setupToken?: string) {
    const payload: any = { username, displayName, password };
    if (setupToken) payload.setupToken = setupToken;
    if (totpSecret && totpToken) {
      payload.totpSecret = totpSecret;
      payload.totpToken = totpToken;
    }
    return await firstValueFrom(this.http.post<{ user: UserI, backupCodes: string[] | null }>(`${this.apiUrl}/setup/admin`, payload));
  }

  async createManagedUser(username: string, displayName: string, password: string, role: UserRole, email?: string) {
    return await firstValueFrom(this.http.post<UserI>(
      `${this.apiUrl}/users`,
      { username, displayName, password, role, email },
      { headers: this.authHeaders() }
    ));
  }

  async deleteUser(user: UserI) {
    if (!user.id) throw new Error('User is missing an id.');
    await firstValueFrom(this.http.delete(`${this.apiUrl}/users/${user.id}`, { headers: this.authHeaders() }));
  }

  async deleteOwnAccount(currentPassword: string, confirmation: string) {
    await firstValueFrom(this.http.delete(`${this.apiUrl}/users/me`, {
      headers: this.authHeaders(),
      body: { currentPassword, confirmation }
    }));
    localStorage.removeItem(this.sessionKey);
    localStorage.removeItem(this.pendingThemeKey);
    this.clearMediaTicket();
    this.currentUser$.next(null);
    this.applyTheme('light');
  }

  async generateSetup2fa(username?: string) {
    const params = username ? `?username=${encodeURIComponent(username)}` : '';
    return await firstValueFrom(this.http.get<{ secret: string, qrCodeUrl: string }>(`${this.apiUrl}/setup/2fa/generate${params}`));
  }

  async generateSettings2fa() {
    return await firstValueFrom(this.http.get<{ secret: string, qrCodeUrl: string }>(`${this.apiUrl}/auth/2fa/generate`, { headers: this.authHeaders() }));
  }

  async enable2fa(secret: string, token: string, currentPassword: string, currentToken?: string) {
    const body: Record<string, string> = { secret, token, currentPassword };
    if (currentToken) body['currentToken'] = currentToken;
    return await firstValueFrom(this.http.post<{ success: boolean, backupCodes: string[] }>(`${this.apiUrl}/auth/2fa/enable`, body, { headers: this.authHeaders() }));
  }

  /** Needs a current authenticator code or a backup code; a session alone cannot remove the second factor. */
  async disable2fa(token: string) {
    return await firstValueFrom(this.http.delete(`${this.apiUrl}/auth/2fa/disable`, { headers: this.authHeaders(), body: { token } }));
  }

  async login(username: string, password: string, totpToken?: string) {
    let result: LoginResponse;
    try {
      const payload: any = { username, password };
      if (totpToken) payload.totpToken = totpToken;
      result = await firstValueFrom(this.http.post<LoginResponse>(`${this.apiUrl}/auth/login`, payload));
    } catch (error: any) {
      if (error?.error?.requires2FA) {
        throw { requires2FA: true };
      }
      if (error?.status === 403) {
        throw error;
      }
      return false;
    }

    this.storeLoginResult(result);
    return true;
  }

  async getOidcConfig() {
    return await firstValueFrom(this.http.get<OidcConfig>(`${this.apiUrl}/auth/oidc/config`));
  }

  startOidcLogin(oauthRequest = '') {
    const params = new URLSearchParams();
    if (oauthRequest) params.set('oauth_request', oauthRequest);
    const returnUrl = this.nativeOidcReturnUrl();
    if (returnUrl) params.set('return_url', returnUrl);
    const query = params.toString() ? `?${params.toString()}` : '';
    window.location.assign(`${this.apiUrl}/auth/oidc/start${query}`);
  }

  async exchangeOidcCode(code: string) {
    const result = await firstValueFrom(this.http.post<LoginResponse>(`${this.apiUrl}/auth/oidc/exchange`, { code }));
    this.storeLoginResult(result);
  }

  async getOidcLinkStatus() {
    return await firstValueFrom(this.http.get<OidcLinkStatus>(
      `${this.apiUrl}/auth/oidc/link/status`,
      { headers: this.authHeaders() }
    ));
  }

  async startOidcLink() {
    const returnUrl = this.nativeOidcReturnUrl();
    return await firstValueFrom(this.http.post<{ url: string }>(
      `${this.apiUrl}/auth/oidc/link/start`,
      returnUrl ? { return_url: returnUrl } : {},
      { headers: this.authHeaders() }
    ));
  }

  async disconnectOidcLink() {
    await firstValueFrom(this.http.delete(
      `${this.apiUrl}/auth/oidc/link`,
      { headers: this.authHeaders() }
    ));
  }

  private storeLoginResult(result: LoginResponse) {
    const session: AuthSessionI = {
      token: result.token,
      id: result.user.id!,
      username: result.user.username,
      displayName: result.user.displayName,
      role: result.user.role,
      theme: result.user.theme || 'light',
      avatarDataUrl: result.user.avatarDataUrl || '',
      avatarPreset: result.user.avatarPreset || 'cat',
      showPastReminders: result.user.showPastReminders === true,
      totpEnabled: result.user.totpEnabled,
      hasBackupCodes: result.user.hasBackupCodes,
      demoNotesCreatedAt: result.user.demoNotesCreatedAt ?? null
    };
    localStorage.setItem(this.sessionKey, JSON.stringify(session));
    this.clearMediaTicket();
    this.currentUser$.next(session);
    this.applyTheme(session.theme);
    void this.ensureMediaTicket();
  }

  private nativeOidcReturnUrl() {
    return Capacitor.isNativePlatform() ? 'keeparr://auth/oidc' : '';
  }

  async updateTheme(theme: UserTheme) {
    const current = this.currentUser;
    if (!current) return;
    // Apply and persist locally first so a transient/offline preference write
    // never leaves the visible theme toggle inert.
    const optimistic = { ...current, theme };
    localStorage.setItem(this.sessionKey, JSON.stringify(optimistic));
    this.currentUser$.next(optimistic);
    this.applyTheme(theme);
    localStorage.setItem(this.pendingThemeKey, theme);
    try {
      await this.updateAccountPreferences({ theme });
      if (localStorage.getItem(this.pendingThemeKey) === theme) localStorage.removeItem(this.pendingThemeKey);
    } catch {
      localStorage.setItem(this.pendingThemeKey, theme);
    }
  }

  private readonly retryPendingTheme = () => {
    const theme = localStorage.getItem(this.pendingThemeKey) as UserTheme | null;
    if (!theme || !this.currentUser?.token) return;
    void this.updateAccountPreferences({ theme }).then(() => {
      if (localStorage.getItem(this.pendingThemeKey) === theme) localStorage.removeItem(this.pendingThemeKey);
    }).catch(() => undefined);
  };

  async loadAccountPreferences() {
    const user = await firstValueFrom(this.http.get<UserI>(
      `${this.apiUrl}/users/me/preferences`,
      { headers: this.authHeaders() }
    ));
    this.mergeAccountPreferences(user);
    return user;
  }

  async updateAccountPreferences(patch: { theme?: UserTheme; showPastReminders?: boolean }) {
    const user = await firstValueFrom(this.http.patch<UserI>(
      `${this.apiUrl}/users/me/preferences`,
      patch,
      { headers: this.authHeaders() }
    ));
    this.mergeAccountPreferences(user);
    return user;
  }

  async getMcpAccessSettings() {
    return await firstValueFrom(this.http.get<McpAccessSettings>(
      `${this.apiUrl}/users/me/mcp-access`,
      { headers: this.authHeaders() }
    ));
  }

  async enableMcpAccess() {
    return await firstValueFrom(this.http.post<McpAccessSettings>(
      `${this.apiUrl}/users/me/mcp-access/enable`,
      {},
      { headers: this.authHeaders() }
    ));
  }

  async updateMcpAccessSettings(patch: { allowLockedNotes?: boolean; allowPermanentDelete?: boolean }) {
    return await firstValueFrom(this.http.patch<McpAccessSettings>(
      `${this.apiUrl}/users/me/mcp-access`,
      patch,
      { headers: this.authHeaders() }
    ));
  }

  async disableMcpAccess() {
    await firstValueFrom(this.http.delete(`${this.apiUrl}/users/me/mcp-access`, { headers: this.authHeaders() }));
  }

  async getOAuthAccessSettings() {
    return await firstValueFrom(this.http.get<OAuthAccessSettings>(
      `${this.apiUrl}/users/me/oauth-access`,
      { headers: this.authHeaders() }
    ));
  }

  async enableOAuthAccess() {
    return await firstValueFrom(this.http.post<OAuthAccessSettings>(
      `${this.apiUrl}/users/me/oauth-access/enable`,
      {},
      { headers: this.authHeaders() }
    ));
  }

  async disableOAuthAccess() {
    await firstValueFrom(this.http.delete(`${this.apiUrl}/users/me/oauth-access`, { headers: this.authHeaders() }));
  }

  async revokeOAuthConnection(grantId: number) {
    await firstValueFrom(this.http.delete(
      `${this.apiUrl}/users/me/oauth-access/connections/${grantId}`,
      { headers: this.authHeaders() }
    ));
  }

  async updateExternalAccessCapabilities(patch: Partial<ExternalAccessCapabilities>) {
    return await firstValueFrom(this.http.patch<ExternalAccessCapabilities>(
      `${this.apiUrl}/users/me/external-access/capabilities`,
      patch,
      { headers: this.authHeaders() }
    ));
  }

  private mergeAccountPreferences(user: UserI) {
    const current = this.currentUser;
    if (!current) return;
    const session = {
      ...current,
      theme: localStorage.getItem(this.pendingThemeKey) as UserTheme || user.theme || current.theme,
      showPastReminders: user.showPastReminders === true
    };
    localStorage.setItem(this.sessionKey, JSON.stringify(session));
    this.currentUser$.next(session);
    this.applyTheme(session.theme);
  }

  async updateProfile(displayName: string, avatarDataUrl: string, avatarPreset?: string) {
    const user = await firstValueFrom(this.http.patch<UserI>(
      `${this.apiUrl}/users/me/profile`,
      { displayName, avatarDataUrl, avatarPreset },
      { headers: this.authHeaders() }
    ));
    const current = this.currentUser;
    if (!current) return;

    const session = {
      ...current,
      displayName: user.displayName,
      avatarDataUrl: user.avatarDataUrl || '',
      avatarPreset: user.avatarPreset || current.avatarPreset || 'cat'
    };
    localStorage.setItem(this.sessionKey, JSON.stringify(session));
    this.currentUser$.next(session);
  }

  async markDemoNotesCreated() {
    const user = await firstValueFrom(this.http.post<UserI>(
      `${this.apiUrl}/users/me/mark-demo-notes-created`,
      {},
      { headers: this.authHeaders() }
    ));
    const current = this.currentUser;
    if (!current) return user;
    const session = { ...current, demoNotesCreatedAt: user.demoNotesCreatedAt || new Date().toISOString() };
    localStorage.setItem(this.sessionKey, JSON.stringify(session));
    this.currentUser$.next(session);
    return user;
  }

  async logout() {
    if (this.token) {
      try {
        await firstValueFrom(this.http.post(`${this.apiUrl}/auth/logout`, {}, { headers: this.authHeaders() }));
      } catch {
        // Local logout should still succeed if the API is temporarily unavailable.
      }
    }
    localStorage.removeItem(this.sessionKey);
    localStorage.removeItem(this.pendingThemeKey);
    this.clearMediaTicket();
    this.currentUser$.next(null);
    this.applyTheme('light');
  }

  async resetOwnPassword(currentPassword: string, newPassword: string) {
    return await firstValueFrom(this.http.patch<{ success: boolean }>(
      `${this.apiUrl}/users/me/password`,
      { currentPassword, newPassword },
      { headers: this.authHeaders() }
    ));
  }

  async adminResetPassword(userId: number, newPassword: string) {
    return await firstValueFrom(this.http.patch<{ success: boolean }>(
      `${this.apiUrl}/users/${userId}/reset-password`,
      { newPassword },
      { headers: this.authHeaders() }
    ));
  }

  async adminToggleUserEnabled(userId: number, enabled: boolean) {
    return await firstValueFrom(this.http.patch<UserI>(
      `${this.apiUrl}/users/${userId}/toggle-enabled`,
      { enabled },
      { headers: this.authHeaders() }
    ));
  }

  async getRegistrationSettings() {
    return await firstValueFrom(this.http.get<{ selfRegistrationEnabled: boolean, requireApproval: boolean }>(
      `${this.apiUrl}/settings/registration`
    ));
  }

  async saveRegistrationSettings(settings: { selfRegistrationEnabled?: boolean, requireApproval?: boolean }) {
    return await firstValueFrom(this.http.patch<{ selfRegistrationEnabled: boolean, requireApproval: boolean }>(
      `${this.apiUrl}/settings/registration`,
      settings,
      { headers: this.authHeaders() }
    ));
  }

  async register(username: string, displayName: string, email: string, password: string) {
    return await firstValueFrom(this.http.post<{ success: boolean, needsApproval: boolean, message: string }>(
      `${this.apiUrl}/auth/register`,
      { username, displayName, email, password }
    ));
  }

  async restoreFromBackup(file: File) {
    const formData = new FormData();
    formData.append('backup', file);
    return await firstValueFrom(this.http.post<{ success: boolean }>(`${this.apiUrl}/setup/restore`, formData));
  }


  async getBackupStatus() {
    return await firstValueFrom(this.http.get<{ 
      schedule: string, 
      backupTime: string, 
      lastAutomatedAt: string | null, 
      lastManualAt: string | null, 
      keepCount?: number,
      totalSize?: number,
      files: any[]
    }>(
      `${this.apiUrl}/admin/backup/status`,
      { headers: this.authHeaders() }
    ));
  }


  async getTrashRetention(): Promise<number> {
    return (await firstValueFrom(this.http.get<{ days: number }>(`${this.apiUrl}/trash-retention`, { headers: this.authHeaders() }))).days;
  }

  async saveTrashRetention(days: number): Promise<number> {
    return (await firstValueFrom(this.http.put<{ days: number }>(`${this.apiUrl}/trash-retention`, { days }, { headers: this.authHeaders() }))).days;
  }

  async saveBackupSchedule(schedule: string, backupTime?: string, keepCount?: number) {
    return await firstValueFrom(this.http.post<{ success: boolean, schedule: string, backupTime: string, keepCount?: number }>(
      `${this.apiUrl}/admin/backup/schedule`,
      { schedule, backupTime, keepCount },
      { headers: this.authHeaders() }
    ));
  }


  async runBackupNow() {
    return await firstValueFrom(this.http.post<{ success: boolean, filename: string }>(
      `${this.apiUrl}/admin/backup/now`,
      {},
      { headers: this.authHeaders() }
    ));
  }

  async deleteBackup(filename: string) {
    await firstValueFrom(this.http.delete(`${this.apiUrl}/admin/backup/${filename}`, { headers: this.authHeaders() }));
  }

  async disableUser2fa(userId: number) {
    return await firstValueFrom(this.http.post<{ success: boolean }>(
      `${this.apiUrl}/admin/users/${userId}/disable-2fa`,
      {},
      { headers: this.authHeaders() }
    ));
  }


  /** Downloads a backup with the Authorization header (session tokens are not accepted in URLs). */
  async downloadBackup(filename: string) {
    const blob = await firstValueFrom(this.http.get(
      `${this.apiUrl}/admin/backup/download/${encodeURIComponent(filename)}`,
      { headers: this.authHeaders(), responseType: 'blob' }
    ));
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }


  private applyTheme(theme: UserTheme) {
    document.body.classList.toggle('light-theme', theme === 'light');
  }

  private getStoredSession() {
    const stored = localStorage.getItem(this.sessionKey);
    if (!stored) return null;

    try {
      return JSON.parse(stored) as AuthSessionI;
    } catch {
      localStorage.removeItem(this.sessionKey);
      return null;
    }
  }
}
