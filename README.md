# AgentRouter Auto-Claim

[![Claim Workflow](https://github.com/andrraa/agentrouter-autoclaim/actions/workflows/claim.yml/badge.svg)](https://github.com/andrraa/agentrouter-autoclaim/actions/workflows/claim.yml)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg?style=flat-square)](https://github.com/andrraa/agentrouter-autoclaim/releases/tag/0.1.0)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020.svg?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Svelte 5](https://img.shields.io/badge/Svelte-5-FF3E00.svg?style=flat-square&logo=svelte&logoColor=white)](https://svelte.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg?style=flat-square)](LICENSE)

Automated multi-account daily reward claim system for AgentRouter. Built with a hybrid serverless architecture combining Cloudflare Workers, Cloudflare D1 SQL database, Svelte 5 (shadcn-svelte), and GitHub Actions scheduled runners with Cloudflare WARP.

---

## Overview

AgentRouter provides daily reward credits upon authentication. This application automates the re-authorization workflow across multiple accounts without requiring manual browser interactions each day.

### Architecture

- **Dashboard & API (Cloudflare Workers + D1):** Hosts the web management dashboard, stores encrypted account credentials in D1, logs execution history, and sends real-time Telegram notifications.
- **Scheduled Runner (GitHub Actions + Cloudflare WARP):** Runs daily scheduled claims inside Ubuntu runner VMs using Chromium Playwright routed through a Cloudflare WARP Anycast tunnel to bypass WAF challenges and eliminate Cloudflare browser rate limits (429 errors).

---

## Tech Stack

- **Frontend:** Svelte 5, TypeScript, Tailwind CSS, shadcn-svelte
- **Backend API:** Cloudflare Workers (TypeScript)
- **Database:** Cloudflare D1 (Serverless SQLite)
- **Automation Runner:** GitHub Actions, Playwright (Chromium), Cloudflare WARP
- **Security:** AES-GCM 256-bit encryption for sensitive AgentRouter credentials at rest

---

## Prerequisites

- Node.js 20+ and npm
- A Cloudflare account with Workers and D1 enabled
- Cloudflare Wrangler CLI authenticated (`npx wrangler login`)
- A GitHub repository hosting this project

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

Create your Cloudflare D1 database:

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

### 3. Configure Cloudflare Secrets

Set the required environment secrets via Wrangler:

```bash
# Dashboard access code
npx wrangler secret put ACCESS_CODE

# Generate and set a 32-byte Base64 AES encryption key
openssl rand -base64 32 | npx wrangler secret put ENCRYPTION_KEY
```

Optional: Set Telegram notification secrets:

```bash
# Telegram Bot Token from @BotFather
npx wrangler secret put TELEGRAM_BOT_TOKEN

# Target Chat ID or Channel ID (e.g. -100xxxxxxxxxx or @channel_name)
npx wrangler secret put TELEGRAM_CHAT_ID
```

### 4. Apply Database Migrations & Deploy

Apply the database schema to the remote D1 instance:

```bash
npm run db:migrate
```

Build the Svelte application and deploy the worker:

```bash
npm run deploy
```

Your dashboard will be live at `https://agentrouter-autoclaim.<your-subdomain>.workers.dev`.

---

## Configuring GitHub Actions Runner

To run automated daily claims without hitting Cloudflare browser rate limits:

1. Open your repository on GitHub.
2. Navigate to **Settings -> Secrets and variables -> Actions -> New repository secret**.
3. Add the following repository secrets:
   - `WORKER_URL`: `https://agentrouter-autoclaim.<your-subdomain>.workers.dev`
   - `ACCESS_CODE`: `<YOUR_DASHBOARD_ACCESS_CODE>`
4. The automated trigger runs daily via Cloudflare Cron (`5 22 * * *` UTC = **05:05 WIB**) dispatching GitHub Actions.
5. You can trigger a run manually at any time from the dashboard via **Test GH Actions** or from the GitHub **Actions** tab.

---

## Adding Accounts

1. Open your deployed dashboard and authenticate with your `ACCESS_CODE`.
2. Add an account with a label, your **AgentRouter email**, and your **AgentRouter password** (not your GitHub password).
3. The runner logs in via AgentRouter API / Playwright fallback, verifies the session, and logs out to record check-in.

All credentials are encrypted with AES-GCM prior to database insertion and are decrypted only in memory during claim execution. Passwords are never returned to the browser UI.

---

## Telegram Notifications

When `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are configured, status notifications are broadcast automatically upon every manual claim and automated runner execution.

### Channel Setup

1. Create a public or private channel in Telegram.
2. Add your bot as an **Administrator** with permission to **Post Messages**.
3. Determine the Chat ID:
   - **Public Channel:** Use `@channel_username`.
   - **Private Channel:** Forward any message from the channel to `@userinfobot` to retrieve the numeric ID (typically starting with `-100`).
4. Set the `TELEGRAM_CHAT_ID` secret in Cloudflare. Notifications will be delivered automatically on every claim run.

---

## Security & Privacy

- `ACCESS_CODE` protects all administrative API endpoints and runner sync routes.
- AgentRouter credentials (email & password) are encrypted at rest in Cloudflare D1 with unique initialization vectors (IV) per record. Passwords are never exposed in UI responses.
- Local configuration files (`wrangler.jsonc`, `.env`, `.dev.vars`) are excluded from version control via `.gitignore`.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
