import { describe, expect, it } from 'vitest';
import { hostPattern, profileIdFromUrl } from '../src/discover.js';
import { profileMatches, parseProfile } from '../src/profile.js';

function matches(pattern: string, url: string): boolean {
  return profileMatches(parseProfile({ id: 't', match: [pattern] }), url);
}

describe('hostPattern', () => {
  it('matches the host itself, with and without www', () => {
    const p = hostPattern('https://www.acme.example/watch/1');
    expect(matches(p, 'https://acme.example/live')).toBe(true);
    expect(matches(p, 'https://www.acme.example/live')).toBe(true);
    expect(matches(p, 'http://acme.example')).toBe(true);
  });

  it('matches subdomains and ports', () => {
    const p = hostPattern('https://acme.example/');
    expect(matches(p, 'https://video.acme.example/embed')).toBe(true);
    expect(matches(p, 'https://acme.example:8443/live')).toBe(true);
  });

  it('does NOT match the host appearing elsewhere in a URL', () => {
    const p = hostPattern('https://acme.example/');
    expect(matches(p, 'https://evil.example/?ref=acme.example')).toBe(false);
    expect(matches(p, 'https://acme.example.evil.example/live')).toBe(false);
    expect(matches(p, 'https://notacme.example/live')).toBe(false);
  });

  it('escapes regex metacharacters in the host', () => {
    const p = hostPattern('https://a-b.acme.example/');
    expect(matches(p, 'https://a-b.acme.example/x')).toBe(true);
    expect(matches(p, 'https://aXbXacmeXexample/x')).toBe(false);
  });
});

describe('profileIdFromUrl', () => {
  it('derives a stable slug from the hostname', () => {
    expect(profileIdFromUrl('https://www.tv.example.org/session/9')).toBe('tv-example-org');
  });

  it('falls back to "site" for garbage input', () => {
    expect(profileIdFromUrl('///')).toBe('site');
  });
});
