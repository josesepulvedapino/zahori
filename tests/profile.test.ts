import { describe, expect, it } from 'vitest';
import { parseProfile, profileMatches, GENERIC_PROFILE } from '../src/profile.js';

describe('parseProfile', () => {
  it('fills defaults for a minimal profile', () => {
    const p = parseProfile({ id: 'x', match: ['example\\.com'] });
    expect(p.v).toBe(1);
    expect(p.priority).toBe(0);
    expect(p.steps).toEqual([]);
    expect(p.sniff.kinds).toEqual(['hls', 'dash', 'mp4']);
    expect(p.sniff.replayHeaders).toContain('referer');
    expect(p.pick.variant).toBe('master');
    expect(p.pick.order).toBe('first');
    expect(p.pick.languageMap).toEqual({});
    expect(p.pick.audioLanguageFallbacks).toEqual([]);
  });

  it('accepts audio language rules', () => {
    const p = parseProfile({
      id: 'x',
      match: ['a'],
      pick: { audioLanguage: 'es', languageMap: { es: 'zza' }, audioLanguageFallbacks: ['en'] },
    });
    expect(p.pick.audioLanguage).toBe('es');
    expect(p.pick.languageMap).toEqual({ es: 'zza' });
    expect(p.pick.audioLanguageFallbacks).toEqual(['en']);
  });

  it('rejects a profile without match patterns', () => {
    expect(() => parseProfile({ id: 'x', match: [] })).toThrow();
  });

  it('rejects unknown step actions', () => {
    expect(() => parseProfile({ id: 'x', match: ['a'], steps: [{ action: 'teleport' }] })).toThrow();
  });
});

describe('profileMatches', () => {
  const profile = parseProfile({ id: 'x', match: ['example\\.com', 'example\\.org'] });

  it('matches any of the patterns, case-insensitive', () => {
    expect(profileMatches(profile, 'https://www.Example.com/video/1')).toBe(true);
    expect(profileMatches(profile, 'https://media.example.org/watch')).toBe(true);
    expect(profileMatches(profile, 'https://other.net/')).toBe(false);
  });

  it('treats an invalid pattern as non-matching instead of crashing', () => {
    const bad = parseProfile({ id: 'x', match: ['('] });
    expect(profileMatches(bad, 'https://example.com/')).toBe(false);
  });
});

describe('GENERIC_PROFILE', () => {
  it('matches any http(s) URL with the lowest priority', () => {
    expect(GENERIC_PROFILE.id).toBe('generic');
    expect(GENERIC_PROFILE.priority).toBeLessThan(0);
    expect(profileMatches(GENERIC_PROFILE, 'https://anything.example/watch')).toBe(true);
    expect(profileMatches(GENERIC_PROFILE, 'ftp://nope/')).toBe(false);
  });
});
