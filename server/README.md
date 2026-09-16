# Repometer authentication service

This Cloudflare-compatible JavaScript Worker is deployed separately from GitHub Pages, using Sites and a D1 SQLite binding named `DB`. The existing deployment is `https://repometer-auth.prince-gdt.chatgpt.site`.

The Pages deployment workflow does not publish this service. Backend changes require a separate backend deployment and applying the versioned SQL migrations in `drizzle/`.

Runtime configuration:

| Variable | Purpose |
| --- | --- |
| `SITE_ORIGIN` | HTTPS origin of the authentication service |
| `FRONTEND_URL` | Exact application base URL, including its trailing slash |
| `GITHUB_SESSION_KEY` | Secret: 32 random bytes encoded as base64url, for AES-GCM encryption |
| `SITE_OWNER_EMAIL` | Secret: verified setup administrator email |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Optional credentials for a pre-registered GitHub App; the secret must remain in the hosting secret store |

The one-time `/auth/github/setup` flow can register the GitHub App from a manifest and encrypt its credentials in D1. It requires trusted Sites identity headers for the verified owner. Those headers are provided by the hosting gateway; deploying on another host requires replacing that setup authorization with the host's trusted administrator authentication. Do not trust client-supplied copies of those headers.

Normal GitHub sign-in and API access do not require an OpenAI account. `/auth/github/start` initiates GitHub OAuth with PKCE and an HttpOnly flow cookie. The callback redirects to Pages with a two-minute, single-use ticket bound to the browser's proof key. `/api/github/exchange` exchanges that ticket for an opaque API session. The GitHub access token remains encrypted on the server. `/api/github/session`, `/api/github`, and `/api/github/logout` use the opaque bearer session without relying on third-party cookies.

CORS allows only the configured Pages origin. The authenticated proxy allows only the GitHub read endpoints required by the counter and never follows redirects with credentials. Database records are encrypted with context-bound AES-GCM, and expired flows and sessions are cleaned up as new sign-in flows begin.

No runtime secrets, private Site credentials, or production database contents are included in this repository or the Pages artifact.
