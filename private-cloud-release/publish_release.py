#!/usr/bin/env python3
"""Publish a signed APK + integrity manifest to a local static web root.

Requires Android SDK build-tools (`apksigner`, `apkanalyzer`) in PATH.
The script is intentionally local-only: publishing is never exposed as an HTTP endpoint.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

from apk_signing_cert import signing_certificate_sha256

PACKAGE = "com.arvio.tv.private"


def tool_output(*command: str) -> str:
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=True)
    except FileNotFoundError as exc:
        raise SystemExit(f"Missing Android SDK tool: {command[0]}") from exc
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"{command[0]} failed: {exc.stderr.strip() or exc.stdout.strip()}") from exc
    return result.stdout.strip()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for part in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(part)
    return digest.hexdigest()


def publish(apk: Path, web_root: Path, base_url: str, notes: str) -> dict:
    apk = apk.resolve(strict=True)
    parsed = urlparse(base_url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("--base-url must be a public HTTPS path without credentials or query/fragment")
    if not apk.name.endswith(".apk"):
        raise ValueError("Expected an APK file")
    if apk.stat().st_size <= 0 or apk.stat().st_size > 1024 * 1024 * 1024:
        raise ValueError("APK is empty or exceeds 1 GiB")
    package = tool_output("apkanalyzer", "manifest", "application-id", str(apk)).strip()
    if package != PACKAGE:
        raise ValueError(f"APK package {package!r} does not match {PACKAGE!r}")
    code = int(tool_output("apkanalyzer", "manifest", "version-code", str(apk)))
    name = tool_output("apkanalyzer", "manifest", "version-name", str(apk))
    if code <= 0 or not name:
        raise ValueError("APK must have a positive versionCode and nonempty versionName")
    sig = tool_output("apksigner", "verify", "--verbose", "--print-certs", str(apk))
    if "Verifies" not in sig and "Verified" not in sig:
        raise ValueError("Unverified APK signature")
    if "Android Debug" in sig:
        raise ValueError("Refusing to publish an Android Debug-signed APK")
    signer = signing_certificate_sha256(sig)

    location = web_root.resolve() / "updates"
    location.mkdir(parents=True, exist_ok=True)
    pin = web_root.resolve() / "signing-cert.sha256"
    if pin.exists():
        expected = pin.read_text().strip().lower()
        if expected != signer:
            raise ValueError("APK signing certificate differs from previously published releases")
    old_manifest = location / "latest.json"
    if old_manifest.exists():
        old = json.loads(old_manifest.read_text())
        if code <= int(old["versionCode"]):
            raise ValueError("New versionCode must be greater than the currently published one")

    filename = f"arvio-private-{code}.apk"
    final_apk = location / filename
    partial = location / (filename + ".part")
    if final_apk.exists():
        raise ValueError(f"Release file already exists: {final_apk}")
    try:
        shutil.copyfile(apk, partial)
        os.chmod(partial, 0o644)
        sha = sha256_file(partial)
        partial.replace(final_apk)
    finally:
        partial.unlink(missing_ok=True)

    result = {
        "packageName": PACKAGE,
        "versionCode": code,
        "versionName": name,
        "title": f"ARVIO Private {name}",
        "notes": notes.strip(),
        "apkUrl": base_url.rstrip("/") + "/" + filename,
        "apkSizeBytes": final_apk.stat().st_size,
        "sha256": sha,
    }
    manifest_part = location / "latest.json.part"
    manifest_part.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    os.chmod(manifest_part, 0o644)
    manifest_part.replace(old_manifest)  # Publish the manifest last, after the APK is ready.
    if not pin.exists():
        pin.write_text(signer + "\n")
        os.chmod(pin, 0o600)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", type=Path, required=True, help="The signed app-sideload-release.apk")
    parser.add_argument("--web-root", type=Path, required=True, help="Local directory mounted read-only into nginx")
    parser.add_argument("--base-url", required=True, help="Public HTTPS URL, e.g. https://updates.example.net/updates")
    parser.add_argument("--notes", default="", help="Release notes shown by the app")
    parser.add_argument("--notes-file", type=Path, help="UTF-8 text file with release notes")
    opts = parser.parse_args()
    notes = opts.notes_file.read_text() if opts.notes_file else opts.notes
    try:
        result = publish(opts.apk, opts.web_root, opts.base_url, notes)
    except (OSError, ValueError, KeyError) as exc:
        parser.error(str(exc))
    print(json.dumps(result, indent=2))
    print(f"Published to {opts.web_root.resolve() / 'updates' / 'latest.json'}")


if __name__ == "__main__":
    main()
