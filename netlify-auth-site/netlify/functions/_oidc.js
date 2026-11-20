"use strict";
const crypto = require("node:crypto");
const { URLSearchParams } = require("node:url");
const { getStore } = require("../../private-cloud/runtime-store");
const { getRuntimePool } = require("../../private-cloud/runtime-store");

const AUTH_ISSUER = "arvio-netlify";
const ACCESS_TTL = 7 * 24 * 60 * 60;
const REFRESH_TTL = 90 * 24 * 60 * 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const nowIso = () => new Date().toISOString();
const json = (statusCode, body) => ({ statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,apikey,content-type" }, body: JSON.stringify(body) });
const bodyOf = event => event.body ? JSON.parse(String(event.body).replace(/^\uFEFF/, "")) : {};
const header = (event, name) => Object.entries(event.headers || {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] || "";
const sha = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
function config() {
  const issuer = String(process.env.ARVIO_OIDC_ISSUER || "").replace(/\/$/, "");
  const clientId = String(process.env.ARVIO_OIDC_CLIENT_ID || "");
  const clientSecret = String(process.env.ARVIO_OIDC_CLIENT_SECRET || "");
  const redirectUri = String(process.env.ARVIO_OIDC_REDIRECT_URI || "");
  if (!issuer || !clientId || !clientSecret || !redirectUri) throw Object.assign(new Error("OIDC server configuration is incomplete"), { statusCode: 503 });
  return { issuer, clientId, clientSecret, redirectUri };
}
function appKeyGuard(event) {
  const expected = process.env.APP_ANON_KEY || "";
  const auth = String(header(event, "authorization")).replace(/^Bearer\s+/i, "");
  if (!expected || (header(event, "apikey") !== expected && auth !== expected)) throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
}
function authIdentity(event) {
  const token = String(header(event, "authorization")).match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const parts = token.split(".");
  if (parts.length !== 3) throw Object.assign(new Error("ARVIO sign-in required"), { statusCode: 401 });
  const secret = String(process.env.ARVIO_AUTH_SECRET || "");
  if (secret.length < 32) throw Object.assign(new Error("ARVIO_AUTH_SECRET is not configured"), { statusCode: 503 });
  const jwtHeader = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  if (jwtHeader.alg !== "HS256" || jwtHeader.typ !== "JWT") throw Object.assign(new Error("Invalid ARVIO session algorithm"), { statusCode: 401 });
  const expected = crypto.createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  const actual = Buffer.from(parts[2], "base64url");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw Object.assign(new Error("Invalid ARVIO session"), { statusCode: 401 });
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (claims.iss !== AUTH_ISSUER || claims.token_type !== "access" || Number(claims.exp) <= Math.floor(Date.now()/1000) || !claims.sub || !claims.email) throw Object.assign(new Error("Expired or invalid ARVIO session"), { statusCode: 401 });
  return { accountId: String(claims.sub), email: String(claims.email).trim().toLowerCase() };
}
function signArvioToken(account, type, ttl) {
  const now = Math.floor(Date.now()/1000);
  const input = `${b64({alg:"HS256",typ:"JWT"})}.${b64({iss:AUTH_ISSUER,sub:account.accountId,email:account.email,token_type:type,iat:now,exp:now+ttl})}`;
  return `${input}.${crypto.createHmac("sha256", process.env.ARVIO_AUTH_SECRET).update(input).digest("base64url")}`;
}
function session(account) {
  return { access_token: signArvioToken(account,"access",ACCESS_TTL), refresh_token: signArvioToken(account,"refresh",REFRESH_TTL), expires_in: ACCESS_TTL, token_type:"bearer", user:{id:account.accountId,email:account.email} };
}
async function discovery(cfg) {
  const response = await fetch(`${cfg.issuer}/.well-known/openid-configuration`, {headers:{accept:"application/json"}});
  if (!response.ok) throw Object.assign(new Error("Unable to load Keycloak OIDC discovery document"),{statusCode:502});
  const doc = await response.json();
  if (doc.issuer !== cfg.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw Object.assign(new Error("OIDC discovery issuer or endpoints are invalid"),{statusCode:502});
  return doc;
}
async function verifyIdToken(token, cfg, doc, nonce) {
  const parts = String(token||"").split(".");
  if(parts.length!==3) throw Object.assign(new Error("Invalid OIDC ID token"),{statusCode:401});
  const header = JSON.parse(Buffer.from(parts[0],"base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(parts[1],"base64url").toString("utf8"));
  if(!["RS256","PS256"].includes(header.alg) || !header.kid) throw Object.assign(new Error("Unsupported OIDC signing algorithm"),{statusCode:401});
  const jwksResponse = await fetch(doc.jwks_uri,{headers:{accept:"application/json"}});
  if(!jwksResponse.ok) throw Object.assign(new Error("Unable to retrieve OIDC signing keys"),{statusCode:502});
  const jwks = await jwksResponse.json();
  const jwk = (jwks.keys||[]).find(k=>k.kid===header.kid && k.use!=="enc");
  if(!jwk) throw Object.assign(new Error("OIDC signing key not found"),{statusCode:401});
  const key = crypto.createPublicKey({key:jwk,format:"jwk"});
  const valid = header.alg === "PS256"
    ? crypto.verify("sha256",Buffer.from(`${parts[0]}.${parts[1]}`),{key,padding:crypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:32},Buffer.from(parts[2],"base64url"))
    : crypto.verify("RSA-SHA256",Buffer.from(`${parts[0]}.${parts[1]}`),key,Buffer.from(parts[2],"base64url"));
  const aud = Array.isArray(claims.aud)?claims.aud:[claims.aud];
  if(!valid || claims.iss!==cfg.issuer || !aud.includes(cfg.clientId) || (aud.length>1 && claims.azp!==cfg.clientId) || claims.nonce!==nonce || Number(claims.exp)<=Math.floor(Date.now()/1000) || Number(claims.iat)>Math.floor(Date.now()/1000)+60 || (claims.nbf && Number(claims.nbf)>Math.floor(Date.now()/1000)) || claims.email_verified!==true || !EMAIL_RE.test(String(claims.email||""))) throw Object.assign(new Error("OIDC token validation failed"),{statusCode:401});
  const groups = Array.isArray(claims.groups) ? claims.groups.filter(value => typeof value === "string" && value.length <= 512).slice(0, 256) : [];
  return {sub:String(claims.sub),email:String(claims.email).trim().toLowerCase(),name:String(claims.name||"").slice(0,200),groups};
}
async function getAccount(store,email) { try{return await store.get(`accounts/email/${sha(email)}.json`,{type:"json"});}catch(e){if(e?.status===404||e?.name==="BlobNotFoundError")return null;throw e;} }
async function getState(store,state) { try{return await store.get(`state/${sha(state)}.json`,{type:"json"});}catch(e){if(e?.status===404||e?.name==="BlobNotFoundError")return null;throw e;} }
async function start(event, link=false) {
  if(event.httpMethod!=="POST") return json(405,{error:"method_not_allowed"});
  appKeyGuard(event);
  const cfg=config(), doc=await discovery(config());
  const body=bodyOf(event);
  let linked=null;
  if(link) linked=authIdentity(event);
  // For account linking, choose the return destination on the server. This
  // avoids rejecting a valid link flow because portal-config.js and the API
  // environment drifted or because the browser supplied a slightly different URL.
  const portalOrigin = String(process.env.ARVIO_AUTH_PORTAL_ORIGIN || new URL(cfg.redirectUri).origin).replace(/\/$/, "");
  // Use the routed portal path, not the physical HTML filename. This keeps
  // the browser URL stable and avoids a trailing slash being appended to a
  // .html file when the callback returns the ARVIO session fragment.
  const securityReturn = `${portalOrigin}/account/security`;
  const adminReturn = `${portalOrigin}/admin`;
  const requestedReturn = link ? securityReturn : String(body.return_to || process.env.ARVIO_WEB_ORIGIN || "");
  const allowedReturns = [process.env.ARVIO_WEB_ORIGIN, securityReturn, adminReturn].filter(Boolean);
  let returnTo = "";
  try {
    const requested = new URL(requestedReturn);
    const canonicalPath = requested.pathname.length > 1 ? requested.pathname.replace(/\/+$/, "") : requested.pathname;
    const canonical = `${requested.origin}${canonicalPath}`;
    const allowed = allowedReturns.some(value => {
      try {
        const candidate = new URL(value);
        const candidatePath = candidate.pathname.length > 1 ? candidate.pathname.replace(/\/+$/, "") : candidate.pathname;
        return canonical === `${candidate.origin}${candidatePath}` && !requested.search;
      } catch { return false; }
    });
    if (!allowed) throw new Error("not_allowlisted");
    returnTo = canonical;
  } catch {
    throw Object.assign(new Error("Invalid return URL"), { statusCode: 400 });
  }
  const state=crypto.randomBytes(32).toString("base64url"), nonce=crypto.randomBytes(32).toString("base64url"), verifier=crypto.randomBytes(48).toString("base64url");
  const challenge=crypto.createHash("sha256").update(verifier).digest("base64url");
  const store=getStore("arvio-oidc");
  await store.setJSON(`state/${sha(state)}.json`,{state,nonce,verifier,returnTo,linkAccountId:linked?.accountId||null,linkEmail:linked?.email||null,createdAt:Date.now()},{onlyIfNew:true});
  const params=new URLSearchParams({client_id:cfg.clientId,response_type:"code",redirect_uri:cfg.redirectUri,scope:String(process.env.ARVIO_OIDC_SCOPES||"openid email profile groups"),state,nonce,code_challenge:challenge,code_challenge_method:"S256"});
  return json(200,{authorize_url:`${doc.authorization_endpoint}?${params.toString()}`,state});
}
async function callback(event) {
  if(event.httpMethod!=="POST") return json(405,{error:"method_not_allowed"});
  const cfg=config(), body=bodyOf(event), state=String(body.state||""), code=String(body.code||"");
  if(!state||!code) return json(400,{error:"code_and_state_required"});
  const store=getStore("arvio-oidc"), pending=await getState(store,state);
  if(!pending || pending.state!==state || Date.now()-pending.createdAt>5*60*1000) return json(400,{error:"oidc_state_invalid_or_expired"});
  // Consume the state before exchanging the code; the state is single-use even on token endpoint failure.
  await store.delete(`state/${sha(state)}.json`);
  const doc=await discovery(cfg);
  const params=new URLSearchParams({grant_type:"authorization_code",client_id:cfg.clientId,client_secret:cfg.clientSecret,code,redirect_uri:cfg.redirectUri,code_verifier:pending.verifier});
  const tokenResponse=await fetch(doc.token_endpoint,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",accept:"application/json"},body:params});
  const tokenData=await tokenResponse.json().catch(()=>({}));
  if(!tokenResponse.ok || !tokenData.id_token) throw Object.assign(new Error("Keycloak authorization-code exchange failed"),{statusCode:401});
  const identity=await verifyIdToken(tokenData.id_token,cfg,doc,pending.nonce);
  const pool=getRuntimePool();
  const client=await pool.connect();
  let account;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`${cfg.issuer}:${identity.sub}`]);
    const found=await client.query("SELECT account_id,email FROM public.arvio_oidc_identities WHERE issuer=$1 AND subject=$2",[cfg.issuer,identity.sub]);
    const accounts=getStore("arvio-auth");
    if(found.rows.length) {
      if(pending.linkAccountId && String(found.rows[0].account_id)!==String(pending.linkAccountId)) throw Object.assign(new Error("This Keycloak identity is already linked to another ARVIO account"),{statusCode:409});
      account=await getAccount(accounts,found.rows[0].email);
      await client.query("UPDATE public.arvio_oidc_identities SET last_login_at=now(), groups=$3 WHERE issuer=$1 AND subject=$2",[cfg.issuer,identity.sub,identity.groups]);
      if(!account || account.accountId!==found.rows[0].account_id) throw Object.assign(new Error("Linked ARVIO account is unavailable"),{statusCode:409});
    } else if(pending.linkAccountId) {
      if(identity.email!==pending.linkEmail) throw Object.assign(new Error("The Keycloak email must match the ARVIO account email to link these identities"),{statusCode:409});
      account=await getAccount(accounts,pending.linkEmail);
      if(!account || account.accountId!==pending.linkAccountId) throw Object.assign(new Error("ARVIO account could not be verified"),{statusCode:409});
      await client.query("INSERT INTO public.arvio_oidc_identities (issuer,subject,account_id,email,groups,created_at) VALUES ($1,$2,$3,$4,$5,now())",[cfg.issuer,identity.sub,account.accountId,account.email,identity.groups]);
    } else {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`email:${identity.email}`]);
      const existing=await getAccount(accounts,identity.email);
      const legacy=await client.query(`SELECT 1 FROM public.legacy_supabase_users WHERE email_normalized=$1 UNION ALL SELECT 1 FROM public.legacy_supabase_snapshots WHERE email_normalized=$1 LIMIT 1`,[identity.email]);
      if(existing || legacy.rows.length) throw Object.assign(new Error("An ARVIO account or legacy cloud profile already uses this email. Sign in with its existing credential or ask your administrator to restore it, then link Keycloak from Account Security."),{statusCode:409});
      account={accountId:crypto.randomUUID(),email:identity.email,createdAt:nowIso(),authProviders:["keycloak"],oidcCreatedAt:nowIso()};
      const saved=await accounts.setJSON(`accounts/email/${sha(identity.email)}.json`,account,{onlyIfNew:true,metadata:{accountId:account.accountId,email:account.email}});
      if(!saved?.modified) throw Object.assign(new Error("An ARVIO account was created concurrently; please sign in again"),{statusCode:409});
      await client.query("INSERT INTO public.arvio_oidc_identities (issuer,subject,account_id,email,groups,created_at) VALUES ($1,$2,$3,$4,$5,now())",[cfg.issuer,identity.sub,account.accountId,account.email,identity.groups]);
    }
    await client.query("COMMIT");
  } catch(error) { await client.query("ROLLBACK").catch(()=>{}); throw error; }
  finally { client.release(); }
  const token=signSession(account);
  const fragment=new URLSearchParams({access_token:token.access_token,refresh_token:token.refresh_token,email:account.email,expires_in:String(token.expires_in)});
  const destination = new URL(pending.returnTo);
  destination.hash = fragment.toString();
  return json(200,{ok:true,redirect_url:destination.toString(),user:token.user});
}
function signSession(account) {
  const secret=String(process.env.ARVIO_AUTH_SECRET||"");
  if(secret.length<32) throw Object.assign(new Error("ARVIO_AUTH_SECRET is not configured"),{statusCode:503});
  const sign=(type,ttl)=>{const now=Math.floor(Date.now()/1000);const input=`${b64({alg:"HS256",typ:"JWT"})}.${b64({iss:AUTH_ISSUER,sub:account.accountId,email:account.email,token_type:type,iat:now,exp:now+ttl})}`;return `${input}.${crypto.createHmac("sha256",secret).update(input).digest("base64url")}`;};
  return {access_token:sign("access",ACCESS_TTL),refresh_token:sign("refresh",REFRESH_TTL),expires_in:ACCESS_TTL,user:{id:account.accountId,email:account.email}};
}
async function setPassword(event) {
  if(event.httpMethod!=="POST") return json(405,{error:"method_not_allowed"});
  const identity=authIdentity(event), body=bodyOf(event), password=String(body.password||"");
  if(password.length<8 || password.length>1024) return json(400,{error:"password_must_be_8_to_1024_characters"});
  const store=getStore("arvio-auth"), key=`accounts/email/${sha(identity.email)}.json`;
  const record=await store.getWithMetadata(key,{type:"json"});
  if(!record?.data || record.data.accountId!==identity.accountId) return json(404,{error:"account_not_found"});
  const salt=crypto.randomBytes(16).toString("base64url"), n=16384,r=8,p=1;
  const hash=await new Promise((resolve,reject)=>crypto.scrypt(password,salt,64,{N:n,r,p},(err,derived)=>err?reject(err):resolve(derived.toString("base64url"))));
  const updated={...record.data,passwordHash:`scrypt:${n}:${r}:${p}:${salt}:${hash}`,passwordSetupCompletedAt:nowIso(),updatedAt:nowIso()};
  const result=await store.setJSON(key,updated,{onlyIfMatch:record.etag,metadata:{...(record.metadata||{}),accountId:identity.accountId,email:identity.email,updatedAt:updated.updatedAt}});
  if(!result?.modified) return json(409,{error:"account_changed_retry"});
  return json(200,{ok:true,password_set:true});
}
exports.start=event=>start(event,false);
exports.linkStart=event=>start(event,true);
exports.callback=callback;
exports.setPassword=setPassword;
exports.json=json;
