import { createRequire } from 'node:module';

/**
 * The package version, read from package.json at runtime so it has exactly one
 * source of truth. Works from both src/ (tests) and dist/ (published build):
 * each sits one level below the package root.
 */
export const VERSION: string = createRequire(import.meta.url)('../package.json').version;
