#!/usr/bin/env python3
"""Create a signed upload attestation for the ARVIO admin dashboard.

This runs on the Android build machine, which has apksigner, apkanalyzer and openssl.
Keep the private attestation key and Android APK signing keystore off the server.
"""
import argparse
import base64
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

from apk_signing_cert import signing_certificate_sha256

PACKAGE = "com.arvio.tv.private"


def call(*args, input_bytes=None):
    p = subprocess.run(args, input=input_bytes, capture_output=True, check=True)
    return p.stdout.strip().decode("utf-8", "replace")


def prepare(apk: Path, key: Path, notes: str, out: Path):
    if apk.suffix.lower() != ".apk" or not apk.is_file() or not 0 < apk.stat().st_size <= 1024 ** 3:
        raise ValueError("Select a nonempty APK no larger than 1 GiB")
    pkg = call("apkanalyzer", "manifest", "application-id", str(apk))
    if pkg != PACKAGE:
        raise ValueError(f"Expected {PACKAGE}, got {pkg}")
    code = int(call("apkanalyzer", "manifest", "version-code", str(apk)))
    name = call("apkanalyzer", "manifest", "version-name", str(apk))
    if not 0 < code <= 2_147_483_647 or not name or len(name) > 80:
        raise ValueError("Invalid version code/name")
    signed = call("apksigner", "verify", "--verbose", "--print-certs", str(apk))
    if "Verified using v2 scheme (APK Signature Scheme v2): true" not in signed and "Verified using v3 scheme (APK Signature Scheme v3): true" not in signed:
        raise ValueError("APK must verify using v2 or v3 signing")
    signer = signing_certificate_sha256(signed)
    if "Android Debug" in signed:
        raise ValueError("Refusing debug-signed APK")
    h = hashlib.sha256()
    with apk.open("rb") as f:
        for data in iter(lambda: f.read(1024 * 1024), b""):
            h.update(data)
    release = dict(packageName=pkg, versionCode=code, versionName=name,
                   apkSizeBytes=apk.stat().st_size, sha256=h.hexdigest(),
                   signingCertSha256=signer, notes=notes[:2000])
    payload = json.dumps(release, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf8")
    # Ed25519 is a one-shot operation: OpenSSL pkeyutl must be able to determine
    # the input length. Passing input=payload pipes stdin, which fails on some
    # OpenSSL versions with "unable to determine file size for oneshot operation".
    with tempfile.TemporaryDirectory(prefix="arvio-attestation-") as temp_dir:
        payload_file = Path(temp_dir) / "payload.json"
        payload_file.write_bytes(payload)
        command = ["openssl", "pkeyutl", "-sign", "-rawin",
                   "-inkey", str(key), "-in", str(payload_file)]
        result = subprocess.run(command, capture_output=True)
        if result.returncode != 0:
            diagnostic = result.stderr.decode("utf-8", "replace").strip()
            raise ValueError(f"OpenSSL Ed25519 attestation signing failed: {diagnostic}")
        signature = result.stdout
    if len(signature) != 64:
        raise ValueError("OpenSSL returned an invalid Ed25519 signature length")
    out.write_text(json.dumps({"payloadBase64":base64.b64encode(payload).decode(),
                               "signatureBase64":base64.b64encode(signature).decode()}, indent=2)+"\n")
    return release


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--attestation-key", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--notes", default="")
    parser.add_argument("--notes-file", type=Path)
    args=parser.parse_args()
    try:
        r=prepare(args.apk,args.attestation_key,
                  args.notes_file.read_text(encoding="utf-8") if args.notes_file else args.notes,args.out)
        print("Prepared", r["versionName"], "code", r["versionCode"], "fingerprint",r["signingCertSha256"])
        print("Upload the APK and",args.out,"on the ARVIO admin dashboard")
    except (OSError,subprocess.CalledProcessError,ValueError) as e:
        parser.error(str(e))

if __name__=="__main__":main()
