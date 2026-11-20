-- Store groups from the most recently verified Keycloak ID token.
-- These values are written only by the OIDC callback after signature/issuer/audience validation.
ALTER TABLE public.arvio_oidc_identities
  ADD COLUMN IF NOT EXISTS groups text[] NOT NULL DEFAULT ARRAY[]::text[];
