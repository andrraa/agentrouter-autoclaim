# AgentRouter Auto-Claim

Automated multi-account daily reward claim system for AgentRouter. Built as a serverless application on Cloudflare Workers, Cloudflare D1 SQL database, and Svelte 5 with shadcn-svelte.

---

## Overview

AgentRouter provides daily reward credits upon authentication. This application automates the re-authorization workflow across multiple accounts without requiring manual browser logins each day.

The claim engine prioritizes direct HTTP OAuth exchanges to conserve execution quotas and minimize latency. When WAF challenges are encountered, it automatically falls back to Cloudflare Browser Rendering (Playwright).

---

## Tech Stack

- **Frontend:** Svelte 5, TypeScript, Tailwind CSS, shadcn-svelte
- **Backend:** Cloudflare Workers (TypeScript)
- **Database:** Cloudflare D1 (Serverless SQLite)
- **Browser Automation (Fallback):** Cloudflare Browser Rendering via `@cloudflare/playwright`
- **Security:** AES-GCM 256-bit encryption for sensitive session cookies at rest

---

## Prerequisites

- Node.js 18+ and npm
- A Cloudflare account with Workers and D1 enabled
- Cloudflare Wrangler CLI authenticated (`npx wrangler login`)

---

## Getting Started

### 1. Clone and Install Dependencies

```bash
git clone https://github.com/andrraa/agentrouter-autoclaim.git
cd agentrouter-autoclaim
npm install
```

### 2. Configure Cloudflare Wrangler

Copy the configuration template:

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Create the Cloudflare D1 database:

```bash
npx wrangler d1 create agentrouter-autoclaim
```

Copy the generated `database_id` and update `wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "agentrouter-autoclaim",
    "database_id": "<YOUR_D1_DATABASE_ID>",
    "migrations_dir": "migrations"
  }
]
```

### 3. Configure Secrets

Set the required environment secrets via Wrangler:

```bash
# Set your dashboard access code
npx wrangler secret put ACCESS_CODE

# Generate and set a 32-byte AES encryption key (Base64 encoded)
openssl rand -base64 32 | npx wrangler secret put ENCRYPTION_KEY
```

Optional: Configure Telegram notification secrets:

```bash
# Telegram Bot Token from @BotFather
npx wrangler secret put TELEGRAM_BOT_TOKEN

# Target Chat ID or Channel ID (e.g. -100xxxxxxxxxx or @channel_name)
npx wrangler secret put TELEGRAM_CHAT_ID
```

### 4. Apply Database Migrations

Apply the database schema to the remote D1 instance:

```bash
npm run db:migrate
```

### 5. Deploy to Cloudflare

Build the Svelte single-page application and deploy the worker:

```bash
npm run deploy
```

---

## Adding Accounts

1. Sign in to [GitHub](https://github.com) in your browser (using an incognito window or separate profile is recommended to maintain session isolation).
2. Open Developer Tools (`F12` or `Cmd + Option + I`) and navigate to the **Network** tab.
3. Refresh the page, select any request sent to `github.com`, and locate the **Request Headers**.
4. Copy the entire value of the `cookie` header. It must include at least `user_session` and `_gh_sess`.
5. Open your deployed AgentRouter Auto-Claim dashboard, enter your `ACCESS_CODE`, and add the account with an identifiable label and the copied cookie.

All cookies are encrypted via AES-GCM prior to database insertion and are decrypted only during active claim execution.

---

## Telegram Notifications

When `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are configured, the worker automatically broadcasts status updates for both manual claims and automated cron runs.

### Channel Setup

1. Create a public or private channel in Telegram.
2. Add your bot as an **Administrator** with permission to **Post Messages**.
3. Determine the Chat ID:
   - **Public Channel:** Use `@channel_username`.
   - **Private Channel:** Forward any message from the channel to `@userinfobot` to retrieve the numeric ID (typically starting with `-100`).
4. Set the `TELEGRAM_CHAT_ID` secret accordingly.
5. Click **Test Bot** in the dashboard header to verify delivery.

---

## Scheduled Execution

The worker includes a scheduled cron trigger configured in `wrangler.jsonc`:

```jsonc
"triggers": {
  "crons": ["5 0 * * *"]
}
```

The automated claim process runs daily at **00:05 UTC (07:05 WIB)**. Accounts are processed concurrently via `Promise.allSettled` to minimize execution window and resource utilization.

---

## Security Considerations

- `ACCESS_CODE` protects all administrative API routes.
- GitHub cookies are encrypted at rest in D1 using AES-GCM with unique initialization vectors (IV) per record.
- If a session cookie is ever compromised, invalidate it immediately by navigating to **GitHub Settings -> Sessions -> Revoke**.
- Keep `wrangler.jsonc` and local environment files out of version control (included in `.gitignore`).

---

## License

MIT License. See [LICENSE](LICENSE) for details.
