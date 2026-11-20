"use strict";
const { json, parseBody, requireAdmin, findAccount, hashPassword, generateTemporaryPassword, writeAudit, getStores } = require("../../private-cloud/admin-common");
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });
  const auth = await requireAdmin(event);
  if (auth.error) return auth.error;
  try {
    const body = parseBody(event);
    const email = String(body.email || "").trim().toLowerCase();
    const record = await findAccount(email);
    if (!record) return json(404, { error: "user_not_found" });
    const temporaryPassword = generateTemporaryPassword();
    const account = {
      ...record.data,
      passwordHash: await hashPassword(temporaryPassword),
      updatedAt: new Date().toISOString()
    };
    const metadata = {
      ...(record.metadata && typeof record.metadata === "object" ? record.metadata : {}),
      accountId: account.accountId,
      email,
      updatedAt: account.updatedAt
    };
    const result = await getStores().auth.setJSON(`accounts/email/${require("node:crypto").createHash("sha256").update(email).digest("hex")}.json`, account, {
      onlyIfMatch: record.etag,
      metadata
    });
    if (!result.modified) return json(409, { error: "account_changed_retry" });
    let auditLogged = true;
    try {
      await writeAudit(auth.identity.email, "password_reset", email, { method: "generated_temporary_password" });
    } catch (auditError) {
      auditLogged = false;
      console.error("Password reset succeeded but audit logging failed", auditError);
    }
    return json(200, { ok: true, email, temporaryPassword, auditLogged });
  } catch (error) {
    console.error("Admin password reset failed", error);
    return json(500, { error: "password_reset_failed" });
  }
};
