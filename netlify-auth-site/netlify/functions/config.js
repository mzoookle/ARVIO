const { json, options } = require("./_backend");

exports.handler = async (event) => {
  const cors = options(event);
  if (cors) return cors;

  const privateCloud = process.env.ARVIO_PRIVATE_CLOUD === "true";
  return json(200, {
    backend: privateCloud ? "self_hosted" : "netlify",
    cloudSync: privateCloud ? "postgres_account_snapshot" : "netlify_account_snapshot",
    authSurface: "netlify_native_auth",
    tvAuthStorage: privateCloud ? "postgres_blob_compat" : "netlify_blobs",
    migratedPasswordSetup: true,
    emailProviderConfigured: !!(
      process.env.RESEND_API_KEY ||
      process.env.POSTMARK_SERVER_TOKEN ||
      process.env.SENDGRID_API_KEY
    ),
    authSecretConfigured: !!process.env.ARVIO_AUTH_SECRET,
    proxies: {
      tmdb: true,
      trakt: true
    },
    supabaseFallback: false,
    privateCloud: privateCloud,
    publicSignupEnabled: !privateCloud || process.env.ARVIO_ALLOW_SIGNUP === "true",
    mediaProxy: false,
    timestamp: new Date().toISOString()
  });
};
