# Sakrylle Image production

Verified 2026-09-13: `image.sakrylle.com` resolves to `154.44.8.202` and is
served on Los Angeles `sakrylle-la`, SSH alias `ssh-sakrylle`. Tokyo is retired.

Compose: `/opt/stack/docker-compose.yml`. Service/container: `gpt-image-playground`.
Image repository: `ghcr.io/ranshen1209/gpt_image_playground`; server: linux/amd64.
Nginx: `/opt/stack/nginx/conf.d/sakrylle-image.conf` forwards to the container's
port 80. There are no Image mounts or published host ports. Preserve shared
networks, edge stream routing, certificates, and other services.

## Release

Use Node from `.nvmrc` and its bundled npm. Run `npm ci`, `npm run test`, and
`npm run build`. Build `deploy/Dockerfile` and check runtime injection with
public test configuration. Bump package/lock versions and `public/sw.js` cache.
Push `theme/sakrylle`, then manually run:

```sh
gh workflow run docker.yml --repo Ranshen1209/sakrylle-image --ref theme/sakrylle
```

Require a successful run whose head SHA matches the intended release. Download
its `release-provenance` artifact. Inspect the manifest for linux/amd64 and
revision labels; use the artifact's immutable digest, never floating latest.

## Deploy and rollback

On the server create a root-only timestamped backup directory. Save Compose,
Image inspection/configuration and the Nginx route; record the existing pinned
image digest and retain that local image. Write a rollback script which restores
the saved Compose and runs config validation and `up -d --no-deps` for Image.
Do not expose environment secrets in release logs.

Change only the existing Image service's image reference to the verified digest.
From `/opt/stack`, use `sudo docker compose config --quiet`,
`sudo docker compose pull gpt-image-playground`, then
`sudo docker compose up -d --no-deps gpt-image-playground`.

Verify health, image identity, HTTPS and every entry JS/CSS resource, replaced
build placeholders, default API `https://api.sakrylle.com/v1`, OAuth/OIDC
`https://oidc1.sakrylle.com`, OIDC enabled, and browser direct API calls.
Check desktop/mobile, both themes/languages, new Service Worker, existing history,
login/group selection and one authorized test generation. Record account-dependent
checks as unverified when no test account is available.

For a critical release regression immediately execute the saved rollback script
and verify the old digest, container health and HTTPS. Do not rebuild or resolve
`latest` for rollback. Retain the backup path, old/new digests, commit, run URL,
and verification results in the release handoff.
