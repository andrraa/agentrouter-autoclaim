import { chromium, type BrowserContext } from 'playwright';
import { parseCookieString, serializeCookieMap, mergeSetCookies, captureGithubCookies } from '../src/cookies';

const CANDIDATE_URLS = ['https://agentrouter.org', 'https://ps.air-outer.com'];
const CLIENT_ID = 'Ov23lidtiR4LeVZvVRNL';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/+$/, '');
const ACCESS_CODE = process.env.ACCESS_CODE || '';

if (!WORKER_URL || !ACCESS_CODE) {
  console.error('Error: WORKER_URL and ACCESS_CODE environment variables are required.');
  process.exit(1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Only allowlisted metadata: never response bodies, error messages or OAuth query strings.
function debug(stage: string, details: Record<string, unknown> = {}) {
  console.log(`[debug] ${stage} ${JSON.stringify(details)}`);
}

function safeEndpoint(value: string, base = 'https://github.com') {
  try {
    const url = new URL(value, base);
    const paths = ['/login', '/session', '/login/oauth/authorize', '/api/oauth/state', '/api/oauth/github', '/api/user/self', '/console', '/'];
    return `${url.origin}${paths.includes(url.pathname) ? url.pathname : '/[other]'}`;
  } catch { return '[invalid URL]'; }
}

function traceResponse(stage: string, response: Response) {
  debug(stage, {
    status: response.status,
    redirect: response.headers.get('location') ? safeEndpoint(response.headers.get('location')!) : null,
    json: response.headers.get('content-type')?.includes('application/json') || false,
    setCookies: response.headers.getSetCookie().map((header) => header.split('=')[0])
  });
}

interface ClaimResult {
  message: string;
}

function githubCookies(header: string) {
  return [...parseCookieString(header)].map(([name, value]) => ({
    name, value, url: 'https://github.com/', secure: true
  }));
}

async function addGithubCookies(context: BrowserContext, header: string) {
  const cookies = githubCookies(header);
  if (!cookies.some((cookie) => cookie.name === 'user_session')) throw new Error('GitHub cookie must include user_session');
  await context.addCookies(cookies);
}

const GH_BROWSER_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchOAuthState(baseUrl: string, sessionCookies: Map<string, string>): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/oauth/state`, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        Referer: `${baseUrl}/login`,
        Origin: baseUrl,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    traceResponse('http.state', res);
    mergeSetCookies(sessionCookies, res);
    const text = await res.text();
    const json = JSON.parse(text);
    if (json && json.success && json.data) return String(json.data);
  } catch { debug('http.state.unavailable'); }
  return null;
}

async function pureHttpClaim(baseUrl: string, cookies: Map<string, string>, label: string): Promise<ClaimResult> {
  const sessionCookies = new Map<string, string>();
  const state = await fetchOAuthState(baseUrl, sessionCookies);
  if (!state) throw new Error(`Failed to obtain OAuth state from ${baseUrl}`);

  const authUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&state=${encodeURIComponent(state)}&scope=user:email`;
  const ghRes = await fetch(authUrl, {
    method: 'GET',
    headers: { ...GH_BROWSER_HEADERS, Cookie: serializeCookieMap(cookies), Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    redirect: 'manual'
  });

  traceResponse('http.github.authorize', ghRes);
  mergeSetCookies(cookies, ghRes);

  let code: string | null = null;
  const loc = ghRes.headers.get('location') || '';
  if ((ghRes.status === 301 || ghRes.status === 302) && loc) {
    if (loc.includes('/login')) throw new Error('GitHub cookie invalid or expired');
    try { code = new URL(loc, 'https://github.com').searchParams.get('code'); } catch { /* ignore */ }
  } else if (ghRes.status === 200) {
    const html = await ghRes.text();
    if (html.includes('id="login_field"') || html.includes('action="/session"')) throw new Error('GitHub cookie invalid or expired');
    const tokenMatch = html.match(/name=["']authenticity_token["']\s+value=["']([^"']+)["']/i);
    if (tokenMatch?.[1]) {
      const postRes = await fetch('https://github.com/login/oauth/authorize', {
        method: 'POST',
        headers: {
          ...GH_BROWSER_HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: serializeCookieMap(cookies),
          Origin: 'https://github.com',
          Referer: authUrl,
          'Sec-Fetch-Site': 'same-origin'
        },
        body: new URLSearchParams({ authenticity_token: tokenMatch[1], client_id: CLIENT_ID, state, scope: 'user:email', authorize: '1' }).toString(),
        redirect: 'manual'
      });

      traceResponse('http.github.consent', postRes);
      mergeSetCookies(cookies, postRes);

      const postLoc = postRes.headers.get('location') || '';
      try { code = new URL(postLoc, 'https://github.com').searchParams.get('code'); } catch { /* ignore */ }
    }
  }

  if (!code) throw new Error('Failed to obtain OAuth authorization code from GitHub');

  const cbRes = await fetch(`${baseUrl}/api/oauth/github?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*', Referer: `${baseUrl}/login`, Origin: baseUrl, Cookie: serializeCookieMap(sessionCookies) }
  });

  traceResponse('http.callback', cbRes);
  const body = await cbRes.json<{ success?: boolean; message?: string; data?: Record<string, any> }>().catch(() => null);

  if (body?.success && body.data) {
    const u = body.data.user || body.data;
    return { message: `Success (HTTP) · ${u.display_name || u.username || label}` };
  }
  if (body?.success === true) {
    return { message: `Success (HTTP) · ${label}` };
  }
  throw new Error(body?.message || `HTTP OAuth returned ${cbRes.status}`);
}

async function browserClaim(baseUrl: string, github: Map<string, string>, label: string): Promise<ClaimResult> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox']
  });

  let context: BrowserContext | undefined;
  let seeded = false;
  try {
    context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 720 },
      locale: 'en-US',
      timezoneId: 'Asia/Jakarta'
    });

    // Stealth: bypass navigator.webdriver detection
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await addGithubCookies(context, serializeCookieMap(github));
    seeded = true;
    const page = await context.newPage();

    // 1. Visit baseUrl/login to execute WAF challenge
    await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(3000);

    // 2. Fetch state inside browser page context (WAF cookies already set)
    let state: string | null = null;
    for (let i = 0; i < 5; i++) {
      try {
        const json = await page.evaluate(async (url) => {
          const r = await fetch(url, { headers: { accept: 'application/json, text/plain, */*' } });
          return r.json().catch(() => null);
        }, `${baseUrl}/api/oauth/state`) as { success?: boolean; data?: string } | null;

        if (json?.success && json.data) {
          state = String(json.data);
          break;
        }
      } catch {}
      await page.waitForTimeout(2000);
    }

    debug('browser.state', { endpoint: safeEndpoint(baseUrl), obtained: state !== null });
    if (!state) throw new Error(`Could not obtain OAuth state from ${baseUrl}`);

    // 3. Visit GitHub to ensure session is primed
    await page.goto('https://github.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (await page.locator('#login_field').count()) throw new Error('GitHub cookie is invalid or expired');

    // 4. Navigate to GitHub OAuth authorize
    const authUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&state=${encodeURIComponent(state)}&scope=user:email`;
    let cbResponse: import('playwright').Response | null = null;

    const [navResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/oauth/github'), { timeout: 45_000 }).catch(() => null),
      page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    ]);
    cbResponse = navResponse;

    if (new URL(page.url()).origin === 'https://github.com' && new URL(page.url()).pathname === '/login') {
      throw new Error('GitHub cookie is invalid or expired');
    }

    // 5. Click Authorize if consent button is displayed
    const authorize = page.getByRole('button', { name: /authorize/i }).first();
    if (await authorize.isVisible().catch(() => false)) {
      [cbResponse] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/oauth/github'), { timeout: 45_000 }).catch(() => null),
        authorize.click()
      ]);
    }

    if (!cbResponse) {
      cbResponse = await page.waitForResponse((r) => r.url().includes('/api/oauth/github'), { timeout: 15_000 }).catch(() => null);
    }

    await page.waitForTimeout(3000);

    debug('browser.callback', {
      page: safeEndpoint(page.url()),
      received: cbResponse !== null,
      status: cbResponse?.status() ?? null
    });
    const callbackBody = cbResponse?.url().includes('/api/oauth/github')
      ? await cbResponse.json().catch(() => null) as { success?: boolean; message?: string; data?: Record<string, any> } | null
      : null;

    debug('browser.callback.validation', { success: callbackBody?.success === true, hasData: !!callbackBody?.data });
    if (callbackBody?.success && callbackBody.data) {
      const u = callbackBody.data.user || callbackBody.data;
      return { message: `Success (GH Runner) · ${u.display_name || u.username || label}` };
    }

    // 6. Check if session cookie exists on baseUrl
    const cookies = await context.cookies(new URL(baseUrl).origin);
    const hasSession = cookies.some((c) => c.name === 'session');

    debug('browser.session', { present: hasSession });
    if (hasSession) {
      const userRes = await page.evaluate(async (url) => {
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        return res.json().catch(() => null);
      }, `${baseUrl}/api/user/self`).catch(() => null) as { success?: boolean; data?: Record<string, any> } | null;

      debug('browser.self', { success: userRes?.success === true, hasData: !!userRes?.data });
      if (userRes?.success && userRes.data) {
        const u = userRes.data;
        return { message: `Success (GH Runner) · ${u.display_name || u.username || label}` };
      }
    }

    throw new Error(callbackBody?.message || 'OAuth callback failed to authenticate with AgentRouter');
  } finally {
    try {
      if (context && seeded) {
        const before = serializeCookieMap(github);
        await captureGithubCookies(github, context);
        debug('browser.cookies', { changed: before !== serializeCookieMap(github), names: [...github.keys()] });
      }
    } finally { await browser.close(); }
  }
}

async function claimAccount(cookies: Map<string, string>, label: string): Promise<ClaimResult> {
  let lastErr = '';

  for (const baseUrl of CANDIDATE_URLS) {
    // 1. Try Pure HTTP first
    try {
      debug('http.start', { endpoint: safeEndpoint(baseUrl), hasSession: cookies.has('user_session') });
      return await pureHttpClaim(baseUrl, cookies, label);
    } catch (httpErr) {
      lastErr = httpErr instanceof Error ? httpErr.message : String(httpErr);
      debug('http.failed', { endpoint: safeEndpoint(baseUrl), loginRejected: lastErr === 'GitHub cookie invalid or expired' });
    }

    // 2. Fallback to Stealth Chromium Playwright
    try {
      debug('browser.start', { endpoint: safeEndpoint(baseUrl) });
      return await browserClaim(baseUrl, cookies, label);
    } catch (browserErr) {
      lastErr = browserErr instanceof Error ? browserErr.message : String(browserErr);
      debug('browser.failed', { endpoint: safeEndpoint(baseUrl), loginRejected: lastErr === 'GitHub cookie is invalid or expired' });
      if (lastErr === 'GitHub cookie is invalid or expired') {
        throw new Error('GitHub session rejected. Update the GitHub cookie.');
      }
    }
  }

  throw new Error(lastErr || 'All candidate endpoints failed');
}

async function run() {
  console.log(`Connecting to worker at ${WORKER_URL}…`);
  const res = await fetch(`${WORKER_URL}/api/runner/accounts`, {
    headers: { Authorization: `Bearer ${ACCESS_CODE}` }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch accounts from worker: HTTP ${res.status}`);
  }

  const accounts = await res.json<{ id: number; label: string; githubCookie: string }[]>();
  console.log(`Found ${accounts.length} active account(s).\n`);

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    console.log(`\n[${i + 1}/${accounts.length}] Processing [${acc.label}]…`);

    debug('account.start', { id: acc.id });

    let result = '';
    const cookies = parseCookieString(acc.githubCookie);
    const originalCookie = serializeCookieMap(cookies);
    try {
      const outcome = await claimAccount(cookies, acc.label);
      result = outcome.message;
      console.log(`  -> ${result}`);
    } catch (err) {
      result = `Failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`  -> ${result}`);
    }

    const latestCookie = serializeCookieMap(cookies);
    const updatedCookie = latestCookie !== originalCookie ? latestCookie : undefined;
    // Report rotated cookies even when authentication failed.
    const report = await fetch(`${WORKER_URL}/api/runner/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ACCESS_CODE}` },
      body: JSON.stringify({ id: acc.id, result, updatedCookie })
    });
    debug('worker.report', { id: acc.id, status: report.status, cookieChanged: updatedCookie !== undefined });
    const receipt = await report.json<{ sessionMatches?: boolean | null }>().catch(() => null);
    debug('worker.cookieVerification', { id: acc.id, sessionMatches: receipt?.sessionMatches ?? null });
    if (!report.ok) throw new Error(`Failed to persist claim/cookies: HTTP ${report.status}`);
    if (updatedCookie !== undefined && receipt?.sessionMatches !== true) {
      throw new Error('Worker did not verify persisted cookies');
    }

    // Berikan jeda 5 detik antar akun
    if (i < accounts.length - 1) {
      console.log('  Waiting 5s before next account…');
      await sleep(5000);
    }
  }

  console.log('\nAll accounts processed.');
}

run().catch((err) => {
  console.error('Runner error:', err);
  process.exit(1);
});
