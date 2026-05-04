# OAuth login + projects + documents commands

**Date:** 2026-05-01
**Branch:** `feat/oauth-cli-and-projects-documents`

## Summary

Three additions to the CLI:

1. **OAuth Authorization Code + PKCE login** — `devic auth login` now opens
   the browser by default and exchanges a PKCE code for RS256 access +
   refresh tokens. `--api-key` is preserved as the explicit legacy /
   headless / CI flow.
2. **Token persistence + auto-refresh** — tokens stored in
   `~/.config/devic/config.json` under `oauth: {accessToken, refreshToken,
   expiresAt, scope, clientId}`. Proactive refresh 60s before expiry,
   reactive refresh on 401 with retry-once.
3. **Projects + documents commands** — `devic projects list/get`,
   `devic documents list/create/update/delete/...`, and `--project` flag
   added to `agents`/`assistants` create commands.

## Files

### New

- `src/oauth.ts` — PKCE generation (S256 base64url), loopback HTTP
  callback server with HTML success/error page, code-for-tokens exchange,
  refresh, revoke. Cross-platform `openBrowser`.
- `src/commands/projects.ts` — list/get + project-scoped lookups.
- `src/commands/documents.ts` — full CRUD against the new public API.

### Modified

- `src/commands/auth.ts` — login defaults to OAuth, `--api-key` keeps
  legacy. `auth status` reports mode + expiry. `auth logout` revokes the
  refresh token before deleting local config.
- `src/config.ts` — `loadConfig` now returns the `oauth` field.
- `src/helpers.ts` — `createClient` reads OAuth tokens, passes
  `refreshToken` callback and `shouldRefreshProactively` (60s skew).
- `src/client.ts` — refresh lock to prevent stampedes, proactive refresh
  before request when needed, retry once on 401 with refreshed token.
- `src/types.ts` — `OAuthTokens` interface, `oauth` field in `CliConfig`.
- `src/commands/{agents,assistants}.ts` — `--project <uid>` flag on
  create.
- `src/index.ts` — register new commands.

## Behavioural changes for users

```bash
# New default: browser-based OAuth login
devic auth login

# Existing CI/headless flow: unchanged
devic auth login --api-key $DEVIC_API_KEY --base-url $DEVIC_API_URL

# New commands
devic projects list
devic documents list --project <uid>
devic agents create --name "..." --project <uid>
```

`auth status --output json` now includes a `mode` field (`"oauth"` or
`"api_key"`). Existing CI parsers that read only the exit code are
unaffected.

## Production deploy notes

- The CLI talks to `<base-url>/oauth/*` for login. Once the API gateway
  proxy lands, that path resolves to security via the gateway. CLI
  doesn't care which service hosts it.
- Loopback redirect uri `http://127.0.0.1:<port>/cli-callback` is
  whitelisted in the seeded `devic-cli` OAuth client (regex pattern in
  security's seed data).
- Default frontend URL is `https://app.devic.ai`, override with
  `--frontend-url` or `DEVIC_FRONTEND_URL`.

## Test plan

- [ ] `devic auth login` opens browser, completes consent, persists tokens.
- [ ] `devic auth status` shows `mode: oauth` with expiry.
- [ ] `devic projects list` works with the OAuth token.
- [ ] After 30 min (or by tampering `expiresAt`), the next request triggers
      proactive refresh; `auth status` shows the new expiry.
- [ ] `devic auth login --api-key $KEY` works in CI without browser.
- [ ] `devic auth logout` revokes refresh + deletes config.

## Out of scope

- Confidential client support (would require user-supplied
  `--client-secret`).
- Device code grant for headless devices that can't open a browser
  (consider for future when third-party clients onboard).
- Persisting per-profile configs (`~/.config/devic/<profile>.json`).
