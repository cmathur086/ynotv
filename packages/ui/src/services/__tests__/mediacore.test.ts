import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));

import { MEDIACORE_TMDB_TOKEN, proxiedTmdbUrl, resolveTmdbToken } from '../mediacore';

describe('MediaCore TMDB routing', () => {
  it('prefers a personal TMDB key over the MediaCore account', () => {
    expect(resolveTmdbToken('personal-key', true)).toBe('personal-key');
    expect(resolveTmdbToken('  ', true)).toBe(MEDIACORE_TMDB_TOKEN);
    expect(resolveTmdbToken('', false)).toBeNull();
    expect(resolveTmdbToken(null, false)).toBeNull();
  });

  it('maps TMDB v3 URLs onto the account server proxy without the api_key', () => {
    expect(
      proxiedTmdbUrl(
        `https://api.themoviedb.org/3/tv/1399/season/1?api_key=${MEDIACORE_TMDB_TOKEN}&language=en-US`,
        'https://sync.example.com',
      ),
    ).toBe('https://sync.example.com/v1/metadata/tmdb/tv/1399/season/1?language=en-US');
    expect(proxiedTmdbUrl('https://api.themoviedb.org/3/configuration', 'https://sync.example.com')).toBe(
      'https://sync.example.com/v1/metadata/tmdb/configuration',
    );
  });
});
