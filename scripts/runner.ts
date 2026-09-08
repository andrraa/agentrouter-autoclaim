import { pathToFileURL } from 'node:url';
import { AuthError, claimAccount, debug } from './agentrouter';
import { validEmail, validPassword, type Credentials } from '../src/credentials';

type RunnerAccount = Credentials & { id: number; label: string };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run() {
  const workerUrl = (process.env.WORKER_URL || '').replace(/\/+$/, '');
  const accessCode = process.env.ACCESS_CODE || '';
  if (!accessCode || !workerUrl || new URL(workerUrl).protocol !== 'https:') throw new Error('HTTPS WORKER_URL and ACCESS_CODE are required');
  const response = await fetch(`${workerUrl}/api/runner/accounts`, {
    headers: { Authorization: `Bearer ${accessCode}` }, redirect: 'error', signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`Account retrieval failed: HTTP ${response.status}`);
  const accounts = await response.json() as RunnerAccount[];
  if (!Array.isArray(accounts) || accounts.some((account) => !account || !Number.isSafeInteger(account.id) || account.id <= 0 || !validEmail(account.email) || !validPassword(account.password))) {
    throw new Error('Runner account payload invalid; deploy matching email/password Worker');
  }
  console.log(`Found ${accounts.length} configured account(s).`);
  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index];
    debug('account.start', { id: account.id });
    let result: string;
    try { result = await claimAccount(account); }
    catch (error) { result = `Failed: ${error instanceof AuthError ? error.message : 'Login/logout unavailable'}`; }
    console.log(`  -> ${result}`);
    const report = await fetch(`${workerUrl}/api/runner/report`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessCode}` },
      body: JSON.stringify({ id: account.id, result }), redirect: 'error', signal: AbortSignal.timeout(30_000)
    });
    debug('worker.report', { id: account.id, status: report.status });
    if (!report.ok) throw new Error(`Report persistence failed: HTTP ${report.status}`);
    if (index < accounts.length - 1) await sleep(5000);
  }
  console.log('All accounts processed. Success means login/logout verified, not a balance increase.');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run().catch(() => { console.error('Runner failed; check safe stage diagnostics and Worker configuration.'); process.exitCode = 1; });
}
