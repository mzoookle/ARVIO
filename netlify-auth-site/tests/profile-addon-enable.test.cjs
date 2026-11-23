'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const filename = path.join(__dirname, '../netlify/functions/admin-profile-config.js');
const source = fs.readFileSync(filename, 'utf8');
const sandbox={
  exports: {}, URL, Buffer, console,
  require(name) {
    if (name.includes('admin-common')) return {json(){},parseBody(){},requireAdmin(){},findAccount(){},writeAudit(){}};
    if (name==='./_backend') return {};
    throw Error('Unexpected dependency '+name);
  }
};
vm.runInNewContext(source,sandbox,{filename});
const {selectedConfig,applyAddons}=sandbox.exports._test;
const addon = {id:'one',name:'One',url:'https://one.example/manifest.json',enabled:true,isEnabled:true};
const make=()=>({profiles:[{id:'A'},{id:'B'}],addons:[addon],addonsByProfile:{A:[addon],B:[addon]},profileSettingsById:{A:{streamProviderEnabledMap:{}},B:{streamProviderEnabledMap:{}}}});
test('admin disable affects selected profile, never canonical install or other profile',()=>{
 const data=make();
 applyAddons(data,'A',[{...addon,enabled:false,isEnabled:false}],1000);
 assert.equal(data.addons[0].enabled,true);
 assert.equal(data.addons[0].isEnabled,true);
 assert.equal(data.profileSettingsById.A.streamProviderEnabledMap['stremio:one'],false);
 assert.equal(data.profileSettingsById.B.streamProviderEnabledMap['stremio:one'],undefined);
 assert.equal(selectedConfig(data,'A').addons[0].enabled,false);
 assert.equal(selectedConfig(data,'B').addons[0].enabled,true);
 assert.ok(data.fieldUpdatedAt['p:A:streamProviderEnabledMap']);
});
test('admin enable works despite legacy globally disabled record; URLs survive',()=>{
 const data=make();data.addons[0]={...addon,enabled:false,isEnabled:false};data.addonsByProfile.A=[{...data.addons[0]}];
 // Editing `enabled` alone must win over the stale Android `isEnabled` mirror.
 applyAddons(data,'A',[{...data.addons[0],enabled:true}],2000);
 assert.equal(data.addons[0].enabled,false);
 assert.equal(selectedConfig(data,'A').addons[0].enabled,true);
 assert.equal(data.addons[0].url,addon.url);
});
