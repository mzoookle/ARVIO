'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./load.cjs');
const auth = { session: { accessToken: 'test-token', userId: 'account' }, isNetlifySession: true, accessToken: async () => 'test-token' };
const addon = {id:'one', name:'One', manifestUrl:'https://one.example/manifest.json', url:'https://one.example/manifest.json', enabled:true, isEnabled:true, setupUpdatedAt:1, resources:['stream'], catalogs:[]};
function harness(root) {
 let data = root;
 const cloud = load('lib/cloud.ts', {
  './config': { config: { netlifyBackendUrl: 'https://backend.invalid' }, hasNetlifyBackendUrl: () => true },
  './homeserver': {}, './iptv': {}, './mediaImages': {},
  './http': { jsonRequest: async (_url, request) => {
   if (request?.method === 'POST') { data=JSON.parse(request.body).payload; return {accepted:true}; }
   return {payload:data};
  } }
 });
 return {cloud, payload:()=>data};
}
test('same shared addon enabled independently for two profiles',async()=>{
 const h=harness({ addons:[addon], addonsByProfile:{A:[addon], B:[addon]}, profileSettingsById:{A:{streamProviderEnabledMap:{'stremio:one':false}},B:{streamProviderEnabledMap:{'stremio:one':true}}}});
 const a=(await h.cloud.pullCloudPayload(auth,'A')).addons[0];
 const b=(await h.cloud.pullCloudPayload(auth,'B')).addons[0];
 assert.equal(a.enabled,false); assert.equal(a.isEnabled,false);
 assert.equal(b.enabled,true); assert.equal(b.isEnabled,true);
});
test('profile can enable a legacy globally disabled addon',async()=>{
 const h=harness({ addons:[{...addon,enabled:false,isEnabled:false}], profileSettingsById:{B:{streamProviderEnabledMap:{'stremio:one':true}}} });
 const b=(await h.cloud.pullCloudPayload(auth,'B')).addons[0];
 assert.equal(b.enabled,true); assert.equal(b.isEnabled,true);
});
test('an installation save from profile A cannot switch existing addon off globally',async()=>{
 const h=harness({ addons:[addon], addonsByProfile:{A:[addon],B:[addon]}, profileSettingsById:{A:{streamProviderEnabledMap:{'stremio:one':false}},B:{streamProviderEnabledMap:{'stremio:one':true}}} });
 await h.cloud.saveCloudAddons(auth,[{...addon,enabled:false,isEnabled:false,setupUpdatedAt:200}], 'A');
 assert.equal(h.payload().addons[0].enabled,true); assert.equal(h.payload().addons[0].isEnabled,true);
 assert.equal((await h.cloud.pullCloudPayload(auth,'B')).addons[0].enabled,true);
 assert.equal((await h.cloud.pullCloudPayload(auth,'A')).addons[0].enabled,false);
});

test('legacy disabledAddonIds from profile A must not leak into profile B',async()=>{
 const h=harness({ addons:[addon], settings:{disabledAddonIds:['one']}, profileSettingsById:{A:{streamProviderEnabledMap:{'stremio:one':false}},B:{streamProviderEnabledMap:{}}} });
 const a=await h.cloud.pullCloudPayload(auth,'A');
 const b=await h.cloud.pullCloudPayload(auth,'B');
 assert.deepEqual([...a.settings.disabledAddonIds],['one']);
 assert.deepEqual([...b.settings.disabledAddonIds],[]);
 assert.equal(b.addons[0].enabled,true);
});
