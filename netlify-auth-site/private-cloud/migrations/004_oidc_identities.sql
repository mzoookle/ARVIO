-- Maps a verified external OIDC identity to one stable ARVIO account.
CREATE TABLE IF NOT EXISTS public.arvio_oidc_identities (
  issuer text NOT NULL,
  subject text NOT NULL,
  account_id text NOT NULL,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject),
  UNIQUE (issuer, account_id)
);
CREATE INDEX IF NOT EXISTS arvio_oidc_identities_account_idx
  ON public.arvio_oidc_identities (account_id);
CREATE INDEX IF NOT EXISTS arvio_oidc_identities_email_idx
  ON public.arvio_oidc_identities (email);
