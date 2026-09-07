import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as cookieHelpers from '../src/cookies';

// Load the real entrypoints with fake network/browser/DB; never use real accounts.
let request: typeof fetch;
let launch: () => Promise<unknown> = async () => { throw new Error('Browser unavailable'); };
function load(path: string, exports: string) {
  const source = readFileSync(path, 'utf8').replace(/\nrun\(\)\.catch\([\s\S]*$/, '');
  const compiled = ts.transpileModule(`${source}\nexport { ${exports} };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const result = { exports: {} as any };
  runInNewContext(compiled, {
    exports: result.exports, module: result,
    require: (name: string) => {
      if (name.endsWith('/cookies')) return cookieHelpers;
      if (name === 'child_process') return { execSync() {} };
      return { launch: () => launch(), chromium: { launch: () => launch() } };
    },
    fetch: (...args: Parameters<typeof fetch>) => request(...args),
    process: { env: { WORKER_URL: 'https://worker.test', ACCESS_CODE: 'test' } },
    console: { log() {}, error() {} },
    crypto, atob, btoa, TextEncoder, TextDecoder, URL, URLSearchParams, Response,
    setTimeout: (callback: () => void) => { callback(); }
  });
  return result.exports;
}
const worker = load('src/worker.ts', 'pureHttpClaim, claim, encrypt, decrypt');
const runner = load('scripts/runner.ts', 'pureHttpClaim, browserClaim, run');
const { parseCookieString, serializeCookieMap, mergeSetCookies, captureGithubCookies } = cookieHelpers;

const jar = parseCookieString('user_session=old; _gh_sess=old; gone=x; expired=x');
const headers = new Headers();
headers.append('set-cookie', 'user_session=new==; Path=/; HttpOnly');
headers.append('set-cookie', '_gh_sess=next; Expires=Wed, 01 Jan 2099 00:00:00 GMT');
headers.append('set-cookie', 'gone=deleted; Max-Age=0');
headers.append('set-cookie', 'expired=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
mergeSetCookies(jar, new Response('', { headers }));
assert.equal(serializeCookieMap(jar), 'user_session=new==; _gh_sess=next');
await captureGithubCookies(jar, { async cookies(url) {
  assert.equal(url, 'https://github.com');
  return [{ name: 'user_session', value: 'browser' }];
} });
assert.equal(serializeCookieMap(jar), 'user_session=browser');

let generation = 0;
let failCallback = false;
request = async (input, init) => {
  const url = String(input);
  const cookies = new Headers(init?.headers).get('cookie') || '';
  if (url.endsWith('/api/oauth/state')) {
    return Response.json({ success: true, data: 'state' }, { headers: { 'set-cookie': 'session=state-session; Path=/' } });
  }
  if (url.startsWith('https://github.com/login/oauth/authorize')) {
    assert(!cookies.includes('session=state-session'), 'AgentRouter cookie leaked to GitHub');
    if (init?.method === 'POST') {
      assert.equal(parseCookieString(cookies).get('user_session'), `get-${generation}`);
      return new Response(null, { status: 302, headers: {
        location: 'https://agentrouter.org/api/oauth/github?code=test',
        'set-cookie': `user_session=post-${generation}; Path=/`
      } });
    }
    assert.equal(parseCookieString(cookies).get('user_session'), generation ? `post-${generation}` : 'fresh');
    generation++;
    return new Response('<input name="authenticity_token" value="token">', {
      headers: { 'set-cookie': `user_session=get-${generation}; Path=/` }
    });
  }
  assert(url.includes('/api/oauth/github'));
  assert.equal(cookies, 'session=state-session', 'OAuth state session must reach callback, without GitHub cookies');
  return failCallback ? new Response('<html>WAF</html>') : Response.json({ success: true, data: { username: 'test' } });
};

for (const claim of [
  (cookies: Map<string, string>) => worker.pureHttpClaim(cookies, 'test'),
  (cookies: Map<string, string>) => runner.pureHttpClaim('https://agentrouter.org', cookies, 'test')
]) {
  generation = 0;
  failCallback = false;
  const cookies = parseCookieString('user_session=fresh');
  await claim(cookies);
  await claim(cookies); // Second claim must use the rotated cookie.
  failCallback = true;
  await assert.rejects(() => claim(cookies), /HTTP OAuth returned/);
  assert.equal(cookies.get('user_session'), 'post-3', 'Failed callback must not discard rotation');
}

const batches: any[][] = [];
const env = {
  ENCRYPTION_KEY: btoa('k'.repeat(32)),
  DB: {
    prepare(sql: string) { return { bind(...values: unknown[]) { return { sql, values }; } }; },
    async batch(ops: any[]) { batches.push(ops); }
  }
};
const account = { id: 1, label: 'test', github_cookie: await worker.encrypt('user_session=fresh', env) };
generation = 0;
failCallback = false;
await worker.claim(account, env);
let saved = batches.at(-1)!.find((op) => op.sql.includes('SET github_cookie'));
assert.equal(await worker.decrypt(saved.values[0], env), 'user_session=post-1');
account.github_cookie = saved.values[0];
failCallback = true;
await worker.claim(account, env);
saved = batches.at(-1)!.find((op) => op.sql.includes('SET github_cookie'));
assert.equal(await worker.decrypt(saved.values[0], env), 'user_session=post-2');

let closed = false;
launch = async () => ({
  async newContext() { return {
    async addInitScript() {}, async addCookies() {},
    async newPage() { return { async goto() { throw new Error('Navigation failed'); } }; },
    async cookies() { return [{ name: 'user_session', value: 'browser-rotated' }]; }
  }; },
  async close() { closed = true; }
});
const browserJar = parseCookieString('user_session=old; deleted=x');
await assert.rejects(() => runner.browserClaim('https://agentrouter.org', browserJar, 'test'), /Navigation failed/);
assert.equal(serializeCookieMap(browserJar), 'user_session=browser-rotated');
assert(closed);
account.github_cookie = saved.values[0];
await worker.claim(account, env);
saved = batches.at(-1)!.find((op) => op.sql.includes('SET github_cookie'));
assert.equal(await worker.decrypt(saved.values[0], env), 'user_session=browser-rotated');

// The scheduled runner must report cookies even if every claim attempt fails.
launch = async () => { throw new Error('Browser unavailable'); };
const oauthRequest = request;
generation = 0;
let report: any;
request = async (input, init) => {
  if (String(input).endsWith('/api/runner/accounts')) return Response.json([{ id: 1, label: 'test', githubCookie: 'user_session=fresh' }]);
  if (String(input).endsWith('/api/runner/report')) {
    report = JSON.parse(String(init?.body));
    return Response.json({ ok: true });
  }
  return oauthRequest(input, init);
};
await runner.run();
assert.match(report.result, /^Failed:/);
assert.equal(report.updatedCookie, 'user_session=post-2');
console.log('Cookie regression checks passed (HTTP repeat, state isolation, failure persistence, browser cleanup, runner report).');
