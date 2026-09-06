<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import * as Card from '$lib/components/ui/card';

  type Account = { id: number; label: string; enabled: number; last_claim_at?: string; last_result?: string };
  type History = { id: number; label: string; success: number; result: string; created_at: string };

  let token = '';
  let loginError = '';
  let accounts: Account[] = [];
  let history: History[] = [];
  let form = { label: '', githubCookie: '' };
  let formErrors = { label: '', githubCookie: '' };
  let message = '';
  let authenticated = false;
  let claimingId: number | null = null;
  let refreshing = false;
  let accountToDelete: Account | null = null;
  let deleting = false;

  async function call(path: string, options: RequestInit = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...options.headers,
      },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Request failed');
    return body;
  }

  async function load() {
    refreshing = true;
    loginError = '';
    try {
      [accounts, history] = await Promise.all([call('/api/accounts'), call('/api/history')]);
      authenticated = true;
      message = '';
    } catch (e) {
      loginError = (e as Error).message;
    } finally {
      refreshing = false;
    }
  }

  async function add() {
    formErrors = { label: '', githubCookie: '' };
    let hasError = false;
    if (!form.label.trim()) {
      formErrors.label = 'Account label is required.';
      hasError = true;
    }
    if (!form.githubCookie.trim()) {
      formErrors.githubCookie = 'GitHub cookie is required.';
      hasError = true;
    } else if (!form.githubCookie.includes('=')) {
      formErrors.githubCookie = 'Cookie must be valid key=value pairs.';
      hasError = true;
    }
    if (hasError) return;

    try {
      await call('/api/accounts', { method: 'POST', body: JSON.stringify(form) });
      form = { label: '', githubCookie: '' };
      formErrors = { label: '', githubCookie: '' };
      await load();
    } catch (e) {
      const err = (e as Error).message;
      if (err.toLowerCase().includes('label')) {
        formErrors.label = err;
      } else {
        formErrors.githubCookie = err;
      }
    }
  }

  async function claim(id: number) {
    claimingId = id;
    message = 'Running claim…';
    try {
      const result = await call(`/api/accounts/${id}/claim`, { method: 'POST' });
      await load();
      message = result.result;
    } catch (e) {
      message = (e as Error).message;
    } finally {
      claimingId = null;
    }
  }

  async function confirmDelete() {
    if (!accountToDelete) return;
    deleting = true;
    try {
      await call(`/api/accounts/${accountToDelete.id}`, { method: 'DELETE' });
      accountToDelete = null;
      await load();
    } catch (e) {
      message = (e as Error).message;
    } finally {
      deleting = false;
    }
  }

  function logout() {
    token = '';
    authenticated = false;
    accounts = [];
    history = [];
    loginError = '';
  }
</script>

