import { chromium, request } from 'playwright';
import type { Credentials } from '../src/credentials';

const BASE = 'https://agentrouter.org';
type ApiResult = { status: number; body: { success?: boolean; data?: { id?: number; checked_in?: boolean; turnstile_check?: boolean } } | null };
type ApiCall = (path: string, userId?: number) => Promise<ApiResult>;

export class AuthError extends Error {
  constructor(message: string, public fallback = false) { super(message); }
}
// Only fixed stage names, statuses and booleans; never credentials, cookies or server messages.
export function debug(stage: string, details: Record<string, number | boolean | null> = {}) {
  console.log(`[debug] ${stage} ${JSON.stringify(details)}`);
}

// Contract observed in AgentRouter index-Cs_52wE9.js: username accepts email;
// login POST returns data.id and optionally checked_in; logout is GET.
export async function authenticateAndLogout(login: () => Promise<ApiResult>, call: ApiCall): Promise<boolean> {
  let userId: number | undefined;
  let checkedIn = false;
  let verified = false;
  let failure: AuthError | undefined;
  try {
    const result = await login();
    debug('login.response', { status: result.status, json: !!result.body, success: result.body?.success === true });
    if (result.status !== 200 || result.body?.success !== true) {
      throw new AuthError('AgentRouter login rejected or challenge required', !result.body || result.status === 403 || result.status === 429);
    }
    userId = result.body.data?.id;
    if (!Number.isSafeInteger(userId) || userId! <= 0) throw new AuthError('Login did not return an authenticated user');
    checkedIn = result.body.data?.checked_in === true;
    const self = await call('/api/user/self', userId);
    verified = self.status === 200 && self.body?.success === true && self.body.data?.id === userId;
    debug('login.self', { status: self.status, verified, checkedIn });
    if (!verified) throw new AuthError('AgentRouter session verification failed');
  } catch (error) {
    failure = error instanceof AuthError ? error : new AuthError('Login request failed; result unknown');
  } finally {
    // Attempt logout even on a rejected/ambiguous login; never retry a verified login.
    try {
      const logout = await call('/api/user/logout', userId);
      const loggedOut = logout.status === 200 && logout.body?.success === true;
      debug('logout.response', { status: logout.status, success: loggedOut });
      if (!loggedOut) throw new AuthError('AgentRouter logout failed');
      if (verified) {
        const self = await call('/api/user/self', userId);
        const rejected = self.body?.success === false;
        debug('logout.self', { status: self.status, rejected });
        if (!rejected) throw new AuthError('AgentRouter logout could not be verified');
      }
    } catch {
      if (!failure || !failure.fallback) failure = new AuthError('Login/logout failed; logout could not be verified');
    }
  }
  if (failure) throw failure;
  return checkedIn;
}

export async function httpLogin(credentials: Credentials): Promise<boolean> {
  // Playwright's HTTP client maintains a standards-aware cookie jar; it does not launch a browser.
  const context = await request.newContext({ baseURL: BASE, timeout: 30_000, maxRedirects: 0 });
  const read = async (response: import('playwright').APIResponse): Promise<ApiResult> => ({
    status: response.status(), body: await response.json().catch(() => null)
  });
  try {
    const status = await read(await context.get('/api/status'));
    debug('http.status', { status: status.status, turnstile: status.body?.data?.turnstile_check === true });
    if (status.body?.data?.turnstile_check) throw new AuthError('Browser challenge required', true);
    if (!status.body || status.status !== 200) throw new AuthError('HTTP unavailable; trying browser', true);
    return await authenticateAndLogout(
      async () => read(await context.post('/api/user/login?turnstile=', { data: { username: credentials.email, password: credentials.password } })),
      async (path, userId) => read(await context.get(path, { headers: userId ? { 'New-Api-User': String(userId) } : {} }))
    );
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('HTTP connection failed', true);
  } finally { await context.dispose(); }
}

export async function browserLogin(credentials: Credentials): Promise<boolean> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const email = page.locator('input[name="username"]');
    if (!await email.isVisible()) {
      await page.getByRole('button', { name: /使用 邮箱或用户名 登录|Use Email or Username|Sign in with Email or Username/i }).click({ timeout: 15_000 });
    }
    await email.fill(credentials.email);
    await page.locator('input[name="password"]').fill(credentials.password);
    return await authenticateAndLogout(async () => {
      const pending = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.origin === BASE && url.pathname === '/api/user/login' && response.request().method() === 'POST';
      }, { timeout: 45_000 });
      // Attach rejection handling before click: failed navigation must not leave an unhandled waiter.
      const responsePromise = pending.catch(() => null);
      await page.locator('button[type="submit"]').click();
      const response = await responsePromise;
      if (!response) throw new AuthError('Browser login timed out (challenge or verification required)');
      return { status: response.status(), body: await response.json().catch(() => null) };
    }, async (path, userId) => {
      return page.evaluate(async ({ url, userId }) => {
        const response = await fetch(url, { credentials: 'include', headers: userId ? { 'New-Api-User': String(userId) } : {} });
        return { status: response.status, body: await response.json().catch(() => null) };
      }, { url: `${BASE}${path}`, userId });
    });
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('Browser login failed (challenge or verification required)');
  } finally { await browser.close(); }
}

export async function claimAccount(credentials: Credentials): Promise<string> {
  let method = 'HTTP';
  let checkedIn: boolean;
  try {
    checkedIn = await httpLogin(credentials);
  } catch (error) {
    if (!(error instanceof AuthError) || !error.fallback) throw error;
    debug('http.fallback');
    method = 'Browser';
    checkedIn = await browserLogin(credentials);
  }
  return `Success (${method}) · Login/logout verified · ${checkedIn ? 'API reported check-in' : 'Bonus not verified'}`;
}
