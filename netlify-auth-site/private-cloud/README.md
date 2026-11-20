# ARVIO Private Cloud — 2.4 compatibility foundation

This overlay runs ARVIO 2.4's existing account and Cloud synchronization handlers outside Netlify. It replaces Netlify Blobs with PostgreSQL, provides a small Node.js HTTP adapter for the existing function handlers, and self-hosts the account portal.

## What is included

- `postgres-blob-store.js`: PostgreSQL implementation of the Netlify Blob methods used by ARVIO, including both `list()` modes, opaque conditional-write ETags, and AES-256-GCM encryption of Blob values and metadata at rest.
- `runtime-store.js`: switches the original backend to PostgreSQL only when `ARVIO_PRIVATE_CLOUD=true`.
- `server.js`: exposes the existing function handlers over HTTP.
- `portal.Dockerfile` and `nginx-portal.conf`: serves ARVIO's account portal and proxies its original `/.netlify/functions/*` paths to the private API.
- `portal-config.js.template` and `portal-entrypoint.sh`: inject the private app key and allowed Web origin at container startup. The upstream hosted Supabase key is removed from the portal HTML.
- `migrations/`: account compatibility schema, Blob storage, and opaque ETags.
- `create-account.js`: creates the initial private account using ARVIO's existing scrypt password format.
- `tests/postgres-blob-store.test.js`: PGlite tests for storage, both list modes, namespace isolation, conditional writes, and ETag reuse prevention.

## Scope and account policy

- Public signup is disabled by default. Create the first account with the administrator CLI.
- The account portal supports login, TV pairing, password setup/recovery, and account deletion.
- Core profile snapshot synchronization, IPTV/addon/catalog/settings data, and the existing account merge behavior remain in ARVIO's original handlers.
- The private API also includes SIMKL/Trakt/TMDB proxy endpoints, Discord device pairing, and opt-in app-usage events. If you use those proxies, set `SIMKL_CLIENT_ID`/`SIMKL_CLIENT_SECRET`, `TRAKT_CLIENT_ID`/`TRAKT_CLIENT_SECRET`, and `TMDB_API_KEY` in the private backend environment using your existing provider credentials. Those integrations still communicate with their respective providers, but not with ARVIO's hosted infrastructure.
- Premium membership, partner/referral systems, public catalog submissions, and hosted analytics reporting are intentionally not part of this private Cloud deployment.
- Discord Rich Presence device pairing requires an OAuth application whose redirect URL is configured for your private portal. It is optional and not required for profile synchronization.

## Run the storage tests

From `netlify-auth-site`:

```sh
npm ci
npm run private-cloud:test
```

The test suite uses the repository's `@electric-sql/pglite` development dependency. Production uses the existing `pg` dependency and PostgreSQL.

## Database migrations

