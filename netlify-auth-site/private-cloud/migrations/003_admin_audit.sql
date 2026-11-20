CREATE TABLE IF NOT EXISTS public.arvio_admin_audit (
  id bigserial PRIMARY KEY,
  actor_email text NOT NULL,
  action text NOT NULL,
  target_email text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_arvio_admin_audit_created_at
  ON public.arvio_admin_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_arvio_admin_audit_target_email
  ON public.arvio_admin_audit (target_email, created_at DESC);
