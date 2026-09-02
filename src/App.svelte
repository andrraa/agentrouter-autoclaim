<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import * as Card from '$lib/components/ui/card';

  type Account = { id: number; label: string; enabled: number; last_claim_at?: string; last_result?: string };
  type History = { id: number; label: string; success: number; result: string; created_at: string };
  let token = localStorage.getItem('access-code') || '', accounts: Account[] = [], history: History[] = [], form = { label: '', githubCookie: '' }, message = '', authenticated = false;
  async function call(path: string, options: RequestInit = {}) {
    const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...options.headers } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Request failed');
    return body;
  }
  async function load() {
    try {
      [accounts, history] = await Promise.all([call('/api/accounts'), call('/api/history')]);
      localStorage.setItem('access-code', token);
      authenticated = true;
      message = '';
    } catch (e) {
      localStorage.removeItem('access-code');
      message = (e as Error).message;
    }
  }
  async function add() { try { await call('/api/accounts', { method: 'POST', body: JSON.stringify(form) }); form = { label: '', githubCookie: '' }; await load(); } catch (e) { message = (e as Error).message; } }
  async function claim(id: number) { try { const result = await call(`/api/accounts/${id}/claim`, { method: 'POST' }); message = result.result; await load(); } catch (e) { message = (e as Error).message; } }
  async function remove(id: number) { if (confirm('Delete this account?')) { await call(`/api/accounts/${id}`, { method: 'DELETE' }); await load(); } }
</script>

{#if !authenticated}
  <div class="fixed inset-0 z-50 grid place-items-center bg-background/50 p-4 backdrop-blur-md">
    <Card.Root class="w-full max-w-sm shadow-2xl">
      <Card.Header><Card.Title>Access required</Card.Title><Card.Description>Enter your access code to open the dashboard.</Card.Description></Card.Header>
      <Card.Content>
        <form class="space-y-4" onsubmit={(e) => { e.preventDefault(); load(); }}>
          <div class="space-y-2"><Label for="token">Access code</Label><Input id="token" type="password" bind:value={token} autocomplete="current-password" autofocus /></div>
          {#if message}<p class="text-sm text-destructive">{message}</p>{/if}
          <Button type="submit" class="w-full">Open dashboard</Button>
        </form>
      </Card.Content>
    </Card.Root>
  </div>
{/if}

<main class="mx-auto min-h-screen w-full max-w-5xl space-y-4 px-4 py-12 transition" class:blur-sm={!authenticated} class:pointer-events-none={!authenticated}>
  <header class="mb-8 flex items-end justify-between gap-4">
    <div><p class="mb-2 text-xs font-semibold tracking-[.2em] text-emerald-400 uppercase">Cloudflare Worker + D1</p><h1 class="text-4xl font-bold tracking-tight sm:text-5xl">AgentRouter Auto Claim</h1></div>
    <Badge variant="secondary">Cron 00:05 UTC</Badge>
  </header>

  {#if message}<div class="rounded-lg border border-emerald-900 bg-emerald-950/50 px-4 py-3 text-sm text-emerald-300">{message}</div>{/if}

  <Card.Root>
    <Card.Header><Card.Title>Add account</Card.Title><Card.Description>Copy the complete cookie header from a github.com request in DevTools Network.</Card.Description></Card.Header>
    <Card.Content>
      <form class="grid gap-3 sm:grid-cols-[1fr_3fr_auto]" onsubmit={(e) => { e.preventDefault(); add(); }}>
        <Input aria-label="Label" placeholder="Account label" bind:value={form.label} required />
        <Input aria-label="GitHub cookie" type="password" placeholder="user_session=...; _gh_sess=..." bind:value={form.githubCookie} required />
        <Button type="submit">Add</Button>
      </form>
      <p class="mt-3 text-xs text-muted-foreground">Cookies are encrypted with AES-GCM before being stored in D1.</p>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header><Card.Title>Accounts <Badge>{accounts.length}</Badge></Card.Title></Card.Header>
    <Card.Content>
      {#each accounts as account}
        <div class="grid items-center gap-4 border-t py-4 first:border-t-0 sm:grid-cols-[1fr_2fr_auto]">
          <div><p class="font-semibold">{account.label}</p><p class="text-sm text-muted-foreground">GitHub OAuth</p></div>
          <div><p class="text-sm">{account.last_result || 'Never run'}</p><p class="text-xs text-muted-foreground">{account.last_claim_at ? new Date(account.last_claim_at).toLocaleString('en-US') : ''}</p></div>
          <div class="flex gap-2"><Button size="sm" onclick={() => claim(account.id)}>Claim</Button><Button size="sm" variant="destructive" onclick={() => remove(account.id)}>Delete</Button></div>
        </div>
      {:else}<p class="text-sm text-muted-foreground">No accounts yet.</p>{/each}
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header><Card.Title>Claim history</Card.Title><Card.Description>The latest 100 manual and scheduled runs.</Card.Description></Card.Header>
    <Card.Content>
      {#each history as item}
        <div class="grid items-center gap-3 border-t py-4 first:border-t-0 sm:grid-cols-[1fr_3fr_auto]">
          <div><p class="font-semibold">{item.label}</p><Badge variant={item.success ? 'default' : 'destructive'}>{item.success ? 'Success' : 'Failed'}</Badge></div>
          <p class="text-sm text-muted-foreground">{item.result}</p>
          <time class="text-xs text-muted-foreground">{new Date(item.created_at).toLocaleString('en-US')}</time>
        </div>
      {:else}<p class="text-sm text-muted-foreground">No claim history yet.</p>{/each}
    </Card.Content>
  </Card.Root>
</main>
