const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./load.cjs');
const { canProfileOpenLiveTv } = load('lib/kidsLiveTv.ts');
const source = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

test('only explicitly opted-in kids profiles may open live TV', () => {
  assert.equal(canProfileOpenLiveTv({ isKidsProfile: false }), true);
  assert.equal(canProfileOpenLiveTv({ isKidsProfile: true }), false);
  assert.equal(canProfileOpenLiveTv({ isKidsProfile: true, allowKidsLiveTv: null }), false);
  assert.equal(canProfileOpenLiveTv({ isKidsProfile: true, allowKidsLiveTv: false }), false);
  assert.equal(canProfileOpenLiveTv({ isKidsProfile: true, allowKidsLiveTv: true }), true);
});

test('Web profile editor writes the same field as Android and clears it for adults', () => {
  const dialog = source('components/profile/ProfileDialog.tsx');
  assert.match(dialog, /allowKidsLiveTv: kidsOn && allowKidsLiveTv/);
  assert.match(dialog, /role="switch"/);
  assert.match(dialog, /initial\?\.allowKidsLiveTv === true/);
});

test('all Web live entry points check the permission before opening a stream', () => {
  const shell = source('components/shell/AppShell.tsx');
  const playback = source('lib/store/playback.ts');
  const home = source('components/home/HomeScreen.tsx');
  const nav = source('components/shell/TopNav.tsx');
  assert.match(nav, /canProfileOpenLiveTv\(activeProfile\)/);
  assert.match(shell, /section === "tv" && canOpenLiveTv/);
  assert.match(shell, /!canOpenLiveTv && section === "tv"/);
  assert.equal((playback.match(/!canProfileOpenLiveTv\(activeProfileRef\.current\)/g) || []).length, 2);
  assert.match(home, /canOpenLiveTv && !catalogConfigs/);
  assert.match(home, /!canOpenLiveTv \? null : <FavoriteTvRail/);
  assert.match(home, /const hasFavoriteTv = canOpenLiveTv && favoriteTvChannels.length > 0/);
});
