import { spawn } from 'node:child_process';
import type { StreamResult } from './types.js';

function headerArgs(headers: Record<string, string>): string[] {
  const lines = Object.entries(headers)
    .filter(([k]) => k.toLowerCase() !== 'user-agent')
    .map(([k, v]) => `${k}: ${v}`);
  const args: string[] = [];
  const ua = headers['user-agent'] ?? headers['User-Agent'];
  if (ua) args.push('-user_agent', ua);
  if (lines.length) args.push('-headers', lines.join('\r\n') + '\r\n');
  return args;
}

/**
 * Download a resolved stream to a file with ffmpeg, replaying the captured
 * headers. audioOnly extracts the audio track (handy for transcription).
 * For live streams this records until the stream ends or the process is stopped.
 */
export async function download(
  stream: StreamResult,
  outPath: string,
  opts: { audioOnly?: boolean; ffmpegPath?: string } = {},
): Promise<void> {
  const ffmpeg = opts.ffmpegPath ?? 'ffmpeg';
  const args = [
    '-hide_banner',
    ...headerArgs(stream.headers),
    '-i',
    stream.url,
    ...(opts.audioOnly ? ['-vn', '-acodec', 'copy'] : ['-c', 'copy']),
    '-y',
    outPath,
  ];

  await new Promise<void>((resolveDl, reject) => {
    // windowsHide: never flash a console window when run from a GUI/cron context.
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolveDl() : reject(new Error(`ffmpeg exited with code ${code}`))));
  });
}
