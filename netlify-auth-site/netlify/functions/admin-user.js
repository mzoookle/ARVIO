"use strict";
const { json, requireAdmin, userDetails } = require("../../private-cloud/admin-common");
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "GET") return json(405, { error: "method_not_allowed" });
  const auth = await requireAdmin(event);
  if (auth.error) return auth.error;
  try {
    const email = event.queryStringParameters?.email || "";
    const user = await userDetails(email);
    return user ? json(200, user) : json(404, { error: "user_not_found" });
  } catch (error) {
    console.error("Admin user detail lookup failed", error);
    return json(500, { error: "user_lookup_failed" });
  }
};
