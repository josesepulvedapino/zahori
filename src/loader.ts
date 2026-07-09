import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseProfile, type Profile } from './profile.js';

/**
 * Profiles live on the user's machine, never in the package: zahori ships no
 * site knowledge. discover/heal write here after solving a site once.
 * Directories are searched in ascending priority (later wins on id clash).
 */
export function profileSearchDirs(extra: string[] = []): string[] {
  const dirs = [
    join(homedir(), '.zahori', 'profiles'), // user global
    join(process.cwd(), '.zahori', 'profiles'), // project-local
    ...extra,
  ];
  return dirs.filter((d) => existsSync(d));
}

async function loadDir(dir: string): Promise<Profile[]> {
  const out: Profile[] = [];
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(join(dir, entry), 'utf8'));
      out.push(parseProfile(raw));
    } catch (e) {
      process.stderr.write(`zahori: skipping invalid profile ${entry}: ${(e as Error).message}\n`);
    }
  }
  return out;
}

/** Load all saved profiles; later dirs override earlier ones by id. */
export async function loadProfiles(extraDirs: string[] = []): Promise<Profile[]> {
  const byId = new Map<string, Profile>();
  for (const dir of profileSearchDirs(extraDirs)) {
    for (const p of await loadDir(dir)) byId.set(p.id, p);
  }
  return [...byId.values()];
}

/** Absolute path of the user-global profiles directory (where discover/heal save). */
export function userProfileDir(): string {
  return join(homedir(), '.zahori', 'profiles');
}
