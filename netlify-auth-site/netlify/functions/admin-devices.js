"use strict";
const { json, requireAdmin, getPool, writeAudit } = require("../../private-cloud/admin-common");
exports.handler=async event=>{
  if(!["GET","DELETE"].includes(event.httpMethod)) return json(405,{error:"method_not_allowed"});
  const auth=await requireAdmin(event);
  if(auth.error)return auth.error;
  try {
    if(event.httpMethod==="DELETE") {
      const data=JSON.parse(event.body||"{}");
      if(!/^[0-9a-f-]{36}$/i.test(data.installationId||"") ||
         typeof data.accountId!=="string" || data.accountId.length>128) return json(400,{error:"invalid_device_id"});
      const result=await getPool().query(`DELETE FROM public.arvio_devices
        WHERE account_id=$1 AND installation_id=$2::uuid RETURNING account_email`,[data.accountId,data.installationId]);
      if(result.rows.length) await writeAudit(auth.identity.email,"device_inventory_deleted",result.rows[0].account_email,{});
      return json(200,{deleted:result.rowCount>0});
    }
    // Limit a single admin response; no hardware serial, IMEI, MAC, or GPS.
    const result=await getPool().query(`SELECT account_id AS "accountId", installation_id AS "installationId",
      account_email AS "email", package_name AS "packageName", device_name AS "deviceName",
      manufacturer, model, android_release AS "androidRelease", android_sdk AS "androidSdk",
      version_name AS "versionName", version_code AS "versionCode",
      host(last_ip) AS "lastIp", first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt"
      FROM public.arvio_devices ORDER BY last_seen_at DESC LIMIT 2000`);
    return json(200,{devices:result.rows});
  }catch(e){console.error("admin-devices failed",e);return json(503,{error:"device_inventory_unavailable"});}
};
