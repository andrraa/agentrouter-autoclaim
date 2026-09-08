import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { validEmail, validPassword } from '../src/credentials';
import { authenticateAndLogout, AuthError, debug } from './agentrouter';

// 1. Credentials validation tests
assert.equal(validEmail('user@example.com'), true);
assert.equal(validEmail('invalid-email'), false);
assert.equal(validEmail(''), false);
assert.equal(validEmail('a'.repeat(250) + '@b.co'), false);

assert.equal(validPassword('secret123'), true);
assert.equal(validPassword(''), false);
assert.equal(validPassword('a'.repeat(1025)), false);

// 2. authenticateAndLogout contract tests
let loggedOut = false;
let verifiedSelf = false;

const successfulLogin = async () => ({
  status: 200,
  body: { success: true, data: { id: 42, checked_in: true } }
});

const mockCall = async (path: string, userId?: number) => {
  if (path === '/api/user/self') {
    return { status: 200, body: { success: !loggedOut, data: { id: 42 } } };
  }
  if (path === '/api/user/logout') {
    loggedOut = true;
    return { status: 200, body: { success: true } };
  }
  return { status: 404, body: null };
};

loggedOut = false;
const checkInResult = await authenticateAndLogout(successfulLogin, mockCall);
assert.equal(checkInResult, true);
assert.equal(loggedOut, true);

// Failed login must throw AuthError and not leak credentials
const rejectedLogin = async () => ({
  status: 200,
  body: { success: false, message: 'Invalid username or password' }
});

loggedOut = false;
await assert.rejects(
  () => authenticateAndLogout(rejectedLogin, mockCall),
  (err: unknown) => err instanceof AuthError && !String(err).includes('secret123')
);

// 3. Worker API tests
let request: typeof fetch;
function loadWorker() {
  const source = readFileSync('src/worker.ts', 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const result = { exports: {} as any };
  runInNewContext(compiled, {
    exports: result.exports, module: result,
    require: (name: string) => {
      if (name.endsWith('/credentials')) return { validEmail, validPassword };
      return {};
    },
    fetch: (...args: Parameters<typeof fetch>) => request(...args),
    console: { log() {}, error(...args: any[]) { console.error(...args); } },
    crypto, atob, btoa, TextEncoder, TextDecoder, URL, URLSearchParams, Response, Request
  });
  return result.exports;
}

const worker = loadWorker();
const encryptionKey = btoa('k'.repeat(32));
let accountsStore: Array<{ id: number; label: string; credentials: string | null; enabled: number }> = [];
let historyStore: Array<any> = [];

const mockEnv = {
  ACCESS_CODE: 'test-code',
  ENCRYPTION_KEY: encryptionKey,
  DB: {
    prepare(sql: string) {
      const createHandler = (boundValues: any[] = []) => ({
        async all() {
          if (sql.includes('FROM accounts WHERE enabled = 1')) {
            return { results: accountsStore.filter((a) => a.enabled === 1 && a.credentials !== null) };
          }
          if (sql.includes('FROM accounts')) {
            return { results: accountsStore };
          }
          if (sql.includes('FROM claim_history')) {
            return { results: historyStore };
          }
          return { results: [] };
        },
        async first() {
          if (sql.includes('FROM accounts WHERE id = ?')) {
            return accountsStore.find((a) => a.id === Number(boundValues[0])) || null;
          }
          return null;
        },
        async run() {
          if (sql.includes('INSERT INTO accounts')) {
            const newId = accountsStore.length + 1;
            accountsStore.push({ id: newId, label: boundValues[0], credentials: boundValues[1], enabled: 1 });
            return { success: true };
          }
          if (sql.includes('UPDATE accounts SET label = ?, credentials = ?')) {
            const acc = accountsStore.find((a) => a.id === Number(boundValues[2]));
            if (acc) {
              acc.label = boundValues[0];
              acc.credentials = boundValues[1];
            }
            return { success: true };
          }
          if (sql.includes('DELETE FROM accounts')) {
            accountsStore = accountsStore.filter((a) => a.id !== Number(boundValues[0]));
            return { success: true };
          }
          return { success: true };
        },
        bind(...values: any[]) {
          return createHandler(values);
        }
      });
      return createHandler();
    },
    async batch(ops: any[]) {
      for (const op of ops) {
        if (op && typeof op.run === 'function') await op.run();
      }
    }
  }
};

// Test create account via Worker API
const createReq = new Request('https://worker.test/api/accounts', {
  method: 'POST',
  headers: { authorization: 'Bearer test-code', 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'Test Account', email: 'user@agentrouter.test', password: 'secretpassword123' })
});
const createRes = await (worker.default || worker).fetch(createReq, mockEnv);
assert.equal(createRes.status, 201);
assert.equal(accountsStore.length, 1);

// Test runner accounts retrieval (credentials decrypted for runner, but never plain in DB)
const runnerReq = new Request('https://worker.test/api/runner/accounts', {
  method: 'GET',
  headers: { authorization: 'Bearer test-code' }
});
const runnerRes = await (worker.default || worker).fetch(runnerReq, mockEnv);
assert.equal(runnerRes.status, 200);
const runnerAccounts = await runnerRes.json();
assert.equal(runnerAccounts.length, 1);
assert.equal(runnerAccounts[0].email, 'user@agentrouter.test');
assert.equal(runnerAccounts[0].password, 'secretpassword123');

// Test accounts listing for UI (password must NEVER be returned to UI)
const listReq = new Request('https://worker.test/api/accounts', {
  method: 'GET',
  headers: { authorization: 'Bearer test-code' }
});
const listRes = await (worker.default || worker).fetch(listReq, mockEnv);
const listAccounts = await listRes.json();
assert.equal(listAccounts[0].email, 'user@agentrouter.test');
assert.equal(listAccounts[0].password, undefined);

console.log('All email/password auth regression checks passed.');
