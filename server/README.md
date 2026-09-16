# Repometer authentication service

A JavaScript Worker in Blaizzy's Cloudflare account handles GitHub sign-in and authenticated API requests at `https://repometer-auth.prince-gdt.workers.dev`. A Cloudflare D1 database is bound as `DB`. The frontend stays on GitHub Pages; no ChatGPT account or hosting service is required.

## Deploy

The account, Worker, database, allowed frontend URL, and migration directory are configured in `wrangler.jsonc`. Node.js 24 and pnpm are recommended.

```sh
pnpm --dir server install --frozen-lockfile
pnpm --dir server exec wrangler login
pnpm --dir server test
pnpm --dir server deploy
```

The deploy command applies pending D1 migrations and deploys the Worker. GitHub Pages' workflow publishes only the frontend. Forks must use their own Cloudflare account, Worker, D1 database, and GitHub App configuration.

## Runtime configuration

| Variable | Purpose |
| --- | --- |
| `SITE_ORIGIN` | Exact HTTPS origin of this Worker |
| `FRONTEND_URL` | Exact frontend base URL, including its trailing slash |
| `GITHUB_CLIENT_ID` | GitHub App OAuth client ID, configured as a Worker secret |
| `GITHUB_CLIENT_SECRET` | GitHub App OAuth client secret, configured as a Worker secret |
| `GITHUB_SESSION_KEY` | Secret: 32 random bytes encoded as base64url, for AES-GCM encryption |

Use `pnpm --dir server exec wrangler secret put NAME` to set each secret. Never commit their values. Changing the session encryption key invalidates existing sessions.

The GitHub App's exact OAuth callback URL is `https://repometer-auth.prince-gdt.workers.dev/auth/github/callback`. It needs no extra repository or account permissions. App registration is managed through GitHub's settings and Cloudflare's secrets; there is no public app-setup endpoint, and client-supplied identity headers grant no administrator access.

## Authentication contract

`/auth/github/start` initiates GitHub OAuth with PKCE and an HttpOnly flow cookie. The callback redirects to Pages with a two-minute, single-use ticket bound to the browser's proof key. `/api/github/exchange` exchanges that ticket for an opaque API session. The GitHub access token remains encrypted in D1. `/api/github/session`, `/api/github`, and `/api/github/logout` use the opaque bearer session without third-party cookies.

CORS allows only the configured Pages origin. The authenticated proxy allows only the GitHub read endpoints required by the counter and never follows redirects with credentials. Stored user tokens use context-bound AES-GCM. Expired flows and sessions are cleaned up when a new sign-in starts.

Worker request logging is disabled to avoid storing OAuth callback codes. `/health` provides a public health check. No runtime secrets or production database contents are included in this repository or the Pages artifact.
