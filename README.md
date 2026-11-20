# ARVIO Private Cloud – Web auth handoff fix (Phase 1.3)

This is a small source overlay for the ARVIO 2.4 Web app, intended to be applied **on top of** the Phase 1.2 private-cloud overlay.

## What it fixes

The Phase 1.2 backend/auth work enabled private API authentication, but the 2.4 Web UI still treated every self-hosted build as local-only:

- The Account settings screen hid the Cloud sign-in button in self-hosted mode.
- The login screen did not count the private backend as a configured Cloud provider because the app key is intentionally kept server-side.
- `getAuthPortalUrl()` returned `/` for self-hosted builds instead of the separate private auth portal.
- The auth callback discarded portal tokens whenever `NEXT_PUBLIC_SELF_HOSTED=true`.

This overlay adds `NEXT_PUBLIC_ARVIO_AUTH_PORTAL_URL`, exposes the private Cloud sign-in path, and accepts the validated portal token handoff. It does not expose `APP_ANON_KEY` to the browser. Auth login/refresh continue through the existing Next.js server proxy; account snapshot sync uses the browser-visible private API URL and the user's bearer token.

## Apply

From the ARVIO repository root, copy the included `web/` directory over the existing `web/` directory, preserving paths.

Add this build-time variable to the Web Dockerfile **before** `RUN npm run build`:

```dockerfile
ENV NEXT_PUBLIC_ARVIO_AUTH_PORTAL_URL=https://auth.example.net
```

Use the actual HTTPS hostname of your private auth portal. This is a `NEXT_PUBLIC_` variable because the browser needs to navigate to the portal. It is not a credential.

Keep the existing settings:

```dockerfile
ENV NEXT_PUBLIC_SELF_HOSTED=true
ENV NEXT_PUBLIC_ARVIO_PRIVATE_CLOUD_URL=https://arvio-sync.example.net
ENV ARVIO_PRIVATE_CLOUD_ENABLED=true
ENV ARVIO_PRIVATE_CLOUD_URL=http://arvio-private-cloud:3000
ENV APP_ANON_KEY=YOUR_SHARED_APP_KEY
```

`APP_ANON_KEY` must remain a server-side build/runtime variable and must not be renamed to `NEXT_PUBLIC_APP_ANON_KEY` or otherwise exposed in the browser.

Rebuild the Web image (a fresh build is required because `NEXT_PUBLIC_*` values are baked into the client bundle), then recreate the Web instance.

## Expected test

1. Open ARVIO Web → Settings → Account.
2. It should offer **Sign in with ARVIO Cloud**, rather than saying Cloud is not connected.
3. Sign in. The auth portal should redirect back to the Web origin with a URL fragment containing the short-lived handoff tokens.
4. Web should consume the fragment, remove it from the address bar, and show the signed-in account.
5. In DevTools Network, expect `account-sync-pull` after sign-in. Profile creation/editing should result in `account-sync-push`.
6. Sign in from a fresh browser and verify the same profiles appear.

Do not share token values from the URL or Network responses. If sync calls fail, capture only request path, status code, and redacted error body.
