import { chromium, type Browser, type BrowserContext } from 'playwright';

/**
 * Launch the browser. The default (invisible) mode must never put anything on
 * the user's screen, so it runs Playwright's headless shell — a Chromium build
 * with no window code at all. Real Chrome's --headless=new can flash a blank
 * borderless frame on Windows, which reads as malware to end users; it is kept
 * only as a fallback (parked far off-screen) and for headful debugging, where
 * showing the browser is the point.
 */
export async function launchBrowser(headful: boolean): Promise<Browser> {
  const args = [
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    // Ad-laden stream sites fire popunders the moment we click play. Refuse
    // every renderer-initiated window/tab at the browser level so nothing a
    // page does can ever surface a window the user didn't ask for.
    '--block-new-web-contents',
  ];
  if (headful) {
    // Debug mode: prefer the real Chrome channel (harder to fingerprint).
    try {
      return await chromium.launch({ channel: 'chrome', headless: false, args });
    } catch {
      return await chromium.launch({ headless: false, args });
    }
  }
  try {
    return await chromium.launch({ headless: true, args });
  } catch {
    return await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: [...args, '--window-position=-32000,-32000'],
    });
  }
}

/**
 * A UA built from the running browser's real major version and the host OS, so
 * it matches what the browser actually sends elsewhere and never goes stale.
 */
function realisticUserAgent(browser: Browser): string {
  const major = browser.version().split('.')[0] || '131';
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'linux'
        ? 'X11; Linux x86_64'
        : 'Windows NT 10.0; Win64; x64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** A fresh context with a real UA and the most obvious headless tell removed. */
export async function newBrowserContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    userAgent: realisticUserAgent(browser),
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  // Backstop to --block-new-web-contents: if a popup slips through anyway,
  // close it before it renders. Pages we open ourselves have no opener, so
  // this only ever reaps windows spawned by page content.
  ctx.on('page', (page) => {
    void page
      .opener()
      .then((opener) => (opener ? page.close() : undefined))
      .catch(() => {});
  });
  return ctx;
}
