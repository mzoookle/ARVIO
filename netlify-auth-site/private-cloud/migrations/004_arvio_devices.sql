-- Run once against the existing ARVIO PostgreSQL database.
-- Installation IDs are random, app-local UUIDs; no hardware identifiers are collected.
CREATE TABLE IF NOT EXISTS public.arvio_devices (
    account_id text NOT NULL,
    installation_id uuid NOT NULL,
    account_email text NOT NULL,
    package_name text NOT NULL,
    device_name text NOT NULL,
    manufacturer text,
    model text,
    android_release text,
    android_sdk integer,
    version_name text NOT NULL,
    version_code bigint NOT NULL CHECK (version_code > 0),
    last_ip inet,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(account_id, installation_id)
);
CREATE INDEX IF NOT EXISTS arvio_devices_last_seen_idx ON public.arvio_devices(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS arvio_devices_account_idx ON public.arvio_devices(account_id);
-- Privacy-friendly maintenance (schedule daily via your PostgreSQL cron/host job):
-- DELETE FROM public.arvio_devices WHERE last_seen_at < now() - interval '90 days';
