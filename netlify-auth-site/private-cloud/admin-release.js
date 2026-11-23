"use strict";
const fs=require("node:fs");
const fsp=require("node:fs/promises");
const path=require("node:path");
const crypto=require("node:crypto");
const { pipeline }=require("node:stream/promises");
const { Transform }=require("node:stream");
const { json, requireAdmin, writeAudit }=require("./admin-common");
const MAX_APK=1024*1024*1024;
const PACKAGE="com.arvio.tv.private";
const HEX64=/^[0-9a-f]{64}$/;
const METADATA=/^[A-Za-z0-9+/=]+$/;
const RELEASE_ROOT=()=>path.resolve(process.env.ARVIO_RELEASE_ROOT||"/srv/releases");

function baseUrl() {
  const value=String(process.env.ARVIO_RELEASE_BASE_URL||"").replace(/\/+$/,"");
  const u=new URL(value);
  if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash||!u.pathname.endsWith("/updates")) throw new Error("ARVIO_RELEASE_BASE_URL must be an HTTPS /updates URL");
  return value;
}
function parseAttestation(headers) {
  const raw=String(headers["x-arvio-attestation"]||"");
  if(!raw||raw.length>8192||!METADATA.test(raw)) throw Object.assign(new Error("invalid_attestation"),{statusCode:400});
  let att, release, payload;
  try {
    att=JSON.parse(Buffer.from(raw,"base64").toString("utf8"));
    payload=Buffer.from(att.payloadBase64,"base64");
    if(payload.length>5000)throw Error();
    const publicKey=fs.readFileSync(process.env.ARVIO_RELEASE_ATTESTATION_PUBLIC_KEY_PATH||"/run/secrets/release-attestation.pub");
    const valid=crypto.verify(null,payload,publicKey,Buffer.from(att.signatureBase64,"base64"));
    if(!valid)throw Error();
    release=JSON.parse(payload.toString("utf8"));
  } catch(e) {
    if(e.code==="ENOENT")throw Object.assign(new Error("attestation_key_unavailable"),{statusCode:503});
    throw Object.assign(new Error("invalid_attestation"),{statusCode:400});
  }
  if(release.packageName!==PACKAGE || !Number.isSafeInteger(release.versionCode) || release.versionCode<1 || release.versionCode>2147483647 ||
     typeof release.versionName!=="string" || !release.versionName.trim() || release.versionName.length>80 ||
     typeof release.notes!=="string" || release.notes.length>2000 ||
     !Number.isSafeInteger(release.apkSizeBytes) || release.apkSizeBytes<1 || release.apkSizeBytes>MAX_APK ||
     !HEX64.test(release.sha256) || !HEX64.test(release.signingCertSha256))
     throw Object.assign(new Error("invalid_release_metadata"),{statusCode:400});
  return release;
}
async function ensureSigner(release,root) {
  const pin=path.join(root,"signing-cert.sha256");
  const fromDisk=await fsp.readFile(pin,"utf8").catch(e=>{if(e.code==="ENOENT")return "";throw e});
  const fromEnv=String(process.env.ARVIO_RELEASE_SIGNING_CERT_SHA256||"").trim().toLowerCase();
  if(fromEnv&&!HEX64.test(fromEnv))throw Object.assign(new Error("invalid_server_signing_cert_pin"),{statusCode:503});
  if(!fromEnv&&!fromDisk)throw Object.assign(new Error("signing_cert_pin_required"),{statusCode:503});
  if((fromEnv&&fromEnv!==release.signingCertSha256)||(fromDisk&&fromDisk.trim()!==release.signingCertSha256))
    throw Object.assign(new Error("release_signing_certificate_mismatch"),{statusCode:409});
  return pin;
}
async function latestManifest(root) {
  try{return JSON.parse(await fsp.readFile(path.join(root,"updates","latest.json"),"utf8"))}
  catch(e){if(e.code==="ENOENT")return null;throw e}
}
async function list(event) {
  if(event.httpMethod!=="GET")return json(405,{error:"method_not_allowed"});
  const auth=await requireAdmin(event);if(auth.error)return auth.error;
  try {
    const root=RELEASE_ROOT();const latest=await latestManifest(root);
    const entries=await fsp.readdir(path.join(root,"updates")).catch(e=>e.code==="ENOENT"?[]:Promise.reject(e));
    const releases=entries.filter(x=>/^arvio-private-\d+\.apk$/.test(x)).sort((a,b)=>Number(b.match(/\d+/)[0])-Number(a.match(/\d+/)[0])).slice(0,100);
    return json(200,{latest,releases,configured:Boolean(process.env.ARVIO_RELEASE_BASE_URL)});
  }catch(e){console.error("admin release list failed",e);return json(503,{error:"release_store_unavailable"})}
}
async function upload(req,res) {
  const reply=result=>{res.statusCode=result.statusCode;for(const [k,v] of Object.entries(result.headers||{}))res.setHeader(k,v);res.end(result.body)};
  if(req.method!=="POST"){reply(json(405,{error:"method_not_allowed"}));return;}
  const auth=await requireAdmin({headers:req.headers});if(auth.error){reply(auth.error);return;}
  let pending=null,lockHandle=null,lockFile=null;
  try {
    const release=parseAttestation(req.headers),root=RELEASE_ROOT(),url=baseUrl();
    await fsp.mkdir(path.join(root,"updates"),{recursive:true});
    const pin=await ensureSigner(release,root);
    const contentLength=req.headers["content-length"];
    if(contentLength!==undefined && (!Number.isSafeInteger(Number(contentLength)) || Number(contentLength)!==release.apkSizeBytes)) {
      reply(json(400,{error:"apk_size_mismatch"}));return;
    }
    lockFile=path.join(root,".admin-release-upload.lock");
    try{lockHandle=await fsp.open(lockFile,"wx",0o600)}catch(e){if(e.code==="EEXIST"){reply(json(409,{error:"upload_in_progress"}));return;}throw e}
    const latest=await latestManifest(root);
    if(latest&&release.versionCode<=Number(latest.versionCode))throw Object.assign(new Error("version_code_must_increase"),{statusCode:409});
    const filename=`arvio-private-${release.versionCode}.apk`;
    const destination=path.join(root,"updates",filename);
    if(fs.existsSync(destination))throw Object.assign(new Error("release_already_exists"),{statusCode:409});
    pending=path.join(root,"updates",`.upload-${crypto.randomUUID()}.part`);
    let size=0;const digest=crypto.createHash("sha256");let firstChunk=Buffer.alloc(0);
    const inspection=new Transform({transform(chunk,enc,cb){
      size+=chunk.length;
      if(size>MAX_APK||size>release.apkSizeBytes)return cb(Object.assign(new Error("apk_too_large"),{statusCode:413}));
      if(firstChunk.length<4)firstChunk=Buffer.concat([firstChunk,chunk.subarray(0,4-firstChunk.length)]);
      digest.update(chunk);cb(null,chunk);
    }});
    await pipeline(req,inspection,fs.createWriteStream(pending,{flags:"wx",mode:0o644}));
    if(firstChunk.toString("binary",0,2)!=="PK" || size!==release.apkSizeBytes || digest.digest("hex")!==release.sha256)
      throw Object.assign(new Error("apk_digest_or_size_mismatch"),{statusCode:400});
    await fsp.rename(pending,destination);pending=null;
    const manifest={packageName:PACKAGE,versionCode:release.versionCode,versionName:release.versionName,
      title:`ARVIO Private ${release.versionName}`,notes:release.notes,apkUrl:`${url}/${filename}`,
      apkSizeBytes:size,sha256:release.sha256};
    const temp=path.join(root,"updates",`.manifest-${crypto.randomUUID()}.part`);
    try {
      await fsp.writeFile(temp,JSON.stringify(manifest,null,2)+"\n",{mode:0o644});
      await fsp.rename(temp,path.join(root,"updates","latest.json"));
    } finally {await fsp.unlink(temp).catch(()=>{});}
    if(!(await fsp.stat(pin).catch(()=>null))) await fsp.writeFile(pin,release.signingCertSha256+"\n",{flag:"wx",mode:0o600});
    try{await writeAudit(auth.identity.email,"release_published",auth.identity.email,
      {versionCode:release.versionCode,versionName:release.versionName,sha256:release.sha256});}
    catch(e){console.error("release audit failed",e);}
    reply(json(201,{ok:true,release:manifest}));
  }catch(e){console.error("admin release upload failed",e.message);reply(json(e.statusCode||503,{error:e.message||"upload_failed"}));}
  finally{if(pending)await fsp.unlink(pending).catch(()=>{});if(lockHandle)await lockHandle.close().catch(()=>{});if(lockHandle&&lockFile)await fsp.unlink(lockFile).catch(()=>{});}
}
module.exports={upload,list};
