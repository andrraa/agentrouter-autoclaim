# AgentRouter Auto Claim

Multi-account GitHub OAuth auto-claim built with Svelte, shadcn-svelte, Cloudflare Browser Rendering, and D1. The cron runs daily at 00:05 UTC.

## Deploy

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler d1 create agentrouter-autoclaim
# Copy the database_id into wrangler.jsonc
npx wrangler secret put ACCESS_CODE
openssl rand -base64 32 | npx wrangler secret put ENCRYPTION_KEY
npm run db:migrate
npm run deploy
```

Set `ACCESS_CODE` through Cloudflare Dashboard → Worker → Settings → Variables and Secrets. It is used to sign in to the application dashboard.

In the application dashboard, add a label and the complete `cookie` header from a request to `github.com` in DevTools → Network. It must include at least `user_session` and `_gh_sess`. Cookies are encrypted in D1 and decrypted only while Browser Rendering runs OAuth.

> GitHub cookies are sensitive credentials. If one leaks, revoke the session through GitHub Settings → Sessions.
