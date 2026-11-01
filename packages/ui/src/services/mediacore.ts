/**
 * MediaCore account: metadata through the account's server.
 *
 * Signing in with a MediaCore (Dragon's Nest) account replaces the need for a
 * personal TMDB key. When no key is entered, the TMDB token handed to the rest
 * of the app is the MEDIACORE_TMDB_TOKEN marker; installMediaCoreTmdbProxy()
 * catches TMDB requests that carry it and sends them to the account server's
 * read-only TMDB proxy (/v1/metadata/tmdb/*) with the account's access token.
 * A personally entered TMDB key still goes straight to TMDB.
 *
 * The session itself (login, refresh, logout, refresh-token storage) lives in
 * Rust (src-tauri/src/mediacore.rs); this module only ever holds the
 * short-lived access token.
 */

import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { create } from 'zustand';
import { useSettingsStore } from '../stores/settingsStore';

/** Stand-in TMDB token meaning "use the MediaCore account". Never sent to TMDB. */
export const MEDIACORE_TMDB_TOKEN = 'mediacore-account';

const TMDB_API_PREFIX = 'https://api.themoviedb.org/3/';

export interface MediaCoreUser {
  id: string;
  username: string;
  email?: string;
  displayName?: string | null;
  role?: string;
}

interface SessionView {
  user: MediaCoreUser;
  accessToken: string;
  baseUrl: string;
  expiresInSeconds: number;
}

interface MediaCoreState {
  /** False until the saved session has been checked once at startup. */
  ready: boolean;
  user: MediaCoreUser | null;
}

export const useMediaCoreStore = create<MediaCoreState>(() => ({ ready: false, user: null }));

let cached: (SessionView & { expiresAt: number }) | null = null;
let inflight: Promise<SessionView | null> | null = null;

function remember(view: SessionView | null): SessionView | null {
  cached = view ? { ...view, expiresAt: Date.now() + view.expiresInSeconds * 1000 } : null;
  useMediaCoreStore.setState({ ready: true, user: view?.user ?? null });
  return view;
}

/**
 * The current session (refreshed by Rust when its access token is nearly
 * expired), or null when signed out. Concurrent callers share one request.
 */
export async function getMediaCoreSession(forceRefresh = false): Promise<SessionView | null> {
  if (!forceRefresh && cached && cached.expiresAt - Date.now() > 60_000) return cached;
  if (!inflight) {
    inflight = invoke<SessionView | null>('mediacore_session', { forceRefresh })
      .then(remember)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export async function signInToMediaCore(identifier: string, password: string): Promise<MediaCoreUser> {
  const view = await invoke<SessionView>('mediacore_login', { identifier, password });
  remember(view);
  window.dispatchEvent(new CustomEvent('ynotv:tmdb-key-changed'));
  return view.user;
}

export async function signOutOfMediaCore(): Promise<void> {
  await invoke('mediacore_logout');
  remember(null);
  window.dispatchEvent(new CustomEvent('ynotv:tmdb-key-changed'));
}

/** The TMDB token to use: a personal key wins, else the MediaCore marker when signed in. */
export function resolveTmdbToken(personalKey: string | null | undefined, signedIn: boolean): string | null {
  const key = personalKey?.trim();
  if (key) return key;
  return signedIn ? MEDIACORE_TMDB_TOKEN : null;
}

/** Non-hook form of useTmdbAccessToken, for services and event handlers. */
export function getActiveTmdbToken(): string | null {
  return resolveTmdbToken(
    useSettingsStore.getState().tmdbApiKey,
    useMediaCoreStore.getState().user !== null,
  );
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function carriesMarker(url: string, headers: Headers): boolean {
  if (headers.get('authorization') === `Bearer ${MEDIACORE_TMDB_TOKEN}`) return true;
  try {
    return new URL(url).searchParams.get('api_key') === MEDIACORE_TMDB_TOKEN;
  } catch {
    return false;
  }
}

/** Map a TMDB v3 URL onto the account server's proxy, minus any api_key. */
export function proxiedTmdbUrl(tmdbUrl: string, baseUrl: string): string {
  const url = new URL(tmdbUrl);
  url.searchParams.delete('api_key');
  const path = url.pathname.replace(/^\/3\//, '');
  const query = url.searchParams.toString();
  return `${baseUrl}/v1/metadata/tmdb/${path}${query ? `?${query}` : ''}`;
}

function signedOutResponse(): Response {
  return new Response(
    JSON.stringify({ status_code: 7, status_message: 'Sign in to MediaCore to load metadata.' }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * Route TMDB requests carrying the MediaCore marker through the account
 * server. Covers tmdb-ts (Bearer header) and the direct fetches (api_key query
 * or Bearer header) without touching each call site.
 */
export function installMediaCoreTmdbProxy(): void {
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (!url.startsWith(TMDB_API_PREFIX)) return originalFetch(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!carriesMarker(url, headers)) return originalFetch(input, init);

    const send = async (session: SessionView) => {
      headers.set('authorization', `Bearer ${session.accessToken}`);
      // Rust-side HTTP: the account server doesn't serve CORS to the app's origin.
      return tauriFetch(proxiedTmdbUrl(url, session.baseUrl), {
        method: 'GET',
        headers,
        signal: init?.signal ?? undefined,
      });
    };

    let session = await getMediaCoreSession().catch(() => null);
    if (!session) return signedOutResponse();
    let response = await send(session);
    if (response.status === 401) {
      // Access token revoked or expired early: refresh once and retry.
      session = await getMediaCoreSession(true).catch(() => null);
      if (!session) return signedOutResponse();
      response = await send(session);
    }
    return response;
  };

  // Learn at startup whether a saved session exists, so the TMDB-backed rows
  // know they can load.
  getMediaCoreSession().catch(() => remember(null));
}
