#!/usr/bin/env node
import { Command } from 'commander';
import { resolve, findProfile } from './resolve.js';
import { validate } from './oracle.js';
import { loadProfiles, userProfileDir } from './loader.js';
import { download } from './download.js';
import { discoverProfile, healProfile } from './ai/discover.js';
import { ModelConfigError } from './ai/model.js';
import { startStdioServer } from './mcp.js';
import { NoStreamError, DrmError } from './types.js';
import { VERSION } from './version.js';
import type { DiscoverResult } from './ai/discover.js';

const note = (msg: string) => process.stderr.write(msg + '\n');

function reportDiscovery(result: DiscoverResult): void {
  for (const r of result.rounds) {
    note(`  ${r.ok ? 'PASS' : 'fail'}  [${r.source}] ${r.reason} | ${r.detail}`);
  }
  if (result.ok && result.profile) {
    note(`\nLearned profile "${result.profile.id}".`);
    if (result.savedTo) note(`Saved to ${result.savedTo}`);
    process.stdout.write(JSON.stringify(result.profile, null, 2) + '\n');
  } else {
    note('\nCould not learn a working profile for this URL.');
  }
}

const program = new Command();

program
  .name('zahori')
  .description('Find the media stream behind any web page. Works on any URL; no config required.')
  .version(VERSION);

program
  .command('get')
  .description('Resolve the stream URL behind a page URL')
  .argument('<url>', 'the page containing the player')
  .option('--json', 'print the full result as JSON')
  .option('--download <file>', 'download the stream to a file (needs ffmpeg)')
  .option('--audio <file>', 'download audio only to a file (needs ffmpeg)')
  .option('--validate', 'check the stream is real media with the ffmpeg oracle')
  .option('--profile <id>', 'force a specific saved profile id')
  .option('--lang <code>', 'preferred audio language for multilingual streams (e.g. es, en)')
  .option('--headful', 'show the browser window')
  .option('--timeout <ms>', 'page timeout in ms', (v) => parseInt(v, 10))
  .action(async (url, opts) => {
    try {
      const result = await resolve(url, {
        profileId: opts.profile,
        headful: !!opts.headful,
        timeoutMs: opts.timeout,
        audioLanguage: opts.lang,
      });

      if (result.audio) {
        process.stderr.write(
          `audio: ${result.audio.name} (${result.audio.language || 'unlabeled'}) [${result.audio.matchedBy}]\n`,
        );
      }

      if (opts.validate) {
        const v = await validate(result);
        process.stderr.write(`validate: ${v.verdict} (${v.reason})\n`);
      }

      if (opts.download) {
        await download(result, opts.download);
        process.stderr.write(`downloaded → ${opts.download}\n`);
      } else if (opts.audio) {
        await download(result, opts.audio, { audioOnly: true });
        process.stderr.write(`audio → ${opts.audio}\n`);
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        process.stdout.write(result.url + '\n');
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command('discover')
  .description('Learn a profile for a new site (deterministic first, then a BYO-key model)')
  .argument('<url>', 'the page containing the player')
  .option('--model <spec>', 'model to use (e.g. anthropic:claude-sonnet-5, openai:gpt-5.4, ollama:llama3.1)')
  .option('--rounds <n>', 'max model attempts', (v) => parseInt(v, 10))
  .option('--no-save', "don't save the learned profile")
  .option('--global', 'save to ~/.zahori instead of the project')
  .option('--headful', 'show the browser window')
  .action(async (url, opts) => {
    try {
      const result = await discoverProfile(url, {
        model: opts.model,
        maxRounds: opts.rounds,
        headful: !!opts.headful,
        save: opts.save === false ? false : opts.global ? userProfileDir() : true,
        onProgress: note,
      });
      reportDiscovery(result);
      if (!result.ok) process.exit(1);
    } catch (e) {
      fail(e);
    }
  });

program
  .command('heal')
  .description('Repair a saved profile that stopped working')
  .argument('<url>', 'the page the profile targets')
  .option('--profile <id>', 'the profile id to repair (default: whichever matches the URL)')
  .option('--model <spec>', 'model to use')
  .option('--rounds <n>', 'max model attempts', (v) => parseInt(v, 10))
  .option('--no-save', "don't overwrite the profile")
  .option('--headful', 'show the browser window')
  .action(async (url, opts) => {
    try {
      const profiles = await loadProfiles();
      const broken = opts.profile
        ? profiles.find((p) => p.id === opts.profile)
        : await findProfile(url);
      if (!broken) {
        note(
          opts.profile
            ? `No saved profile with id "${opts.profile}".`
            : `No saved profile matches ${url}. Run \`zahori discover\` to learn one.`,
        );
        process.exit(1);
      }
      const result = await healProfile(broken, url, {
        model: opts.model,
        maxRounds: opts.rounds,
        headful: !!opts.headful,
        save: opts.save === false ? false : true,
        onProgress: note,
      });
      reportDiscovery(result);
      if (!result.ok) process.exit(1);
    } catch (e) {
      fail(e);
    }
  });

program
  .command('mcp')
  .description('Start the zahori MCP server on stdio (for Claude Code, Cursor, Codex, etc.)')
  .action(async () => {
    await startStdioServer();
  });

program
  .command('profiles')
  .description('List profiles saved on this machine')
  .action(async () => {
    const profiles = await loadProfiles();
    if (!profiles.length) {
      process.stdout.write('No saved profiles. zahori uses its built-in generic flow for every URL.\n');
      return;
    }
    for (const p of profiles) {
      process.stdout.write(`${p.id.padEnd(20)} ${p.name || ''}\n`);
    }
  });

function fail(e: unknown): never {
  const err = e as Error;
  if (err instanceof ModelConfigError) {
    process.stderr.write(`${err.message}\n`);
  } else if (err instanceof NoStreamError) {
    process.stderr.write(
      `Couldn't find a stream on that page.\n` +
        `The player may load media in a way the generic flow misses, or the page needs a login.\n`,
    );
  } else if (err instanceof DrmError) {
    process.stderr.write(`${err.message}\nzahori only handles public, unprotected streams.\n`);
  } else {
    process.stderr.write(`Error: ${err.message}\n`);
  }
  process.exit(1);
}

program.parseAsync();
