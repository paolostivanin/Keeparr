// See environment.ts for the rationale behind window.KEEPARR_API_URL.
declare const window: Window & { KEEPARR_API_URL?: string };
const runtimeApiBase = (typeof window !== 'undefined' && typeof window.KEEPARR_API_URL === 'string')
  ? window.KEEPARR_API_URL.replace(/\/$/, '')
  : '';

export const environment = {
  production: true,
  apiUrl: runtimeApiBase ? `${runtimeApiBase}/api` : '/api'
};
