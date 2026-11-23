const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, storage } = require('./load.cjs');
const root = path.join(__dirname, '..');
const source = (p) => fs.readFileSync(path.join(root, p), 'utf8');
function setup(payload) {
  let remote = structuredClone(payload);
  const cloud = load('lib/cloud.ts', {
    './config': { config: { netlifyBackendUrl: 'https://backend.invalid' }, hasNetlifyBackendUrl: () => true },
    './homeserver': { serializeHomeServerConnectionJson: () => '' },
    './iptv': load('lib/iptv.ts', { './http': {}, './storage': storage() }), './mediaImages': {},
    './http': { jsonRequest: async (_url, options) => {
      if (options?.method === 'POST') { remote = JSON.parse(options.body).payload; return { accepted: true }; }
      return { payload: structuredClone(remote) };
    } }
  });
  const auth = { session: { userId: 'account', accessToken: 'test' }, isNetlifySession: true, accessToken: async () => 'test' };
  return { cloud, auth, remote: () => remote };
}
function webDefaults() {
  const store = source('lib/store/settings.ts');
  const start = store.indexOf('export const defaultSettings: AppSettings = {');
  const body = store.slice(store.indexOf('{', start), store.indexOf('\n};', start) + 2);
  return Function('defaultCatalogs', `return (${body});`)([]);
}
test('new profiles default to automatic playback (no picker)', () => {
  assert.equal(webDefaults().showSourcesBeforePlay, false);
});
test('toggle saves only for selected profile and survives cloud round trip', async () => {
  const h = setup({ profileSettingsById: { a: {}, b: { showSourcesBeforePlay: false } } });
  const base = webDefaults();
  await h.cloud.saveCloudSettings(h.auth, { ...base, showSourcesBeforePlay: true }, [], 'a', [], base);
  const stored = h.remote();
  assert.equal(stored.profileSettingsById.a.showSourcesBeforePlay, true);
  assert.equal(stored.profileSettingsById.b.showSourcesBeforePlay, false);
  assert.equal(stored.fieldUpdatedAt['p:a:showSourcesBeforePlay'] > 0, true);
  assert.equal((await h.cloud.pullCloudPayload(h.auth, 'a')).settings.showSourcesBeforePlay, true);
  assert.equal((await h.cloud.pullCloudPayload(h.auth, 'b')).settings.showSourcesBeforePlay, false);
});
test('legacy account-wide settings do not leak this preference into other profiles', async () => {
  const h = setup({ settings: { showSourcesBeforePlay: true }, profileSettingsById: { a: { showSourcesBeforePlay: true }, b: {} } });
  assert.equal((await h.cloud.pullCloudPayload(h.auth, 'a')).settings.showSourcesBeforePlay, true);
  assert.equal((await h.cloud.pullCloudPayload(h.auth, 'b')).settings.showSourcesBeforePlay, undefined);
});
test('web settings expose a toggle; Play uses picker without autoplay and manual choice can resume', () => {
  const section = source('components/settings/sections/Watching.tsx');
  const details = source('components/details/DetailsDrawer.tsx');
  const picker = source('components/details/SourcePicker.tsx');
  assert.match(section, /label="Show sources before playing" value=\{settings.showSourcesBeforePlay\}/);
  assert.match(details, /if \(settings.showSourcesBeforePlay\)/);
  assert.match(details, /setSourcePickerVisible\(true\)/);
  assert.match(details, /if \(!settings.showSourcesBeforePlay\) setAutoplayRequest/);
  assert.match(picker, /resumePositionSeconds: resumeSeconds/);
});
test('Android details route Play into picker and cloud keeps the preference per profile', () => {
  const android = (p) => fs.readFileSync(path.join(root, '..', 'app/src/main/kotlin/com/arflix/tv/', p), 'utf8');
  assert.match(android('ui/screens/details/DetailsScreen.kt'), /state.showSourcesBeforePlay \|\| !state.autoPlaySingleSource/);
  assert.match(android('ui/screens/details/DetailsViewModel.kt'), /prefs\[showSourcesBeforePlayKey\(\)\] \?: false/);
  const cloud = android('data/repository/CloudSyncRepository.kt');
  assert.match(cloud, /showSourcesBeforePlay = prefs\[showSourcesBeforePlayKeyFor\(profile.id\)\]/);
  assert.match(cloud, /state.showSourcesBeforePlay\?\.let/);
});
