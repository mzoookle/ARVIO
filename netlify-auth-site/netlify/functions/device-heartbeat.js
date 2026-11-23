"use strict";
const { json, resolveIdentity } = require("./_backend");
const { getPool } = require("../../private-cloud/admin-common");
const PACKAGE = "com.arvio.tv.private";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validText = (v, n) => typeof v === "string" ? v.replace(/[\x00-\x1F\x7F]/g, " ").trim().slice(0,n) : "";
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405,{error:"method_not_allowed"});
  try {
    const identity = await resolveIdentity(event); // Validates active account and signed access token.
    const data = JSON.parse(event.body || "{}");
    if (!UUID.test(data.installationId || "") || data.packageName !== PACKAGE ||
        !Number.isSafeInteger(data.versionCode) || data.versionCode <= 0 || data.versionCode > 2_147_483_647) {
      return json(400,{error:"invalid_device_data"});
    }
    const deviceName=validText(data.deviceName,100) || "Android device";
    const versionName=validText(data.versionName,80) || "unknown";
    const address=event.requestContext?.identity?.sourceIp || null;
    // IP supplied exclusively by the private-cloud HTTP server's trusted-proxy logic.
    await getPool().query(`INSERT INTO public.arvio_devices
      (account_id, installation_id, account_email, package_name, device_name,
       manufacturer, model, android_release, android_sdk, version_name, version_code, last_ip)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::inet)
      ON CONFLICT(account_id, installation_id) DO UPDATE SET
       account_email=EXCLUDED.account_email, package_name=EXCLUDED.package_name,
       device_name=EXCLUDED.device_name, manufacturer=EXCLUDED.manufacturer,
       model=EXCLUDED.model, android_release=EXCLUDED.android_release,
       android_sdk=EXCLUDED.android_sdk, version_name=EXCLUDED.version_name,
       version_code=EXCLUDED.version_code, last_ip=EXCLUDED.last_ip, last_seen_at=now()`,
      [String(identity.supabaseUserId), data.installationId.toLowerCase(),
       String(identity.email).toLowerCase(), PACKAGE, deviceName,
       validText(data.manufacturer,80), validText(data.model,100),
       validText(data.androidRelease,40), Number.isSafeInteger(data.androidSdk)?data.androidSdk:null,
       versionName, data.versionCode, address]);
    return json(200,{ok:true});
  } catch (e) {
    if (e?.statusCode===401) return json(401,{error:"unauthorized"});
    console.error("device heartbeat failed", e);
    return json(503,{error:"device_inventory_unavailable"});
  }
};
