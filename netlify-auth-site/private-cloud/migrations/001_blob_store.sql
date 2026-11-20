-- PostgreSQL replacement for the Netlify Blobs API used by ARVIO's backend.
-- Store names remain separate namespaces, matching getStore(name).
CREATE TABLE IF NOT EXISTS public.arvio_blob_records (
  store_name text NOT NULL,
  blob_key text NOT NULL,
  data jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  etag text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_name, blob_key)
);

CREATE INDEX IF NOT EXISTS arvio_blob_records_store_updated_idx
  ON public.arvio_blob_records (store_name, updated_at DESC);

CREATE INDEX IF NOT EXISTS arvio_blob_records_store_key_prefix_idx
  ON public.arvio_blob_records (store_name, blob_key text_pattern_ops);
