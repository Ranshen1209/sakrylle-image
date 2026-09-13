# AGENTS.md

Repository operating guide for agents working on Sakrylle Image. This file is
standalone and should be updated whenever project facts, deployment behavior, or
Sakrylle-specific product constraints change.

## Project Snapshot

Sakrylle Image is a Sakrylle-branded fork of `CookSleep/gpt_image_playground`,
maintained on `theme/sakrylle` in `Ranshen1209/sakrylle-image`.

- Frontend-only SPA: React 19, TypeScript, Vite 6, Tailwind 3, Zustand 5,
  i18next.
- No backend is shipped from this repo. Browser data lives in
  IndexedDB/localStorage, and provider calls are made from the browser unless a
  deployment explicitly enables a proxy.
- Production site: `https://image.sakrylle.com`.
- Default Sakrylle API base: `https://api.sakrylle.com/v1`.
- Sakrylle OAuth/OIDC base: `https://oidc1.sakrylle.com`.
- Production intentionally uses direct browser calls to
  `https://api.sakrylle.com/v1`; nginx proxy support is opt-in only.

## Hard Constraints

- Preserve the multi-provider architecture. Do not remove OpenAI-compatible,
  custom HTTP, Responses API, or Agent paths because Sakrylle is the default.
- The only Sakrylle image model is `gpt-image-2`
  (`src/lib/apiProfiles.ts::DEFAULT_IMAGES_MODEL`).
- Sakrylle GPT-Image keys are group-scoped. `group_id=5` is the GPT-Image group
  with image generation enabled.
- Keep OAuth PKCE, OAuth Bearer fallback, multi-group selection, and OIDC
  feature flag behavior intact unless the task explicitly changes auth.
- OAuth Bearer fallback is allowed only for official Sakrylle base URLs and only
  when granted scopes allow the requested mode.
- Do not persist translated runtime error/status strings. Use sentinels from
  `src/lib/agentSentinels.ts` so old records remain correct after language
  switches.
- `Sakrylle` is not translated. Technical words such as API, URL, API Key,
  token, and OAuth stay in English.
- Rebase and UI work must preserve the Sakrylle visual system: Monet purple
  palette, Liquid Glass utilities, ambient body class, Sakrylle logo, and the
  dark first-paint FOUC guard.

## API And Auth Facts

- Images API:
  - `POST /v1/images/generations`
  - `POST /v1/images/edits`
- Sakrylle default image generation uses streaming
  `POST /v1/chat/completions` when `streamChatCompletionsImage` is enabled.
- Responses API:
  - `POST /v1/responses`
  - Used by Agent multi-turn conversations and streaming image flows.
- Platform API:
  - `GET /v1/me`
  - `GET /v1/account/balance`
  - `GET /v1/models`
- Canonical v2 scopes:
  `profile:read account:read account:balance:read models:read images:create responses:create offline_access`.
- OIDC adds `openid profile email`.
- Current billing is per successful request, not token-based.

## Environment Variables

Build-time Vite envs:

- `VITE_DEFAULT_API_URL`
- `VITE_SAKRYLLE_PLATFORM_API`
- `VITE_SAKRYLLE_OAUTH_BASE`
- `VITE_SAKRYLLE_OAUTH_CLIENT_ID`
- `VITE_SAKRYLLE_OIDC_ENABLED`
- `VITE_SAKRYLLE_OIDC_ISSUER`

Docker runtime envs injected by `deploy/inject-api-url.sh`:

- `DEFAULT_API_URL`
- `ENABLE_API_PROXY`
- `LOCK_API_PROXY`
- `OAUTH_BASE`
- `OAUTH_CLIENT_ID`
- `OIDC_ENABLED`
- `OIDC_ISSUER`
- `API_PROXY_URL`
- `HOST`
- `PORT`

## Key Files

- `src/store.ts` - Zustand store, task lifecycle, Agent lifecycle, image cache
  subscriptions, import/export.
- `src/lib/apiProfiles.ts` - provider profiles, defaults, validation, model
  constants.
- `src/lib/openaiCompatibleImageApi.ts` - OpenAI-compatible image calls,
  concurrent multi-image splitting, retry/refill behavior.
- `src/lib/chatCompletionsImageApi.ts` - Sakrylle streaming image path.
- `src/lib/sakrylleAuth.ts` - OAuth PKCE, refresh rotation, OIDC token handling.
- `src/lib/groupSelection.ts` - OAuth multi-group selection and group token
  lookup.
- `src/lib/oauthFallback.ts` - OAuth Bearer fallback for image/Responses calls.
- `src/lib/sakrylleAccount.ts` - platform API calls and authed fetch retry.
- `src/lib/sakrylleOidcDiscovery.ts` - OIDC discovery and endpoint fallback.
- `src/lib/i18n.ts`, `src/lib/language.ts`, `src/locales/*.json` - i18n.
- `src/lib/agentSentinels.ts` - persisted status/error sentinel handling.
- `src/lib/theme.ts` - light/dark theme and View Transition switching.
- `src/index.css` - Sakrylle palette, Liquid Glass utilities, ambient
  background.
- `index.html` - title, body class, first-paint FOUC guard, metadata.
- `deploy/Dockerfile`, `deploy/inject-api-url.sh` - Docker build/runtime config
  injection.
- `.github/workflows/docker.yml` - production Docker image build/push workflow.
- `wrangler.jsonc` - optional Cloudflare Assets target; not the current
  production path for `image.sakrylle.com`.

## i18n Rules

