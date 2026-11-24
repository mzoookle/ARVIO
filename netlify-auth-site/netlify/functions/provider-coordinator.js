"use strict";
const backend = require("./_backend");
const coordinator = require("../../private-cloud/provider-coordinator");

exports.handler = async (event) => {
  const result = await coordinator.handle(event, backend);
  // The coordinator's own JSON helper does not add CORS headers to POST responses.
  // Reuse the API's configured, origin-restricted CORS policy for every response,
  // while retaining pagination and retry headers from the coordinator.
  const corsHeaders = backend.json(200, {}).headers;
  return { ...result, headers: { ...corsHeaders, ...(result.headers || {}) } };
};
