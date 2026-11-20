"use strict";
const { json, parseBody, requireAdmin, findAccount, writeAudit } = require("../../private-cloud/admin-common");
const { queueAccountDeletionForAdmin } = require("./_backend");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  const auth = await requireAdmin(event);
  if (auth.error) return auth.error;

  try {
    const body = parseBody(event);
    const email = String(body.email || "").trim().toLowerCase();
    const confirmation = String(body.confirmation || "");
    if (!email || confirmation !== email) {
      return json(400, { error: "type_the_exact_email_to_confirm_deletion" });
    }

    const target = await findAccount(email);
    if (!target?.data?.accountId) return json(404, { error: "user_not_found" });
    if (String(target.data.accountId) === String(auth.identity.supabaseUserId)) {
      return json(409, { error: "cannot_delete_current_admin_account" });
    }

    const queued = await queueAccountDeletionForAdmin(event, email, String(target.data.accountId));
    try {
      await writeAudit(auth.identity.email, "account_deleted_by_admin", email, {
        accountId: String(target.data.accountId), jobId: queued.jobId
      });
    } catch (auditError) {
      // The purge has already been queued. Do not report it as failed or imply
      // that the account remains active merely because audit persistence failed.
      console.error("Admin account deletion audit write failed", auditError);
      return json(202, { ok: true, status: queued.status, job_id: queued.jobId, audit_warning: true });
    }
    return json(202, { ok: true, status: queued.status, job_id: queued.jobId });
  } catch (error) {
    console.error("Admin account deletion could not be queued", error);
    return json(error?.statusCode || 500, {
      error: error?.statusCode === 409 ? "account_deletion_in_progress" : "account_deletion_failed"
    });
  }
};