{#if !authenticated}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4 backdrop-blur-sm">
    <div class="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-950 p-5 sm:p-6 shadow-2xl">
      <div class="mb-5 space-y-1.5">
        <h2 class="text-base sm:text-lg font-semibold tracking-tight text-zinc-100">Access required</h2>
        <p class="text-xs text-zinc-400">Enter your access code to manage auto-claims.</p>
      </div>
      <form class="space-y-4" onsubmit={(e) => { e.preventDefault(); load(); }}>
        <div class="space-y-1.5">
          <Label for="token" class="text-xs font-normal text-zinc-400">
            Access code <span class="text-red-400/80 ml-0.5">*</span>
          </Label>
          <Input
            id="token"
            type="password"
            bind:value={token}
            autocomplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
            placeholder="••••••••••••"
            class="border-zinc-800 bg-zinc-900/50 text-xs text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-zinc-400 {loginError ? 'border-red-500/80 focus-visible:ring-red-400' : ''}"
            oninput={() => loginError = ''}
            autofocus
          />
          {#if loginError}
            <p class="mt-1.5 pt-0.5 text-[11px] text-red-400">{loginError}</p>
          {/if}
        </div>
        <Button type="submit" class="w-full bg-zinc-100 font-medium text-zinc-900 hover:bg-zinc-200 hover:text-zinc-900">
          Sign In
        </Button>
      </form>
    </div>
  </div>
{/if}

{#if accountToDelete}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4 backdrop-blur-sm">
    <div class="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-950 p-5 sm:p-6 shadow-2xl">
      <div class="mb-4 space-y-1.5">
        <h3 class="text-sm font-semibold tracking-tight text-zinc-100">Delete account</h3>
        <p class="text-xs text-zinc-400">
          Are you sure you want to remove <span class="font-medium text-zinc-200">"{accountToDelete.label}"</span>? Automated claims for this account will stop.
        </p>
      </div>
      <div class="flex items-center justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          class="border-zinc-800 text-xs text-zinc-300 hover:bg-zinc-900"
          disabled={deleting}
          onclick={() => accountToDelete = null}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          class="border border-red-900/60 bg-red-950/40 text-xs text-red-400 hover:bg-red-900/40"
          disabled={deleting}
          onclick={confirmDelete}
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
    </div>
  </div>
{/if}

<main class="mx-auto min-h-screen w-full max-w-4xl space-y-6 px-3.5 py-6 sm:px-6 sm:py-12 transition-all" class:blur-sm={!authenticated} class:pointer-events-none={!authenticated}>
  <!-- Header -->
  <header class="flex flex-col gap-4 border-b border-zinc-800/80 pb-5 sm:flex-row sm:items-center sm:justify-between">
    <div class="space-y-1">
      <div class="flex flex-wrap items-center gap-2">
        <h1 class="text-lg font-semibold tracking-tight text-zinc-100 sm:text-xl">AgentRouter Claim</h1>
        <Badge variant="outline" class="border-zinc-800 text-[10px] text-zinc-400 font-normal">
          Cron 00:05 UTC
        </Badge>
      </div>
      <p class="text-xs text-zinc-400">Multi-account daily rewards auto-claim worker</p>
    </div>

    {#if authenticated}
      <div class="flex items-center gap-2 self-end sm:self-auto">
        <Button variant="outline" size="sm" class="h-8 border-zinc-800 bg-transparent text-xs text-zinc-300 hover:bg-zinc-900" disabled={refreshing} onclick={load}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
        <Button variant="ghost" size="sm" class="h-8 text-xs text-zinc-400 hover:text-zinc-100" onclick={logout}>
          Sign out
        </Button>
      </div>
    {/if}
  </header>

  <!-- Notice / Message Banner -->
  {#if message}
    <div class="flex items-start justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-900/40 px-3.5 py-2.5 text-xs text-zinc-300 sm:items-center">
      <div class="flex items-start gap-2 sm:items-center min-w-0">
        <span class="mt-1 inline-block size-1.5 shrink-0 rounded-full sm:mt-0 {message.startsWith('Success') ? 'bg-zinc-100' : 'bg-zinc-500'}"></span>
        <span class="break-words">{message}</span>
      </div>
      <button class="shrink-0 text-zinc-500 hover:text-zinc-300 text-xs" onclick={() => message = ''}>Dismiss</button>
    </div>
  {/if}

  <!-- Add Account Card -->
  <Card.Root class="border-zinc-800 bg-zinc-950/60">
    <Card.Header class="px-4 py-4 sm:px-6">
      <Card.Title class="text-sm font-medium text-zinc-200">Add Account</Card.Title>
      <Card.Description class="text-xs text-zinc-500">
        Paste the full cookie header from any authenticated <code class="rounded bg-zinc-900 px-1 py-0.5 text-zinc-400">github.com</code> request.
      </Card.Description>
    </Card.Header>
    <Card.Content class="px-4 pb-4 sm:px-6 sm:pb-6">
      <form onsubmit={(e) => { e.preventDefault(); add(); }}>
        <div class="grid gap-3.5 sm:grid-cols-[1fr_2.5fr_auto] sm:items-start">
          <div class="space-y-1.5">
            <Label for="account-label" class="text-xs font-normal text-zinc-400">
              Account label <span class="text-red-400/80 ml-0.5">*</span>
            </Label>
            <Input
              id="account-label"
              placeholder="e.g. Work, Personal"
              bind:value={form.label}
              autocomplete="off"
              class="border-zinc-800 bg-zinc-900/40 text-xs text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-zinc-400 {formErrors.label ? 'border-red-500/80 focus-visible:ring-red-400' : ''}"
              oninput={() => formErrors.label = ''}
            />
            {#if formErrors.label}
              <p class="mt-1.5 pt-0.5 text-[11px] text-red-400">{formErrors.label}</p>
            {/if}
          </div>

          <div class="space-y-1.5">
            <Label for="github-cookie" class="text-xs font-normal text-zinc-400">
              GitHub cookie <span class="text-red-400/80 ml-0.5">*</span>
            </Label>
            <Input
              id="github-cookie"
              type="password"
              placeholder="user_session=...; _gh_sess=..."
              bind:value={form.githubCookie}
              autocomplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              class="border-zinc-800 bg-zinc-900/40 text-xs text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-zinc-400 {formErrors.githubCookie ? 'border-red-500/80 focus-visible:ring-red-400' : ''}"
              oninput={() => formErrors.githubCookie = ''}
            />
            {#if formErrors.githubCookie}
              <p class="mt-1.5 pt-0.5 text-[11px] text-red-400">{formErrors.githubCookie}</p>
            {/if}
          </div>

          <div class="pt-1 sm:pt-[22px]">
            <Button type="submit" class="w-full sm:w-auto border border-zinc-700 bg-zinc-100 text-xs font-medium text-zinc-900 hover:bg-zinc-200 hover:text-zinc-900">
              Add
            </Button>
          </div>
        </div>
      </form>
    </Card.Content>
  </Card.Root>

  <!-- Accounts List -->
  <Card.Root class="border-zinc-800 bg-zinc-950/60">
    <Card.Header class="flex flex-row items-center justify-between px-4 py-3.5 sm:px-6">
      <div>
        <Card.Title class="text-sm font-medium text-zinc-200">Accounts</Card.Title>
        <Card.Description class="text-xs text-zinc-500">Active accounts scheduled for daily claim</Card.Description>
      </div>
      <Badge variant="outline" class="border-zinc-800 text-xs text-zinc-400 font-mono">
        {accounts.length}
      </Badge>
    </Card.Header>
    <Card.Content class="p-0">
      <div class="divide-y divide-zinc-850">
        {#each accounts as account}
          <div class="flex flex-col gap-3 px-4 py-4 transition-colors hover:bg-zinc-900/20 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-3.5">
            <div class="space-y-0.5 min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-zinc-200">{account.label}</p>
              <p class="text-[11px] text-zinc-500 font-mono">
                {account.last_claim_at ? `Last run: ${new Date(account.last_claim_at).toLocaleString('en-US')}` : 'Never executed'}
              </p>
            </div>

            <div class="flex items-center justify-between gap-2.5 pt-2 border-t border-zinc-900 sm:border-t-0 sm:pt-0 sm:justify-end">
              <Badge
                variant="outline"
                class="text-[11px] font-normal border-zinc-800 {account.last_result?.startsWith('Success') ? 'border-zinc-600 text-zinc-200' : account.last_result ? 'border-red-900/60 text-red-400' : 'text-zinc-500'}"
              >
                {account.last_result?.startsWith('Success') ? 'Success' : account.last_result ? 'Failed' : 'Pending'}
              </Badge>

              <div class="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  class="h-7 border-zinc-800 px-2.5 text-xs text-zinc-300 hover:bg-zinc-900"
                  disabled={claimingId !== null}
                  onclick={() => claim(account.id)}
                >
                  {claimingId === account.id ? 'Claiming…' : 'Claim'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  class="h-7 px-2 text-xs text-zinc-500 hover:text-red-400"
                  disabled={claimingId !== null}
                  onclick={() => accountToDelete = account}
                >
                  Delete
                </Button>
              </div>
            </div>
          </div>
        {:else}
          <div class="px-4 py-8 sm:px-6 text-center text-xs text-zinc-500">
            No accounts configured yet.
          </div>
        {/each}
      </div>
    </Card.Content>
  </Card.Root>

  <!-- Claim History -->
  <Card.Root class="border-zinc-800 bg-zinc-950/60">
    <Card.Header class="px-4 py-3.5 sm:px-6">
      <Card.Title class="text-sm font-medium text-zinc-200">Execution History</Card.Title>
      <Card.Description class="text-xs text-zinc-500">Latest execution log per account</Card.Description>
    </Card.Header>
    <Card.Content class="p-0">
      <div class="divide-y divide-zinc-850">
        {#each history as item}
          <div class="flex flex-col gap-2 px-4 py-3 text-xs transition-colors hover:bg-zinc-900/20 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div class="flex items-start gap-2.5 min-w-0 sm:items-center">
              <Badge
                variant="outline"
                class="shrink-0 text-[10px] font-mono border-zinc-800 {item.success ? 'border-zinc-700 text-zinc-300' : 'border-red-900/60 text-red-400'}"
              >
                {item.success ? 'OK' : 'ERR'}
              </Badge>
              <div class="min-w-0 flex-1">
                <span class="font-medium text-zinc-300">{item.label}</span>
                <span class="ml-2 block sm:inline break-all text-zinc-500 font-mono text-[11px]">{item.result}</span>
              </div>
            </div>
            <time class="shrink-0 font-mono text-[11px] text-zinc-600 self-end sm:self-auto">
              {new Date(item.created_at).toLocaleString('en-US')}
            </time>
          </div>
        {:else}
          <div class="px-4 py-8 sm:px-6 text-center text-xs text-zinc-500">
            No history recorded yet.
          </div>
        {/each}
      </div>
    </Card.Content>
  </Card.Root>

  <!-- Footer -->
  <footer class="flex flex-col items-center justify-between gap-3 border-t border-zinc-850 pt-6 pb-2 text-xs text-zinc-500 sm:flex-row">
    <p class="text-center sm:text-left">
      AgentRouter Auto Claim · Cloudflare Workers & D1
    </p>
    <div class="flex items-center gap-4">
      <span class="font-mono text-[11px] text-zinc-600">Cron 00:05 UTC</span>
      <a
        href="https://github.com/andrraa/agentrouter-autoclaim"
        target="_blank"
        rel="noopener noreferrer"
        class="transition-colors hover:text-zinc-300 underline-offset-4 hover:underline"
      >
        GitHub
      </a>
    </div>
  </footer>
</main>
