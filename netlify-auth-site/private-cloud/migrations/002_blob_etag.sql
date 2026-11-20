-- Add opaque per-write ETags to existing private Cloud Blob records.
-- UUID text values prevent stale conditional writes from matching a record
-- that was deleted and later recreated with the same key.
ALTER TABLE public.arvio_blob_records
  ADD COLUMN IF NOT EXISTS etag text;

UPDATE public.arvio_blob_records
   SET etag = '"' || md5(random()::text || clock_timestamp()::text || store_name || blob_key) || '"'
 WHERE etag IS NULL;

ALTER TABLE public.arvio_blob_records
  ALTER COLUMN etag SET NOT NULL;