- Add new UI strings to both `src/locales/zh.json` and `src/locales/en.json`.
- Keep key sets, placeholders, and non-empty strings in sync; tests enforce this.
- Components should use `useTranslation()`.
- Non-component libs can import `i18n` and call `i18n.t(...)`.
- Persistent messages must use sentinels rather than translated strings.
- Existing profile names such as `新配置`, `默认`, and `（复制）` are persisted
  data and need migration care before changing.

## Theme And Branding

- `index.html` must keep the dark-mode first-paint IIFE before blocking styles.
- `body` must keep the `sakrylle-ambient` class.
- New glass-like UI should reuse `.glass-panel`, `.glass-card`,
  `.glass-input-shell`, `.glass-button`, and `.glass-button-primary`.
- Avoid reintroducing Tailwind `blue-*` styling in Sakrylle UI. Use the existing
  Monet purple values and palette.
- `src/components/icons.tsx::SakrylleLogo` is the canonical logo. Do not restore
  the old `public/pwa-icon.svg` flow.
- Header intentionally removed the install-app prompt and help modal entry.

## Multi-Image Behavior

For Sakrylle `gpt-image-2`, upstream ignores single-request `n > 1`; the app
must split multi-image requests into parallel `n:1` calls.

- `MAX_CONCURRENT_IMAGE_REQUESTS` is intentionally 6.
- Retry/refill behavior must preserve partial success handling and avoid
  unlimited extra paid requests.
- A fully successful refill should not surface as partial failure; exhausted
  refill budget should keep successful images and show partial failure.

## Tests And Commands

Common commands:

```bash
npm install
npm run dev
npm run mock:api
npm run test
npm run test:watch
npx vitest run src/lib/someFile.test.ts
npm run build
npm run preview
```

Run focused tests for touched areas when possible. Important suites include:

- `src/lib/sakrylleAuth.test.ts`
- `src/lib/sakrylleAccount.test.ts`
- `src/lib/sakrylleOidcDiscovery.test.ts`
- `src/lib/oauthFallback.test.ts`
- `src/lib/groupSelection.test.ts`
- `src/lib/sakrylleImageSize.test.ts`
- `src/lib/agentSentinels.test.ts`
- `src/lib/agentApi.test.ts`
- `src/locales/locales.test.ts`
- `src/lib/apiProfiles.test.ts`
- `src/lib/api.test.ts`
- `src/lib/urlSettings.test.ts`
- `src/store.test.ts`

If changing default API literals, update matching test assertions.

## Release And Deployment

- Production runs on the Los Angeles Docker host `sakrylle-la`, reached via
  `ssh-sakrylle`; Tokyo is retired. Compose: `/opt/stack/docker-compose.yml`.
- Existing service/container: `gpt-image-playground`; repository:
  `ghcr.io/ranshen1209/gpt_image_playground`. Pin deployments by digest.
- Nginx route: `/opt/stack/nginx/conf.d/sakrylle-image.conf`, forwarding to
  `http://gpt-image-playground:80`; preserve the shared TLS/edge configuration.
- Push `theme/sakrylle`, manually dispatch `docker.yml`, verify its head SHA,
  successful tests and release-provenance artifact, then deploy that digest.
- Back up Compose/configuration on the server before changing only this service.
  Validate with `sudo docker compose config --quiet`, then pull and run
  `sudo docker compose up -d --no-deps gpt-image-playground` in `/opt/stack`.
- See `docs/production.md` for verification and rollback requirements.
- `npm run deploy:cf` deploys to Cloudflare via Wrangler and requires
  `CLOUDFLARE_API_TOKEN`; do not treat it as the production Docker path unless
  hosting changes.
- Bump both `package.json` version and `public/sw.js` cache name for formal
  releases. Otherwise old Service Worker chunks may remain active.
- GitHub Actions Docker build is normally triggered manually with
  `workflow_dispatch`; do not rely on tag push alone.
- Rollback must use a recorded image digest. The `latest` tag moves.
- OAuth redirect URIs are owned by sub2api. To add or change callback domains,
  update `oauth_clients.redirect_uris` in sub2api, not this repo.

## Upstream Sync

Normal upstream flow:

```bash
git fetch upstream
git checkout theme/sakrylle
git rebase upstream/main
```

Expected conflict hotspots:

- `index.html`
- `src/index.css`
- `src/lib/apiProfiles.ts`
- `src/components/Header.tsx`
- `src/components/SettingsModal.tsx`
- `src/components/icons.tsx`
- `src/main.tsx`
- `src/App.tsx`
- `tailwind.config.js`
- `README.md`
- `public/manifest.webmanifest`
- `public/favicon.png`
- `package.json`
- `public/sw.js`
- `deploy/Dockerfile`
- `deploy/inject-api-url.sh`
- `src/vite-env.d.ts`
- `src/store.ts`

When upstream adds UI, check for `blue-*` Tailwind classes and convert them to
the Sakrylle palette. `src/components/HelpModal.tsx` is intentionally deleted;
keep it deleted unless the product decision changes.

## Documentation Governance

This repo now keeps agent-facing project facts in `AGENTS.md`. Shared platform
identity contracts remain outside this repo in the Sakrylle/sub2api docs.

When changing OAuth/OIDC client behavior, `VITE_SAKRYLLE_*` envs,
`OIDC_ENABLED`, token storage, discovery, nonce/id_token handling, logout/revoke,
group routing, or Image rollout status, update the shared platform docs if the
shared contract changes.
