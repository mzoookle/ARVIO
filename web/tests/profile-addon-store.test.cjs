'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./load.cjs');
const addon = {id:'one',name:'One',manifestUrl:'https://one.example/manifest.json',resources:['stream'], enabled:true,isEnabled:true};
test('web toggle only writes profile settings, not account-wide addon outbox',async()=>{
 const calls={queued:[],settings:[],saved:[],rendered:[]};
 const store={
  activeProfileId:'A', personalAddonsRef:{current:[addon]}, addonsRef:{current:[addon]},
  managed:{ref:{current:{delivery:null,resources:{addons:[]}}}}, settings:{},
  settingsRef:{current:{streamProviderEnabledMap:{'stremio:other':true}}},
  setAddons(value){calls.rendered.push(value);}, updateSettings(value){calls.settings.push(value);}
 };
 const {useAddonActions}=load('lib/store/addons.ts',{
  'react': {useCallback: fn=>fn},
  '../addonOutbox': {queueAddons: (...args)=>calls.queued.push(args), flushAddonOutbox:async()=>{}},
  '../addons': {normalizeAddons: value=>value, saveLocalAddons:value=>calls.saved.push(value), loadLocalAddons:()=>[addon]},
  '../addonInstall': {}, '../tmdb': {},
  './clients':{authClient:{session:{userId:'account'}}}
 });
 const actions=useAddonActions(store);
 await actions.setAddonsState([{...addon,enabled:false}]);
 assert.equal(calls.queued.length,0);
 assert.equal(calls.settings.length,1);
 assert.equal(calls.settings[0].streamProviderEnabledMap['stremio:one'],false);
 assert.equal(calls.settings[0].streamProviderEnabledMap['stremio:other'],true);
 assert.equal(calls.rendered.at(-1)[0].isEnabled,false);
});
