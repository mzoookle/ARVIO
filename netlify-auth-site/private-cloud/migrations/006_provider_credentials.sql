-- Provider grants are owned by the ARVIO account, never by an Android install.
CREATE TABLE IF NOT EXISTS public.arvio_provider_credentials (
  account_id uuid NOT NULL REFERENCES public.arvio_accounts(id) ON DELETE CASCADE,
  profile_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('simkl', 'wetrakr')),
  status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('pending', 'connected', 'reconnect_required', 'disconnected')),
  secret_ciphertext text,
  pending_ciphertext text,
  provider_user_id text,
  provider_username text,
  scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  refresh_expires_at timestamptz,
  connected_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, profile_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_arvio_provider_credentials_status
  ON public.arvio_provider_credentials (account_id, status, provider);
