"use strict";
const { json, requireAdmin, listAccounts } = require("../../private-cloud/admin-common");
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "GET") return json(405, { error: "method_not_allowed" });
  const auth = await requireAdmin(event);
  if (auth.error) return auth.error;
  try {
    const users = await listAccounts();
    return json(200, { users, total: users.length });
  } catch (error) {
    console.error("Admin user listing failed", error);
    return json(500, { error: "user_listing_failed" });
  }
};
