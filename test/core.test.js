/**
 * Core logic tests. Runs entirely in a temp sandbox — never touches the real
 * ~/.claude. Uses FAKE tokens only.
 *
 *   node test/core.test.js
 */
'use strict';
const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const core = require('../out/core.js');

const FAKE_TOKEN_A = 'sk-fake-token-account-A-do-not-log-1234567890';
const FAKE_TOKEN_B = 'sk-fake-token-account-B-do-not-log-0987654321';

let sandbox;
let logLines = [];
const log = (m) => logLines.push(m);

function paths() {
  return {
    claudeDir: path.join(sandbox, 'home', '.claude'),
    claudeJson: path.join(sandbox, 'home', '.claude.json'),
    profilesRoot: path.join(sandbox, 'home', '.claude-profiles')
  };
}

function credsFor(token) {
  return {
    claudeAiOauth: {
      accessToken: token,
      refreshToken: token.replace('token', 'refresh'),
      expiresAt: Date.now() + 86400_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'pro',
      rateLimitTier: 'default_claude_ai'
    },
    organizationUuid: '00000000-0000-0000-0000-000000000000'
  };
}

/** Create a fake live Claude state for an "account". */
async function writeLiveState(token, marker) {
  const p = paths();
  await fs.rm(p.claudeDir, { recursive: true, force: true });
  await fs.rm(p.claudeJson, { force: true });
  await fs.mkdir(path.join(p.claudeDir, 'projects', 'demo'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(p.claudeDir, 'sessions'), { recursive: true });
  await fs.writeFile(path.join(p.claudeDir, '.credentials.json'), JSON.stringify(credsFor(token), null, 2), { mode: 0o600 });
  await fs.writeFile(path.join(p.claudeDir, 'sessions', 'session.txt'), `session-of-${marker}`);
  await fs.writeFile(path.join(p.claudeDir, 'settings.json'), JSON.stringify({ marker }), { mode: 0o644 });
  await fs.writeFile(p.claudeJson, JSON.stringify({ userID: marker, projects: {} }), { mode: 0o600 });
  await fs.chmod(p.claudeDir, 0o700);
}

async function readLiveMarker() {
  const p = paths();
  const s = JSON.parse(await fs.readFile(path.join(p.claudeDir, 'settings.json'), 'utf8'));
  const j = JSON.parse(await fs.readFile(p.claudeJson, 'utf8'));
  const creds = JSON.parse(await fs.readFile(path.join(p.claudeDir, '.credentials.json'), 'utf8'));
  const session = await fs.readFile(path.join(p.claudeDir, 'sessions', 'session.txt'), 'utf8');
  return { marker: s.marker, userID: j.userID, token: creds.claudeAiOauth.accessToken, session };
}

function mode(p) { return fss.statSync(p).mode & 0o777; }

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------------------------------------------------------------------------

test('name validation', async () => {
  assert.strictEqual(core.cleanProfileName('  My Profile! '), 'My Profile');
  assert.ok(core.isValidProfileName('Main'));
  assert.ok(!core.isValidProfileName('_backups'));
  assert.ok(!core.isValidProfileName(''));
  assert.ok(!core.isValidProfileName('a'.repeat(65)));
});

test('import live state as profile A', async () => {
  const p = paths();
  await writeLiveState(FAKE_TOKEN_A, 'account-A');
  const info = await core.importLiveAsProfile(p, 'AccountA', log);
  assert.strictEqual(info.name, 'AccountA');
  assert.ok(info.hasClaudeDir && info.hasClaudeJson && info.hasCredentials);
  assert.strictEqual(await core.getActiveProfileName(p), 'AccountA');
  assert.ok(fss.existsSync(path.join(p.profilesRoot, 'AccountA', 'profile.json')));
  // live state untouched by import
  assert.strictEqual((await readLiveMarker()).marker, 'account-A');
});

test('create empty profile B and switch to it (logout state)', async () => {
  const p = paths();
  await core.createEmptyProfile(p, 'AccountB');
  const result = await core.switchToProfile(p, 'AccountB', { log });
  assert.ok(result.warnings.some(w => w.includes('empty')), 'expected empty-profile warning');
  // switching to an empty profile leaves no live state => Claude shows login screen
  assert.ok(!fss.existsSync(p.claudeDir));
  assert.ok(!fss.existsSync(p.claudeJson));
  assert.strictEqual(await core.getActiveProfileName(p), 'AccountB');
  // A's state was snapshotted into its profile before the switch
  const snap = JSON.parse(await fs.readFile(path.join(p.profilesRoot, 'AccountA', '.claude', 'settings.json'), 'utf8'));
  assert.strictEqual(snap.marker, 'account-A');
});

test('login as account B, save, then switch A <-> B preserves both logins', async () => {
  const p = paths();
  // simulate logging in as account B while profile B is active
  await writeLiveState(FAKE_TOKEN_B, 'account-B');
  await core.saveLiveToProfile(p, 'AccountB', log);

  // B -> A
  await core.switchToProfile(p, 'AccountA', { log });
  let live = await readLiveMarker();
  assert.strictEqual(live.marker, 'account-A');
  assert.strictEqual(live.token, FAKE_TOKEN_A);
  assert.strictEqual(live.session, 'session-of-account-A');

  // A -> B
  await core.switchToProfile(p, 'AccountB', { log });
  live = await readLiveMarker();
  assert.strictEqual(live.marker, 'account-B');
  assert.strictEqual(live.token, FAKE_TOKEN_B);
  assert.strictEqual(live.session, 'session-of-account-B');

  // B -> A again; both profiles still hold their own credentials (no logout, no mixing)
  await core.switchToProfile(p, 'AccountA', { log });
  live = await readLiveMarker();
  assert.strictEqual(live.token, FAKE_TOKEN_A);
  const snapB = JSON.parse(await fs.readFile(path.join(p.profilesRoot, 'AccountB', '.claude', '.credentials.json'), 'utf8'));
  assert.strictEqual(snapB.claudeAiOauth.accessToken, FAKE_TOKEN_B);
});

test('permissions preserved after switch (.claude 700, files 600)', async () => {
  const p = paths();
  assert.strictEqual(mode(p.claudeDir), 0o700, '.claude should be 700');
  assert.strictEqual(mode(path.join(p.claudeDir, '.credentials.json')), 0o600, '.credentials.json should be 600');
  assert.strictEqual(mode(p.claudeJson), 0o600, '.claude.json should be 600');
});

test('backups are created on every switch and pruned to maxBackups', async () => {
  const p = paths();
  const backups = await core.listBackups(p);
  assert.ok(backups.length >= 3, `expected >=3 backups, got ${backups.length}`);
  for (const b of backups) {
    assert.ok(fss.existsSync(path.join(b.dir, 'backup.json')));
  }
  // prune check
  await core.backupLive(p, 'prune-test', { maxBackups: 2, log });
  const pruned = await core.listBackups(p);
  assert.strictEqual(pruned.length, 2);
});

test('validation rejects corrupted credentials', async () => {
  const p = paths();
  await core.createEmptyProfile(p, 'Broken');
  const bdir = path.join(p.profilesRoot, 'Broken', '.claude');
  await fs.mkdir(bdir, { recursive: true });
  await fs.writeFile(path.join(bdir, '.credentials.json'), 'NOT JSON {', { mode: 0o600 });
  const v = await core.validateProfile(p, 'Broken');
  assert.ok(!v.ok);
  await assert.rejects(() => core.switchToProfile(p, 'Broken', { log }), /failed validation/);
  // live state untouched by the rejected switch
  assert.strictEqual((await readLiveMarker()).token, FAKE_TOKEN_A);
  // validation output never contains token material
  assert.ok(!JSON.stringify(v).includes('sk-fake'));
});

test('failed swap mid-flight rolls back live state', async () => {
  const p = paths();
  // Sabotage: make .claude.json in profile B a dangling source by replacing
  // replaceLiveState's second piece — simplest reliable failure injection is a
  // read-only parent for the staging path of the second piece. Instead, make
  // the profile's .claude.json a directory containing an unreadable file so
  // the copy phase fails after .claude staged fine... but copy-phase failures
  // never touch live state. To prove rename-phase rollback, call
  // replaceLiveState directly with a source whose second piece disappears
  // between staging and rename — emulated here by deleting the staged copy.
  // Simpler deterministic approach: verify rollback via permission denial.
  const before = await readLiveMarker();

  // Failure injection: piece 1 (.claude) stages fine, then staging piece 2
  // (.claude.json) fails because the source file is unreadable (mode 000).
  // Staging-phase failures must leave the live state completely untouched.
  const ghost = path.join(sandbox, 'ghost-profile');
  await fs.mkdir(path.join(ghost, '.claude'), { recursive: true });
  await fs.writeFile(path.join(ghost, '.claude', 'ok.txt'), 'x');
  await fs.writeFile(path.join(ghost, '.claude.json'), '{}', { mode: 0o000 });

  await assert.rejects(() => core.replaceLiveState(p, ghost, log));
  const after = await readLiveMarker();
  assert.deepStrictEqual(after, before, 'live state must be unchanged after failed staging');
  // no stray staging/old dirs left at the live location
  const leftovers = (await fs.readdir(path.dirname(p.claudeDir)))
    .filter(n => n.includes('.staging-') || n.includes('.old-'));
  assert.deepStrictEqual(leftovers, []);
});

test('rename-phase failure rolls back already-swapped pieces', async () => {
  const p = paths();
  const before = await readLiveMarker();
  // Monkey-patch fs.rename used by core (fs/promises) to fail on the final
  // rename (staged .claude.json -> live), after .claude was already swapped.
  const realRename = fs.rename;
  let calls = 0;
  const target = p.claudeJson;
  fs.rename = async (a, b) => {
    if (b === target && String(a).includes('.staging-')) {
      calls++;
      throw new Error('injected rename failure');
    }
    return realRename(a, b);
  };
  try {
    const src = path.join(sandbox, 'rename-fail-profile');
    await fs.mkdir(path.join(src, '.claude'), { recursive: true });
    await fs.writeFile(path.join(src, '.claude', 'marker.txt'), 'INTRUDER');
    await fs.writeFile(path.join(src, '.claude.json'), JSON.stringify({ userID: 'INTRUDER' }));
    await assert.rejects(() => core.replaceLiveState(p, src, log), /injected rename failure/);
  } finally {
    fs.rename = realRename;
  }
  assert.ok(calls > 0, 'failure injection did not trigger');
  const after = await readLiveMarker();
  assert.deepStrictEqual(after, before, 'live state must be rolled back after rename-phase failure');
  assert.ok(!fss.existsSync(path.join(p.claudeDir, 'marker.txt')));
  const leftovers = (await fs.readdir(path.dirname(p.claudeDir)))
    .filter(n => n.includes('.staging-') || n.includes('.old-'));
  assert.deepStrictEqual(leftovers, []);
});

test('restore last backup brings previous state back', async () => {
  const p = paths();
  // current live = account A. Make a manual backup, then wreck live state.
  await core.backupLive(p, 'manual', { maxBackups: 50, log });
  await fs.rm(p.claudeDir, { recursive: true, force: true });
  await fs.rm(p.claudeJson, { force: true });
  assert.ok(!fss.existsSync(p.claudeDir));

  const restored = await core.restoreBackup(p, undefined, { maxBackups: 50, log });
  assert.ok(restored.reason.includes('manual'));
  const live = await readLiveMarker();
  assert.strictEqual(live.token, FAKE_TOKEN_A);
  assert.strictEqual(mode(path.join(p.claudeDir, '.credentials.json')), 0o600);
  // restore recorded the right active profile
  assert.strictEqual(await core.getActiveProfileName(p), 'AccountA');
});

test('delete profile', async () => {
  const p = paths();
  await core.deleteProfile(p, 'Broken');
  assert.ok(!(await core.getProfile(p, 'Broken')));
});

test('no token material in any log output', async () => {
  const joined = logLines.join('\n');
  assert.ok(!joined.includes('sk-fake'), 'logs must never contain tokens');
  assert.ok(!joined.includes('refresh-'), 'logs must never contain refresh tokens');
});

// ---------------------------------------------------------------------------

(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-switcher-test-'));
  await fs.mkdir(path.join(sandbox, 'home'), { recursive: true });
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok    ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL  ${t.name}`);
      console.error(`        ${err && err.message}`);
    }
  }
  await fs.rm(sandbox, { recursive: true, force: true });
  console.log(failed === 0 ? `\nAll ${tests.length} tests passed.` : `\n${failed}/${tests.length} tests FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
})();
