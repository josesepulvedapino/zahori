import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProfile } from '../src/resolve.js';
import { loadProfiles } from '../src/loader.js';

async function tempProfileDir(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'zahori-test-'));
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

describe('findProfile', () => {
  it('returns undefined when no saved profile matches (engine falls back to generic)', async () => {
    const dir = await tempProfileDir({});
    expect(await findProfile('https://anything.example/watch', { profileDirs: [dir] })).toBeUndefined();
  });

  it('matches a saved profile by URL pattern', async () => {
    const dir = await tempProfileDir({
      'acme.json': { id: 'acme', match: ['acme\\.example'] },
    });
    const p = await findProfile('https://video.acme.example/live', { profileDirs: [dir] });
    expect(p?.id).toBe('acme');
  });

  it('prefers the highest-priority matching profile', async () => {
    const dir = await tempProfileDir({
      'broad.json': { id: 'broad', match: ['example'], priority: -50 },
      'exact.json': { id: 'exact', match: ['video\\.acme\\.example'], priority: 10 },
    });
    const p = await findProfile('https://video.acme.example/live', { profileDirs: [dir] });
    expect(p?.id).toBe('exact');
  });

  it('throws when a forced profile id does not exist', async () => {
    const dir = await tempProfileDir({});
    await expect(findProfile('https://x.example/', { profileId: 'missing', profileDirs: [dir] })).rejects.toThrow(
      /missing/,
    );
  });
});

describe('loadProfiles', () => {
  it('lets a later directory override an earlier one by id', async () => {
    const a = await tempProfileDir({ 'acme.json': { id: 'acme', name: 'First', match: ['acme'] } });
    const b = await tempProfileDir({ 'acme.json': { id: 'acme', name: 'Second', match: ['acme'] } });
    const profiles = await loadProfiles([a, b]);
    expect(profiles.filter((p) => p.id === 'acme')).toHaveLength(1);
    expect(profiles.find((p) => p.id === 'acme')?.name).toBe('Second');
  });

  it('skips invalid profile files without crashing', async () => {
    const dir = await tempProfileDir({
      'broken.json': '{ not json',
      'incomplete.json': { id: 'no-match-array' },
      'good.json': { id: 'good', match: ['good\\.example'] },
    });
    const profiles = await loadProfiles([dir]);
    expect(profiles.map((p) => p.id)).toEqual(['good']);
  });
});
