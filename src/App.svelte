<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import * as Card from '$lib/components/ui/card';

  type Account = { id: number; label: string; enabled: number; last_claim_at?: string; last_result?: string };
  let token = localStorage.getItem('admin-token') || '', accounts: Account[] = [], form = { label: '', githubCookie: '' }, message = '';
  async function call(path: string, options: RequestInit = {}) {
    localStorage.setItem('admin-token', token);
    const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...options.headers } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Request gagal');
    return body;
  }
  async function load() { try { accounts = await call('/api/accounts'); message = ''; } catch (e) { message = (e as Error).message; } }
  async function add() { try { await call('/api/accounts', { method: 'POST', body: JSON.stringify(form) }); form = { label: '', githubCookie: '' }; await load(); } catch (e) { message = (e as Error).message; } }
  async function claim(id: number) { try { const result = await call(`/api/accounts/${id}/claim`, { method: 'POST' }); message = result.result; await load(); } catch (e) { message = (e as Error).message; } }
  async function remove(id: number) { if (confirm('Hapus akun ini?')) { await call(`/api/accounts/${id}`, { method: 'DELETE' }); await load(); } }
</script>

<main class="mx-auto min-h-screen w-full max-w-5xl space-y-4 px-4 py-12">
  <header class="mb-8 flex items-end justify-between gap-4">
    <div><p class="mb-2 text-xs font-semibold tracking-[.2em] text-emerald-400 uppercase">Cloudflare Worker + D1</p><h1 class="text-4xl font-bold tracking-tight sm:text-5xl">AgentRouter Auto Claim</h1></div>
    <Badge variant="secondary">Cron 00:05 UTC</Badge>
  </header>

  <Card.Root>
    <Card.Header><Card.Title>Dashboard</Card.Title><Card.Description>Token hanya disimpan di browser ini.</Card.Description></Card.Header>
    <Card.Content class="flex items-end gap-3 max-sm:flex-col max-sm:items-stretch">
      <div class="flex-1 space-y-2"><Label for="token">Admin token</Label><Input id="token" type="password" bind:value={token} placeholder="ADMIN_TOKEN" /></div>
      <Button onclick={load}>Buka dashboard</Button>
    </Card.Content>
  </Card.Root>

  {#if message}<div class="rounded-lg border border-emerald-900 bg-emerald-950/50 px-4 py-3 text-sm text-emerald-300">{message}</div>{/if}

  <Card.Root>
    <Card.Header><Card.Title>Tambah akun</Card.Title><Card.Description>Salin seluruh header cookie dari github.com lewat DevTools Network.</Card.Description></Card.Header>
    <Card.Content>
      <form class="grid gap-3 sm:grid-cols-[1fr_3fr_auto]" onsubmit={(e) => { e.preventDefault(); add(); }}>
        <Input aria-label="Label" placeholder="Label akun" bind:value={form.label} required />
        <Input aria-label="GitHub cookie" type="password" placeholder="user_session=...; _gh_sess=..." bind:value={form.githubCookie} required />
        <Button>Tambah</Button>
      </form>
      <p class="mt-3 text-xs text-muted-foreground">Cookie dienkripsi AES-GCM sebelum disimpan ke D1.</p>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header><Card.Title>Akun <Badge>{accounts.length}</Badge></Card.Title></Card.Header>
    <Card.Content>
      {#each accounts as account}
        <div class="grid items-center gap-4 border-t py-4 first:border-t-0 sm:grid-cols-[1fr_2fr_auto]">
          <div><p class="font-semibold">{account.label}</p><p class="text-sm text-muted-foreground">GitHub OAuth</p></div>
          <div><p class="text-sm">{account.last_result || 'Belum pernah dijalankan'}</p><p class="text-xs text-muted-foreground">{account.last_claim_at ? new Date(account.last_claim_at).toLocaleString('id-ID') : ''}</p></div>
          <div class="flex gap-2"><Button size="sm" onclick={() => claim(account.id)}>Claim</Button><Button size="sm" variant="destructive" onclick={() => remove(account.id)}>Hapus</Button></div>
        </div>
      {:else}<p class="text-sm text-muted-foreground">Masukkan admin token lalu buka dashboard.</p>{/each}
    </Card.Content>
  </Card.Root>
</main>
