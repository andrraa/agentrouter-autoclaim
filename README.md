# AgentRouter Auto Claim

Multi-account GitHub OAuth auto-claim dengan Svelte, shadcn-svelte, Cloudflare Worker Browser Rendering, dan D1. Cron berjalan pukul 00:05 UTC.

## Deploy

```bash
npm install
npx wrangler d1 create agentrouter-claim
# salin database_id ke wrangler.jsonc
npx wrangler secret put ADMIN_TOKEN
openssl rand -base64 32 | npx wrangler secret put ENCRYPTION_KEY
npm run db:migrate
npm run deploy
```

Di dashboard, tambahkan label dan seluruh nilai header `cookie` dari request ke `github.com` di DevTools → Network. Minimal harus memuat `user_session` dan `_gh_sess`. Cookie disimpan terenkripsi di D1 dan hanya didekripsi di Worker saat Browser Rendering menjalankan OAuth.

> Cookie GitHub adalah kredensial sensitif. Jika bocor, hapus sesi tersebut lewat GitHub Settings → Sessions.
