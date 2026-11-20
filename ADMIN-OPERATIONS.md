# ARVIO Private Cloud — Administrator Operations

This guide covers routine administration for the ARVIO 2.4 private-cloud deployment. It assumes the API and auth portal are deployed with Incus Compose, and PostgreSQL is managed in its own project.

## 1. Create an account

Run the existing account-creation CLI inside the API container:

```sh
incus exec -it YOUR_API_INSTANCE -- node private-cloud/create-account.js user@example.net
```

It prompts for the password interactively. Public self-registration remains disabled. Use the actual Incus instance name reported by `incus-compose ps`.

## 2. Reset an account password

Run:

```sh
incus exec -it YOUR_API_INSTANCE -- node private-cloud/reset-password.js user@example.net
```

The reset CLI now automatically reads missing `DATABASE_URL`, `ARVIO_DATABASE_URL`, and `ARVIO_BLOB_ENCRYPTION_KEY` values from the running API process environment (`/proc/1/environ`). Values explicitly supplied to the CLI take precedence. This is designed for execution inside the API container; it does not fetch secrets from another Incus instance or project.

The command prompts twice without echoing the password, requires at least eight characters, and updates the existing encrypted account Blob using its ETag. It preserves the account ID and synced profile/snapshot data. Do not pass passwords as command-line arguments or environment variables.

If `/proc/1/environ` is unavailable or does not contain the required variables, the command fails with the usual missing-environment error. In that case, check the API instance's service environment rather than generating a new encryption key.

## 3. Database backups

Back up PostgreSQL regularly using `pg_dump` from a PostgreSQL client/container that can reach the database. For a custom-format backup:

```sh
pg_dump --format=custom --no-owner --no-acl \
  --dbname="$DATABASE_URL" \
  --file=arvio-cloud-$(date +%F).dump
```

Protect the dump as sensitive data: it contains account records and user profile data. Store it somewhere separate from the live database and restrict access. If your database runs in a separate Incus Compose project, run the command from a client with network access to that database; do not assume the API container can resolve the database service name across projects.

A successful backup should be accompanied by periodic restore tests into a separate, non-production database. A dump that has never been restored is not a verified recovery plan.

## 4. Back up encryption and signing secrets

Keep these secrets outside the database backup, in a protected secret manager or offline encrypted backup:

- `ARVIO_BLOB_ENCRYPTION_KEY` — required to decrypt encrypted Blob data and metadata. Losing it can make encrypted account/profile data unrecoverable.
- `ARVIO_AUTH_SECRET` — required to preserve token-signing continuity across restarts and restores.
- `APP_ANON_KEY` — shared app identifier used by the API, portal, and clients; preserve it for consistent client configuration.

Never rotate `ARVIO_BLOB_ENCRYPTION_KEY` casually. A key rotation requires a deliberate data re-encryption procedure; replacing the value alone will make existing encrypted records unreadable. Do not put secrets in shell history, support tickets, screenshots, or source control.

## 5. Restore procedure (high level)

1. Stop or place the API and portal into maintenance mode so writes cannot race the restore.
2. Restore the PostgreSQL dump into the intended database using `pg_restore`:

   ```sh
   pg_restore --clean --if-exists --no-owner --no-acl \
     --dbname="$DATABASE_URL" arvio-cloud-YYYY-MM-DD.dump
   ```

3. Restore the matching `ARVIO_BLOB_ENCRYPTION_KEY` and `ARVIO_AUTH_SECRET` values from the protected secret backup.
4. Confirm the API container has the expected database URL and secrets; start the API and check its health endpoint.
5. Test login, profile pull, and a harmless profile update before returning the service to users.

The exact restore flags may need adjustment if restoring into a database that contains unrelated schemas or objects. Prefer a clean, dedicated target database for disaster-recovery tests.

## 6. Operational checks

- Check API and portal health after deployment or restart.
- Monitor PostgreSQL disk usage and backup age.
- Keep the API and portal reachable over HTTPS, with interactive Pomerium authentication bypassed only for the required public endpoints; the API must continue validating its own app key and user bearer tokens.
- Apply edge rate limits to login, device pairing, account deletion, and other authentication-sensitive routes before broad public exposure.
- Keep a record of the deployed source/patch version and image tags so a rollback uses a compatible application and database schema.

## 7. What this deployment intentionally does not provide

- No public account signup.
- No email-based password reset; users contact the administrator.
- No requirement for an outbound email provider.
- Discord device integration is optional and can remain unused.
