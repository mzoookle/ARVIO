# Administrator dashboard

The private-cloud administrator dashboard is served by the auth portal at `/admin`. It is intentionally independent of the ARVIO Web and Android clients.

Set `ARVIO_ADMIN_EMAILS` on the private-cloud API service to a comma-separated list of exact email addresses for provisioned administrator accounts. An authenticated ARVIO account is not automatically an administrator.

The first release supports account listing, account/sync metadata inspection, and generated temporary password resets. Settings inspection is limited to profile names and sync metadata. Editing ARVIO preferences is not enabled until the settings schema and write semantics have been reviewed.

See `PHASE-2-ADMIN-DASHBOARD.md` for deployment and validation instructions.
