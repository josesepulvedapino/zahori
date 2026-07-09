import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve } from './resolve.js';
import { probe, testProfile, saveProfile, defaultSaveDir, profileIdFromUrl, hostPattern } from './discover.js';
import { VERSION } from './version.js';
import { validate } from './oracle.js';
import { loadProfiles } from './loader.js';
import { parseProfile } from './profile.js';

/**
 * zahori as an MCP server. This is the agent-native path: a coding agent
 * (Claude Code, Cursor, Codex) connects over stdio and drives the same
 * discovery primitives with its own model, no API key, using the user's
 * existing subscription. The agent probes a site, proposes a profile, tests it
 * against the oracle, and saves it when it passes.
 *
 * The engine stays deterministic: these tools execute and verify; the agent
 * supplies the intelligence.
 */

const textResult = (data: unknown) => ({
  content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});

const errorResult = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true,
});

// The shape a profile takes when an agent authors one. Mirrors the Profile
// schema's editable parts; ids/match are filled in by the tool when omitted.
const profileInput = {
  id: z.string().optional().describe('Stable id; defaults to the URL hostname.'),
  name: z.string().optional(),
  match: z.array(z.string()).optional().describe('URL regex patterns; defaults to the hostname.'),
  steps: z.array(z.any()).optional().describe('Ordered page actions (goto/dismissOverlays/play/click/waitFor/scroll/eval).'),
  sniff: z.record(z.any()).optional().describe('kinds/urlPattern/urlExclude/replayHeaders.'),
  pick: z.record(z.any()).optional().describe('variant/order/audioLanguage/languageMap/audioLanguageFallbacks.'),
  notes: z.string().optional(),
};

function buildProfile(url: string, input: Record<string, unknown>) {
  const id = (input.id as string) || profileIdFromUrl(url);
  let match = input.match as string[] | undefined;
  if (!match || match.length === 0) {
    match = [hostPattern(url)];
  }
  return parseProfile({
    id,
    name: input.name ?? id,
    match,
    steps: input.steps ?? [],
    sniff: input.sniff ?? {},
    pick: input.pick ?? {},
    ...(input.notes ? { notes: input.notes } : {}),
  });
}

/**
 * Sent to every client during the protocol handshake, so any agent, whatever
 * the vendor, receives the workflow without needing the README.
 */
const INSTRUCTIONS = `zahori finds the media stream (HLS/DASH/MP4/audio) behind a web page and returns its URL plus the headers needed to replay it.

Fast path: call zahori_get with the page URL. If it returns a stream, you are done.

Learning a tricky site:
1. zahori_probe the URL: it reports media requests seen, iframes, and play/consent elements.
2. Author a profile with steps that trigger playback (goto/dismissOverlays/play/click/waitFor), sniff rules that recognize the media request (kinds/urlPattern/urlExclude), and pick rules. Then run zahori_test_profile. Iterate until ok=true.
3. zahori_save_profile so every later run on that site is instant and deterministic.

Rules: profiles must re-derive the stream through page actions, never hardcoding a signed/expiring media URL. DRM-protected content is always refused. Prefer the smallest profile that passes.`;

export function createServer(): McpServer {
  const server = new McpServer({ name: 'zahori', version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'zahori_get',
    {
      title: 'Resolve a stream',
      description:
        'Resolve the media stream behind a page URL using saved profiles or the built-in generic flow. Returns the stream URL, kind, live/VOD, and replay headers.',
      inputSchema: {
        url: z.string().describe('The page containing the player.'),
        lang: z.string().optional().describe('Preferred audio language for multilingual streams (e.g. es).'),
      },
    },
    async ({ url, lang }) => {
      try {
        const result = await resolve(url, lang ? { audioLanguage: lang } : {});
        return textResult(result);
      } catch (e) {
        return errorResult(`get failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'zahori_probe',
    {
      title: 'Probe a page',
      description:
        'Open a page and gather everything needed to author a profile: media requests seen, iframes, play/consent elements, and whether the generic flow already works. Use this before proposing a profile for a new site.',
      inputSchema: { url: z.string() },
    },
    async ({ url }) => {
      try {
        return textResult(await probe(url));
      } catch (e) {
        return errorResult(`probe failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'zahori_test_profile',
    {
      title: 'Test a candidate profile',
      description:
        'Run a candidate profile against a URL and grade the result with the oracle. ok=true only when a stream was captured AND the oracle confirms it is real media. Iterate on the profile until this passes.',
      inputSchema: { url: z.string(), profile: z.object(profileInput) },
    },
    async ({ url, profile }) => {
      try {
        const built = buildProfile(url, profile);
        const test = await testProfile(built, url);
        return textResult({ ...test, profile: built });
      } catch (e) {
        return errorResult(`test failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'zahori_save_profile',
    {
      title: 'Save a working profile',
      description:
        'Persist a profile so later runs are instant and free. Saves to the project (.zahori/profiles, committable) by default so it travels to production and teammates.',
      inputSchema: {
        url: z.string(),
        profile: z.object(profileInput),
        global: z.boolean().optional().describe('Save to the user-global dir instead of the project.'),
      },
    },
    async ({ url, profile, global }) => {
      try {
        const built = buildProfile(url, profile);
        const dir = defaultSaveDir({ project: !global });
        const path = await saveProfile(built, dir);
        return textResult({ saved: path, id: built.id });
      } catch (e) {
        return errorResult(`save failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'zahori_validate',
    {
      title: 'Validate a stream URL',
      description: 'Run the oracle on a resolved stream (url + headers) to check it is real media (decodes, has real audio, plausible length).',
      inputSchema: {
        url: z.string(),
        kind: z.enum(['hls', 'dash', 'mp4', 'audio']).optional(),
        headers: z.record(z.string()).optional(),
      },
    },
    async ({ url, kind, headers }) => {
      try {
        const verdict = await validate({
          url,
          kind: kind ?? 'hls',
          live: undefined,
          headers: headers ?? {},
          profileId: 'ad-hoc',
          candidates: [url],
        });
        return textResult(verdict);
      } catch (e) {
        return errorResult(`validate failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'zahori_list_profiles',
    {
      title: 'List saved profiles',
      description: 'List the profiles saved on this machine and in the current project.',
      inputSchema: {},
    },
    async () => {
      const profiles = await loadProfiles();
      return textResult(profiles.map((p) => ({ id: p.id, name: p.name, match: p.match })));
    },
  );

  return server;
}

/** Start the MCP server on stdio (how coding agents launch it). */
export async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