Apply these migrations to the dedicated private Cloud database, in order:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f private-cloud/migrations/000_arvio_cloud_core.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f private-cloud/migrations/001_blob_store.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f private-cloud/migrations/002_blob_etag.sql
```

The first migration creates account/snapshot compatibility tables from ARVIO's existing database schema. The second adds namespaced Blob records. The third adds opaque per-write ETags and safely upgrades a table created by the earlier phase-1 overlay.

All new Blob values and metadata are encrypted with `ARVIO_BLOB_ENCRYPTION_KEY`. Generate a 64-character hexadecimal key with `openssl rand -hex 32`, store it in your secret manager, and back it up separately from PostgreSQL. Losing this key makes encrypted account/profile data unrecoverable. Earlier phase-1 plaintext rows remain readable and are encrypted when rewritten.

## Create the first private account

Public account creation is disabled by default when `ARVIO_PRIVATE_CLOUD=true`. After applying migrations, run this inside the backend container or a one-off container with the same database environment:

```sh
node private-cloud/create-account.js your-real-email@example.com
```

The script prompts for a password without echoing it. It writes the account in the same `arvio-auth` key format and scrypt encoding expected by ARVIO 2.4. Use a real email address if you intend to test password recovery; the upstream validation rejects reserved example domains.

## Incus Compose deployment

This Compose project has three services:

- `db`: PostgreSQL 17 with a persistent volume.
- `arvio-private-cloud`: the Node.js API on internal port `3000`.
- `arvio-auth-portal`: NGINX serving the account pages on internal port `8080` and proxying `/.netlify/functions/*` to the API.

The Compose file is intended for your Incus Compose + Buildah workflow. Build both images from the `netlify-auth-site` directory:

```sh
buildah bud -f private-cloud/Dockerfile -t local/arvio-private-cloud:0.1.0 .
buildah bud -f private-cloud/portal.Dockerfile -t local/arvio-auth-portal:0.1.0 .
```

Apply the database migrations before creating an account or testing login.

### Public hostnames and routing

Use two HTTPS hostnames, for example:

| Hostname | Upstream | Purpose |
|---|---|---|
| `arvio-sync.example.net` | `arvio-private-cloud:3000` | Android and browser Cloud API |
| `auth.example.net` | `arvio-auth-portal:8080` | Login, TV pairing, password recovery, account deletion |

The Compose file uses `expose`, not host-published ports. Attach the services to a network reachable by your reverse proxy or add the appropriate Incus proxy devices. Both hosts must be reachable without an interactive Pomerium login. The API authenticates app-level requests and signed user tokens itself; an interactive proxy redirect would break Android and browser background synchronization. Private-mode CORS is restricted to `ARVIO_WEB_ORIGIN`. Configure the external reverse proxy for the API host to accept at least 5 MiB request bodies; the Node API defaults to a 5 MiB limit. For the first tests, keep both hosts on your LAN or VPN. Before internet exposure, add edge rate limits for login, password-reset, device-pairing, and account-deletion endpoints; the app-level key is public and is not a substitute for rate limiting. The account portal is also a login surface and must not be hidden behind an interactive proxy login. Keep the API on HTTPS and use your existing reverse proxy for TLS and routing.

Set the portal environment and keep `ARVIO_AUTH_SECRET` and `ARVIO_BLOB_ENCRYPTION_KEY` stable across restarts and backups:

```env
SITE_URL=https://auth.example.net
TV_AUTH_VERIFY_BASE_URL=https://auth.example.net
DISCORD_AUTH_VERIFY_BASE_URL=https://auth.example.net
ARVIO_WEB_ORIGIN=https://arvio.example.net
```

`SITE_URL` is the account portal origin used for password setup links and device verification. `ARVIO_WEB_ORIGIN` is the exact HTTPS origin allowed as a post-login redirect target.

### Web application environment

```env
NEXT_PUBLIC_SELF_HOSTED=true
NEXT_PUBLIC_ARVIO_PRIVATE_CLOUD_URL=https://arvio-sync.example.net
ARVIO_PRIVATE_CLOUD_ENABLED=true
ARVIO_PRIVATE_CLOUD_URL=http://arvio-private-cloud:3000
APP_ANON_KEY=<same private app key used by Android and the portal>
```

`NEXT_PUBLIC_ARVIO_PRIVATE_CLOUD_URL` is the browser-visible API URL for account snapshot sync. `ARVIO_PRIVATE_CLOUD_URL` is the internal service URL used by the Next.js authentication proxy. Use `http://arvio-private-cloud:3000` only if the Web container shares a network with this Compose project; otherwise use an internal address reachable from the Web container. Keep `APP_ANON_KEY` server-side in the web deployment; the browser uses the Next.js proxy for login and token refresh.

### Android build configuration

Set these in `secrets.properties` or the equivalent Gradle environment:

```properties
NETLIFY_BACKEND_URL=https://arvio-sync.example.net
APP_ANON_KEY=<same private app key>
```

The 2.4 Gradle overlay allows the configured private backend URL to satisfy the release endpoint validation without requiring a live Supabase URL. Android's Netlify-compatible Cloud sync path does not open the Supabase Realtime socket when `NETLIFY_BACKEND_URL` is configured.

`APP_ANON_KEY` is an app-level public identifier, not a password. It must match the backend and portal configuration; user authentication is still enforced by per-account passwords and signed bearer tokens. Generate a random value, for example with `openssl rand -hex 32`.

## Current limitations and test status

- The Android 2.4 endpoint constants have been statically checked against the private HTTP router.
- JavaScript syntax checks passed for the backend, router, adapter, and test files.
- The PGlite integration tests have not yet been executed in this environment because package installation could not complete. Run them locally after `npm ci`.
- Android and Web production builds, email delivery, live PostgreSQL integration, and end-to-end cross-device tests remain pending.
- Existing ARVIO-hosted accounts and snapshots are not automatically imported. Do not point your daily-use clients at this service until the import strategy and end-to-end tests are complete.

## Administrator-managed password resets

This private deployment does not require an outbound email provider. The account portal's **Forgot password?** action now explains that users must contact the server administrator; it no longer calls `cloud-auth-reset` or attempts email delivery.

To reset an existing account password, run the following inside the API container (or an equivalent Node.js environment with the same `pg` dependency and database environment):

```sh
node private-cloud/reset-password.js user@example.net
```

The command prompts for the new password twice without echoing either entry. It requires at least 8 characters, updates the existing account's scrypt password hash, and uses the Blob record's ETag for a conditional write. The account ID, email, creation timestamp, and all profile/snapshot records remain unchanged. It requires `ARVIO_DATABASE_URL` or `DATABASE_URL`, plus the same `ARVIO_BLOB_ENCRYPTION_KEY` used by the API. Run it from an interactive terminal; passwords are deliberately not accepted as command-line arguments or environment variables.

The account portal footer now contains only a neutral **About ARVIO** link to the project's public website. It no longer advertises Premium, memberships, or purchases.


## Administrator operations

For account creation, administrator password resets, PostgreSQL backup/restore, and protecting the encryption/signing secrets, see the project-level `ADMIN-OPERATIONS.md` guide. The reset CLI can inherit missing database and blob-encryption environment values from the API process when run inside the API container; see that guide for its scope and limitations.
