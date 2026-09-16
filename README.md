# Repometer

Live line counts for GitHub repositories, folders, and pull requests, with side-by-side repository comparisons.

**[Open Repometer](https://blaizzy.github.io/repometer/)** · [Compare mlx-vlm and mlx-audio](https://blaizzy.github.io/repometer/compare.html?left=Blaizzy%2Fmlx-vlm&leftRef=main&right=Blaizzy%2Fmlx-audio&rightRef=main)

## Features

- Search public repositories or paste a repository, folder, or pull request URL.
- Count an entire repository or any folder at a branch, tag, or commit.
- Compare PR head counts with the merge base, alongside GitHub's PR diff totals.
- Compare two repositories or folders with matching file filters.
- Explore file types, folders, and individual file counts.
- Refresh automatically, preserving the last complete result when a request fails.
- Sign in with GitHub for your account's API allowance, or optionally use a personal access token.

Counts are physical lines, including comments, blank lines, and a final line without a newline. Text documentation, generated files, and vendored text are included. Binary files, non-UTF-8 files, symlinks, and submodules are excluded. Public repositories only.

## Run locally

Node.js 24 is recommended. There are no frontend npm dependencies to install.

```sh
npm run dev
```

Open `http://127.0.0.1:4177/repometer/`. The local preview uses the same project subpath as GitHub Pages. Public access and personal tokens work locally; GitHub sign-in is disabled in the unconfigured preview.

```sh
npm test
npm run build
```

## Deployment

The `Deploy GitHub Pages` workflow tests and builds the project, then deploys `dist/` on pushes to `main`. Pull requests run tests and the build without publishing. Pages is configured to use GitHub Actions.

Set the repository's GitHub Actions secret `AUTH_ORIGIN` to the authentication backend's HTTPS origin. The deployment build injects it into `dist/site-config.mjs` and fails if it is missing or invalid. Pull request builds do not receive the secret and keep GitHub sign-in disabled. The endpoint becomes public browser configuration in the deployed site; OAuth credentials remain on the backend.

- `web/`: browser UI and counting engine.
- `scripts/`: build, local preview, and frontend tests.
- `server/`: JavaScript authentication service and its tests/migrations.
- `dist/`: generated static Pages output; it contains no server source or credentials.

Relative links keep search, comparison, assets, and shared selections under `/repometer/`. `compare.html` is the canonical comparison route; `/compare/` redirects while preserving the selection.

## GitHub sign-in

GitHub Pages serves the frontend. A separate JavaScript backend handles OAuth and authenticated GitHub API requests. Its endpoint is injected during deployment from the `AUTH_ORIGIN` repository secret.

The browser is redirected to GitHub and returned to the same Pages selection. GitHub's app secret and user access tokens stay on the server. The backend encrypts stored credentials and gives the browser an opaque, revocable session credential, stored only in the current tab's session. Both OAuth and the handoff to Pages use proof keys and single-use state or tickets. Sessions last up to eight hours. Disconnect invalidates the server session and removes the tab credential.

The optional personal-token method sends the token directly to `api.github.com`, stores it in the tab's session, and removes it when disconnected. Raw public files are fetched without authentication. Authenticated counting checks for changes every two minutes; public access checks every five minutes. GitHub rate-limit headers control retry backoff.

See [`server/README.md`](server/README.md) for the backend contract and deployment requirements.
