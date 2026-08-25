/**
 * Core logic tests for the v2 "live profiles" model. Runs entirely in a temp
 * sandbox — never touches the real ~/.claude or ~/.claude-profiles. Uses FAKE
 * tokens only, and asserts that no token material ever appears in any log
 * output or script output.
 *
 *   node test/core.test.js
 */
'use strict';
const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');
const core = require('../out/core.js');

const FAKE_TOKEN_A = 'sk-fake-token-account-A-do-not-log-1234567890';
const FAKE_TOKEN_B = 'sk-fake-token-account-B-do-not-log-0987654321';
const FAKE_TOKEN_C = 'sk-fake-token-account-C-do-not-log-1122334455';

let sandbox;
let logLines = [];
let outputs = []; // stdout/stderr collected from executed helper scripts
const log = (m) => logLines.push(m);

/** Main sandbox "home" paths — used by most tests. */
function paths() {
  return {
    claudeDir: path.join(sandbox, 'home', '.claude'),
    claudeJson: path.join(sandbox, 'home', '.claude.json'),
    profilesRoot: path.join(sandbox, 'home', '.claude-profiles')
  };
}

/** Independent paths under sandbox/<name> for isolated scenarios. */
function subPaths(name) {
  return {
    claudeDir: path.join(sandbox, name, '.claude'),
    claudeJson: path.join(sandbox, name, '.claude.json'),
    profilesRoot: path.join(sandbox, name, '.claude-profiles')
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

/** Create a fake live default-account state for a paths object. */
async function writeLiveState(p, token, marker, email) {
  await fs.rm(p.claudeDir, { recursive: true, force: true });
  await fs.rm(p.claudeJson, { force: true });
  await fs.mkdir(path.join(p.claudeDir, 'projects', 'demo'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(p.claudeDir, 'sessions'), { recursive: true });
  await fs.writeFile(path.join(p.claudeDir, '.credentials.json'), JSON.stringify(credsFor(token), null, 2), { mode: 0o600 });
  await fs.writeFile(path.join(p.claudeDir, 'sessions', 'session.txt'), `session-of-${marker}`);
  await fs.writeFile(path.join(p.claudeDir, 'settings.json'), JSON.stringify({ marker }), { mode: 0o644 });
  await fs.writeFile(path.join(p.claudeDir, 'CLAUDE.md'), `# global memory of ${marker}\n`, { mode: 0o644 });
  await fs.writeFile(p.claudeJson, JSON.stringify({
    userID: marker,
    hasCompletedOnboarding: true,
    theme: 'dark',
    oauthAccount: { emailAddress: email || `${marker}@example.com` },
    fakeSecretField: token, // must never be copied into profile seeds
    projects: {
      '/home/user/trusted-proj': { hasTrustDialogAccepted: true, history: ['do-not-copy'] },
      '/home/user/untrusted-proj': { hasTrustDialogAccepted: false }
    }
  }, null, 2), { mode: 0o600 });
  await fs.chmod(p.claudeDir, 0o700);
}

async function readLiveMarker(p) {
  const s = JSON.parse(await fs.readFile(path.join(p.claudeDir, 'settings.json'), 'utf8'));
  const j = JSON.parse(await fs.readFile(p.claudeJson, 'utf8'));
  const creds = JSON.parse(await fs.readFile(path.join(p.claudeDir, '.credentials.json'), 'utf8'));
  const session = await fs.readFile(path.join(p.claudeDir, 'sessions', 'session.txt'), 'utf8');
  return { marker: s.marker, userID: j.userID, token: creds.claudeAiOauth.accessToken, session };
}

/** Build one v0.x snapshot-layout profile (<dir>/.claude + <dir>/.claude.json). */
async function writeLegacyProfile(profilesRoot, name, token, marker) {
  const dir = path.join(profilesRoot, name);
  const snap = path.join(dir, '.claude');
  await fs.mkdir(path.join(snap, 'sessions'), { recursive: true });
  await fs.writeFile(path.join(snap, '.credentials.json'), JSON.stringify(credsFor(token), null, 2), { mode: 0o600 });
  await fs.writeFile(path.join(snap, 'settings.json'), JSON.stringify({ marker }));
  await fs.writeFile(path.join(snap, 'sessions', 'session.txt'), `session-of-${marker}`);
  await fs.writeFile(path.join(dir, '.claude.json'), JSON.stringify({
    userID: marker, oauthAccount: { emailAddress: `${marker}@example.com` }
  }), { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'profile.json'), JSON.stringify({
    name, createdAt: new Date().toISOString(), schemaVersion: 1
  }));
}

function mode(p) { return fss.statSync(p).mode & 0o777; }

function bashEnv(extra = {}) {
  return {
    HOME: path.join(sandbox, 'home'),
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    ...extra
  };
}

/** Source profile-env.sh, apply routing, print the resulting CLAUDE_CONFIG_DIR. */
function probeApply(cwd, extraEnv = {}, errFile) {
  const envSh = path.join(paths().profilesRoot, '_bin', 'profile-env.sh');
  const redirect = errFile ? ` 2>"${errFile}"` : '';
  const script = `. "${envSh}"\nclaude_profile_apply${redirect}\nprintf '%s' "\${CLAUDE_CONFIG_DIR:-unset}"`;
  const out = execFileSync('bash', ['-c', script], {
    cwd, encoding: 'utf8', env: bashEnv(extraEnv), stdio: ['ignore', 'pipe', 'pipe']
  });
  outputs.push(out);
  return out;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------------------------------------------------------------------------

test('name validation v2 (no spaces, no reserved names)', async () => {
  assert.strictEqual(core.cleanProfileName('My Account'), 'My-Account');
  assert.strictEqual(core.cleanProfileName('  My Profile! '), 'My-Profile');
  assert.strictEqual(core.cleanProfileName('a  b   c'), 'a-b-c');
  assert.ok(core.isValidProfileName('Main'));
  assert.ok(core.isValidProfileName('a.b-c_d'));
  assert.ok(!core.isValidProfileName('My Account'), 'spaces are invalid in v2');
  assert.ok(!core.isValidProfileName('_x'), 'reserved prefix');
  assert.ok(!core.isValidProfileName('_backups'));
  assert.ok(!core.isValidProfileName('default'));
  assert.ok(!core.isValidProfileName('Default'));
  assert.ok(!core.isValidProfileName(''));
  assert.ok(!core.isValidProfileName('a'.repeat(65)));
});

test('setup: fake default account; listProfiles shows it first with email', async () => {
  const p = paths();
  await writeLiveState(p, FAKE_TOKEN_A, 'account-A', 'default@example.com');
  const all = await core.listProfiles(p);
  assert.strictEqual(all.length, 1, 'only the default profile exists initially');
  assert.strictEqual(all[0].name, 'default');
  assert.ok(all[0].isDefault);
  assert.strictEqual(all[0].dir, p.claudeDir);
  assert.strictEqual(all[0].email, 'default@example.com');
  assert.strictEqual(all[0].loggedIn, true);
  assert.strictEqual(all[0].legacyLayout, false);
});

test('createProfile seeds settings/CLAUDE.md and trust — never credentials', async () => {
  const p = paths();
  const info = await core.createProfile(p, 'Work', {}, log);
  assert.strictEqual(info.name, 'Work');
  assert.strictEqual(info.isDefault, false);
  assert.strictEqual(info.loggedIn, false, 'new profile starts logged out');
  assert.strictEqual(info.legacyLayout, false);
  assert.strictEqual(info.schemaVersion, 2);
  const dir = path.join(p.profilesRoot, 'Work');
  assert.strictEqual(info.dir, dir);
  assert.strictEqual(mode(dir), 0o700, 'profile dir should be 700');

  // seeded copies from the default account
  assert.ok(fss.existsSync(path.join(dir, 'settings.json')));
  assert.ok(fss.existsSync(path.join(dir, 'CLAUDE.md')));

  // seeded .claude.json: onboarding + trusted projects only, no secrets
  const seed = JSON.parse(await fs.readFile(path.join(dir, '.claude.json'), 'utf8'));
  assert.strictEqual(seed.hasCompletedOnboarding, true);
  assert.strictEqual(seed.theme, 'dark');
  assert.deepStrictEqual(seed.projects, { '/home/user/trusted-proj': { hasTrustDialogAccepted: true } },
    'only trusted projects, stripped to the trust flag');
  assert.strictEqual(seed.oauthAccount, undefined, 'account identity is not copied');
  assert.strictEqual(seed.fakeSecretField, undefined, 'non-whitelisted keys are not copied');
  assert.ok(!JSON.stringify(seed).includes('sk-fake'), 'seed must contain no token material');

  // credentials are NEVER seeded
  assert.ok(!fss.existsSync(path.join(dir, '.credentials.json')));

  // profile metadata
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'profile.json'), 'utf8'));
  assert.strictEqual(meta.name, 'Work');
  assert.strictEqual(meta.schemaVersion, 2);

  // an unseeded profile stays minimal
  await core.createProfile(p, 'Personal', { seedFromDefault: false, copyTrust: false }, log);
  const pdir = path.join(p.profilesRoot, 'Personal');
  assert.ok(!fss.existsSync(path.join(pdir, 'settings.json')));
  assert.ok(!fss.existsSync(path.join(pdir, '.claude.json')));
  assert.ok(!fss.existsSync(path.join(pdir, '.credentials.json')));
  assert.ok(fss.existsSync(path.join(pdir, 'profile.json')));
});

test('createProfile rejects invalid, reserved and duplicate names', async () => {
  const p = paths();
  await assert.rejects(() => core.createProfile(p, 'My Account'), /Invalid profile name/);
  await assert.rejects(() => core.createProfile(p, '_bin'), /Invalid profile name/);
  await assert.rejects(() => core.createProfile(p, 'default'), /Invalid profile name/);
  await assert.rejects(() => core.createProfile(p, 'Work'), /already exists/);
});

test('listProfiles: loggedIn flips with credentials; profile email; legacy layout detected', async () => {
  const p = paths();
  let work = (await core.listProfiles(p)).find(x => x.name === 'Work');
  assert.strictEqual(work.loggedIn, false);

  // simulate logging in as account B inside the Work profile
  const wdir = path.join(p.profilesRoot, 'Work');
  await fs.writeFile(path.join(wdir, '.credentials.json'), JSON.stringify(credsFor(FAKE_TOKEN_B), null, 2), { mode: 0o600 });
  const seed = JSON.parse(await fs.readFile(path.join(wdir, '.claude.json'), 'utf8'));
  seed.oauthAccount = { emailAddress: 'work@example.com' };
  await fs.writeFile(path.join(wdir, '.claude.json'), JSON.stringify(seed), { mode: 0o600 });

  const all = await core.listProfiles(p);
  assert.strictEqual(all[0].name, 'default', 'default is always first');
  work = all.find(x => x.name === 'Work');
  assert.strictEqual(work.loggedIn, true);
  assert.strictEqual(work.email, 'work@example.com');

  // a leftover v0.x snapshot profile is flagged as legacy
  const ldir = path.join(p.profilesRoot, 'LegacyProf', '.claude');
  await fs.mkdir(ldir, { recursive: true });
  await fs.writeFile(path.join(ldir, '.credentials.json'), JSON.stringify(credsFor(FAKE_TOKEN_C)), { mode: 0o600 });
  const legacy = (await core.listProfiles(p)).find(x => x.name === 'LegacyProf');
  assert.strictEqual(legacy.legacyLayout, true);
  assert.strictEqual(legacy.schemaVersion, 1);
  assert.strictEqual(legacy.loggedIn, true, 'legacy creds live under .claude/');
  const lv = await core.validateProfile(p, 'LegacyProf');
  assert.ok(lv.warnings.some(w => /v0\.x/.test(w)), 'legacy layout should warn about migration');
  await fs.rm(path.join(p.profilesRoot, 'LegacyProf'), { recursive: true, force: true });
});

test('validateProfile reports shape only, never token material', async () => {
  const p = paths();
  const okv = await core.validateProfile(p, 'Work');
  assert.ok(okv.ok && okv.errors.length === 0);

  const notLoggedIn = await core.validateProfile(p, 'Personal');
  assert.ok(notLoggedIn.ok);
  assert.ok(notLoggedIn.warnings.some(w => /Not logged in/i.test(w)));

  const missing = await core.validateProfile(p, 'NoSuch');
  assert.ok(!missing.ok && missing.errors.some(e => /does not exist/.test(e)));

  await core.createProfile(p, 'Broken', { seedFromDefault: false, copyTrust: false }, log);
  const bdir = path.join(p.profilesRoot, 'Broken');
  await fs.writeFile(path.join(bdir, '.credentials.json'), 'NOT JSON {', { mode: 0o600 });
  let v = await core.validateProfile(p, 'Broken');
  assert.ok(!v.ok && v.errors.some(e => /not valid JSON/.test(e)));

  await fs.writeFile(path.join(bdir, '.credentials.json'), JSON.stringify({ claudeAiOauth: {} }), { mode: 0o600 });
  v = await core.validateProfile(p, 'Broken');
  assert.ok(!v.ok && v.errors.some(e => /no usable access token/.test(e)));
  assert.ok(!JSON.stringify(v).includes('sk-fake'), 'validation output must not leak tokens');

  await core.deleteProfile(p, 'Broken');
  assert.strictEqual(await core.getProfile(p, 'Broken'), undefined);
});

test('map.conf round-trip: longest prefix wins; default removes entry', async () => {
  const p = paths();
  const alpha = path.join(sandbox, 'home', 'projects', 'alpha');
  const sub = path.join(alpha, 'sub');
  await fs.mkdir(path.join(sub, 'deep'), { recursive: true });

  await core.setMapping(p, alpha, 'Work');
  assert.deepStrictEqual(await core.listMap(p), [{ prefix: alpha, profile: 'Work' }]);
  await assert.rejects(() => core.setMapping(p, alpha, 'NoSuch'), /does not exist/);

  await core.setMapping(p, sub, 'Personal');
  const home = path.join(sandbox, 'home');
  assert.strictEqual(await core.resolveProfileForDir(p, alpha, home), 'Work', 'exact prefix matches');
  assert.strictEqual(await core.resolveProfileForDir(p, path.join(alpha, 'other'), home), 'Work');
  assert.strictEqual(await core.resolveProfileForDir(p, path.join(sub, 'deep'), home), 'Personal', 'longest prefix wins');

  // routing to 'default' removes the entry rather than storing it
  await core.setMapping(p, sub, 'default');
  assert.ok(!(await core.listMap(p)).some(e => e.prefix === sub));
  assert.strictEqual(await core.resolveProfileForDir(p, path.join(sub, 'deep'), home), 'Work');

  await core.removeMapping(p, alpha);
  assert.deepStrictEqual(await core.listMap(p), []);
  assert.strictEqual(await core.resolveProfileForDir(p, alpha, home), 'default');
});

test('resolveProfileForDir: .claude-profile beats map, walks up, stops at home', async () => {
  const p = paths();
  const home = path.join(sandbox, 'home');
  const beta = path.join(home, 'projects', 'beta');
  await fs.mkdir(path.join(beta, 'child'), { recursive: true });

  await core.setMapping(p, beta, 'Work');
  assert.strictEqual(await core.resolveProfileForDir(p, beta, home), 'Work');

  // a .claude-profile file wins over map.conf
  await fs.writeFile(path.join(beta, '.claude-profile'), 'Personal\n');
  assert.strictEqual(await core.resolveProfileForDir(p, beta, home), 'Personal');
  // and is found by walking up from a child dir
  assert.strictEqual(await core.resolveProfileForDir(p, path.join(beta, 'child'), home), 'Personal');

  // the walk stops at homeDir: a marker above home is never seen
  const plain = path.join(home, 'projects', 'plain');
  await fs.mkdir(plain, { recursive: true });
  await fs.writeFile(path.join(sandbox, '.claude-profile'), 'Personal\n');
  assert.strictEqual(await core.resolveProfileForDir(p, plain, home), 'default');
  await fs.rm(path.join(sandbox, '.claude-profile'));

  // unknown profile names normalize to 'default'
  const gamma = path.join(home, 'projects', 'gamma');
  await fs.mkdir(gamma, { recursive: true });
  await fs.writeFile(path.join(gamma, '.claude-profile'), 'Ghost\n');
  assert.strictEqual(await core.resolveProfileForDir(p, gamma, home), 'default');
});

test('default label: setDefaultLabel + isDefaultName + label resolves as default', async () => {
  const p = paths();
  const home = path.join(sandbox, 'home');
  assert.strictEqual(await core.getDefaultLabel(p), undefined);
  await core.setDefaultLabel(p, 'Main');
  assert.strictEqual(await core.getDefaultLabel(p), 'Main');

  assert.ok(await core.isDefaultName(p, 'default'));
  assert.ok(await core.isDefaultName(p, 'Default'), "'default' matches case-insensitively");
  assert.ok(await core.isDefaultName(p, 'Main'), 'the label counts as the default');
  assert.ok(!(await core.isDefaultName(p, 'Work')));

  const all = await core.listProfiles(p);
  assert.strictEqual(all[0].label, 'Main');
  const viaLabel = await core.getProfile(p, 'Main');
  assert.ok(viaLabel && viaLabel.isDefault, 'label resolves to the default profile');

  // a .claude-profile naming the label routes to default
  const delta = path.join(home, 'projects', 'delta');
  await fs.mkdir(delta, { recursive: true });
  await fs.writeFile(path.join(delta, '.claude-profile'), 'Main\n');
  assert.strictEqual(await core.resolveProfileForDir(p, delta, home), 'default');

  // mapping a folder to the label acts as 'route to default' (entry removed)
  await core.setMapping(p, delta, 'Work');
  await core.setMapping(p, delta, 'Main');
  assert.ok(!(await core.listMap(p)).some(e => e.prefix === delta));

  // the label is reserved: it cannot be taken by a new profile
  await assert.rejects(() => core.createProfile(p, 'Main'), /default account/);
});

test('helper scripts: rendered, wrapper executable, second materialize is a no-op', async () => {
  const p = paths();
  const rendered = core.renderHelperScripts(p, '9.9.9-test');
  for (const s of [rendered.profileEnv, rendered.wrapper]) {
    assert.ok(s.includes(path.resolve(p.profilesRoot)), 'profilesRoot must be baked in');
    assert.ok(!s.includes('__PROFILES_ROOT__') && !s.includes('__VERSION__'), 'no placeholders left');
    assert.ok(s.includes('9.9.9-test'));
  }

  const writes = [];
  const wrapperPath = await core.materializeHelperScripts(p, '9.9.9-test', (m) => writes.push(m));
  const envShPath = path.join(p.profilesRoot, '_bin', 'profile-env.sh');
  assert.strictEqual(wrapperPath, path.join(p.profilesRoot, '_bin', 'claude-wrapper.sh'));
  assert.strictEqual(writes.length, 2, 'first call writes both scripts');
  assert.ok(fss.existsSync(envShPath));
  assert.ok(fss.existsSync(wrapperPath));
  assert.ok(mode(wrapperPath) & 0o111, 'wrapper must be executable');
  const wrapperTxt = await fs.readFile(wrapperPath, 'utf8');
  assert.ok(wrapperTxt.includes(path.resolve(p.profilesRoot)));
  assert.ok(!wrapperTxt.includes('__PROFILES_ROOT__') && !wrapperTxt.includes('__VERSION__'));

  // idempotent: same version again rewrites nothing
  const before = [fss.statSync(envShPath).mtimeMs, fss.statSync(wrapperPath).mtimeMs];
  const rewrites = [];
  await core.materializeHelperScripts(p, '9.9.9-test', (m) => rewrites.push(m));
  const after = [fss.statSync(envShPath).mtimeMs, fss.statSync(wrapperPath).mtimeMs];
  assert.deepStrictEqual(rewrites, [], 'second call must not rewrite');
  assert.deepStrictEqual(after, before, 'mtimes unchanged on second call');
});

test('renderHelperScripts rejects a profilesRoot that could inject shell code', async () => {
  const base = paths();
  for (const bad of [
    path.join(base.profilesRoot, '..', 'x"; touch /tmp/pwned; echo "'),
    path.join(base.profilesRoot, '..', 'x`touch /tmp/pwned`'),
    path.join(base.profilesRoot, '..', 'x$(touch /tmp/pwned)')
  ]) {
    assert.throws(() => core.renderHelperScripts({ ...base, profilesRoot: bad }, '9.9.9-test'),
      /not safe to embed in a shell script/, `expected rejection for: ${bad}`);
  }
  // a normal path is unaffected
  assert.doesNotThrow(() => core.renderHelperScripts(base, '9.9.9-test'));
});

test('bash: profile-env.sh routes new processes per folder/env', async () => {
  const p = paths();
  const home = path.join(sandbox, 'home');
  const workDir = path.join(p.profilesRoot, 'Work');
  const personalDir = path.join(p.profilesRoot, 'Personal');

  const mapped = path.join(home, 'bash', 'mapped');
  const unmapped = path.join(home, 'bash', 'unmapped');
  const marker = path.join(home, 'bash', 'marker');
  const labelDir = path.join(home, 'bash', 'label');
  const ghost = path.join(home, 'bash', 'ghost');
  for (const d of [mapped, path.join(mapped, 'nested'), unmapped, path.join(marker, 'child'), labelDir, ghost]) {
    await fs.mkdir(d, { recursive: true });
  }
  await core.setMapping(p, mapped, 'Work');
  await core.setMapping(p, marker, 'Work');
  await fs.writeFile(path.join(marker, '.claude-profile'), 'Personal\n');
  await fs.writeFile(path.join(labelDir, '.claude-profile'), 'Main\n');
  await fs.writeFile(path.join(ghost, '.claude-profile'), 'Ghost\n');

  // mapped folder -> the profile's live config dir
  assert.strictEqual(probeApply(mapped), workDir);
  // subfolder of a mapped prefix
  assert.strictEqual(probeApply(path.join(mapped, 'nested')), workDir);
  // unmapped folder -> default account (variable stays unset)
  assert.strictEqual(probeApply(unmapped), 'unset');
  // CLAUDE_PROFILE env overrides the folder
  assert.strictEqual(probeApply(unmapped, { CLAUDE_PROFILE: 'Work' }), workDir);
  // CLAUDE_PROFILE naming 'default' or the label -> default account
  assert.strictEqual(probeApply(mapped, { CLAUDE_PROFILE: 'default' }), 'unset');
  assert.strictEqual(probeApply(mapped, { CLAUDE_PROFILE: 'Main' }), 'unset');
  // a preset CLAUDE_CONFIG_DIR is always respected untouched
  assert.strictEqual(probeApply(mapped, { CLAUDE_CONFIG_DIR: '/preset/config-dir' }), '/preset/config-dir');
  // .claude-profile file wins over map.conf
  assert.strictEqual(probeApply(marker), personalDir);
  // and is found from a child dir by walking up
  assert.strictEqual(probeApply(path.join(marker, 'child')), personalDir);
  // .claude-profile naming the default label -> default account
  assert.strictEqual(probeApply(labelDir), 'unset');
  // unknown profile -> default account plus a warning on stderr
  const errFile = path.join(sandbox, 'ghost-stderr.txt');
  assert.strictEqual(probeApply(ghost, {}, errFile), 'unset');
  const stderrTxt = await fs.readFile(errFile, 'utf8');
  outputs.push(stderrTxt);
  assert.ok(stderrTxt.includes("unknown profile 'Ghost'"), `expected warning, got: ${stderrTxt}`);
});

test('bash: claude-wrapper.sh execs the real binary with routed CLAUDE_CONFIG_DIR', async () => {
  const p = paths();
  const home = path.join(sandbox, 'home');
  const wrapper = path.join(p.profilesRoot, '_bin', 'claude-wrapper.sh');
  const mapped = path.join(home, 'bash', 'mapped'); // mapped -> Work
  const workDir = path.join(p.profilesRoot, 'Work');

  const fakeBin = path.join(sandbox, 'bin', 'fake-claude');
  await fs.mkdir(path.dirname(fakeBin), { recursive: true });
  await fs.writeFile(fakeBin,
    '#!/usr/bin/env bash\nprintf \'CONFIG=%s\\n\' "${CLAUDE_CONFIG_DIR:-unset}"\nprintf \'ARGS=%s\\n\' "$*"\n',
    { mode: 0o755 });

  const out = execFileSync('bash', [wrapper, fakeBin, 'arg1'], {
    cwd: mapped, encoding: 'utf8', env: bashEnv(), stdio: ['ignore', 'pipe', 'pipe']
  });
  outputs.push(out);
  assert.ok(out.includes(`CONFIG=${workDir}`), `fake binary must see the mapped profile dir, got: ${out}`);
  assert.ok(out.includes('ARGS=arg1'), 'arguments must pass through untouched');

  // from an unmapped folder the wrapper leaves routing alone (default account)
  const out2 = execFileSync('bash', [wrapper, fakeBin], {
    cwd: path.join(home, 'bash', 'unmapped'), encoding: 'utf8', env: bashEnv(), stdio: ['ignore', 'pipe', 'pipe']
  });
  outputs.push(out2);
  assert.ok(out2.includes('CONFIG=unset'));

  // a non-executable first argument fails loudly with exit 127
  const notExec = path.join(sandbox, 'bin', 'not-executable');
  await fs.writeFile(notExec, 'plain file', { mode: 0o644 });
  let status = 0, stderrTxt = '';
  try {
    execFileSync('bash', [wrapper, notExec], {
      cwd: mapped, encoding: 'utf8', env: bashEnv(), stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    status = err.status;
    stderrTxt = String(err.stderr || '');
  }
  outputs.push(stderrTxt);
  assert.strictEqual(status, 127);
  assert.ok(stderrTxt.includes('claude-wrapper: expected'));
});

test('backupLogins snapshots credentials for every live profile (600), prunes oldest', async () => {
  const p = paths();
  const first = await core.backupLogins(p, log);
  assert.ok(path.basename(first.dir).endsWith('-logins'));
  assert.strictEqual(first.reason, 'logins');
  assert.ok(fss.existsSync(path.join(first.dir, 'backup.json')));

  // default account login captured
  const defCreds = JSON.parse(await fs.readFile(path.join(first.dir, 'default', '.credentials.json'), 'utf8'));
  assert.strictEqual(defCreds.claudeAiOauth.accessToken, FAKE_TOKEN_A);
  assert.ok(fss.existsSync(path.join(first.dir, 'default', '.claude.json')));
  assert.strictEqual(mode(path.join(first.dir, 'default', '.credentials.json')), 0o600);

  // Work profile login captured
  const workCreds = JSON.parse(await fs.readFile(path.join(first.dir, 'Work', '.credentials.json'), 'utf8'));
  assert.strictEqual(workCreds.claudeAiOauth.accessToken, FAKE_TOKEN_B);
  assert.strictEqual(mode(path.join(first.dir, 'Work', '.credentials.json')), 0o600);

  // Personal has no login files -> nothing snapshotted for it
  assert.ok(!fss.existsSync(path.join(first.dir, 'Personal')));

  await new Promise(r => setTimeout(r, 10)); // distinct timestamped dir name
  const second = await core.backupLogins(p, log);
  assert.notStrictEqual(second.dir, first.dir);
  assert.strictEqual((await core.listBackups(p)).length, 2);

  await core.pruneBackups(p, 1, log);
  const remaining = await core.listBackups(p);
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0].dir, second.dir, 'oldest is pruned first');
});

test('deleteProfile removes the directory and its map entries', async () => {
  const p = paths();
  const home = path.join(sandbox, 'home');
  const delDir = path.join(home, 'projects', 'to-delete');
  await fs.mkdir(delDir, { recursive: true });
  await core.setMapping(p, delDir, 'Personal');
  assert.ok((await core.listMap(p)).some(e => e.profile === 'Personal'));

  await assert.rejects(() => core.deleteProfile(p, 'default'), /cannot be deleted/);
  await assert.rejects(() => core.deleteProfile(p, 'Main'), /cannot be deleted/);
  await assert.rejects(() => core.deleteProfile(p, 'NoSuch'), /does not exist/);

  await core.deleteProfile(p, 'Personal');
  assert.ok(!fss.existsSync(path.join(p.profilesRoot, 'Personal')));
  assert.strictEqual(await core.getProfile(p, 'Personal'), undefined);
  assert.ok(!(await core.listMap(p)).some(e => e.profile === 'Personal'), 'map entries to the deleted profile removed');

  // a stale .claude-profile naming it now falls back to default
  const beta = path.join(home, 'projects', 'beta');
  assert.strictEqual(await core.resolveProfileForDir(p, beta, home), 'default');
});

test('migrateToV2 converts a full v0.x tree (active profile becomes the default label)', async () => {
  const p = subPaths('mig');
  // live default state = the v0.x active profile 'Main' (account A). Live and
  // snapshot carry the SAME account email — migrateToV2 verifies that before
  // trusting the active-profile marker.
  await writeLiveState(p, FAKE_TOKEN_A, 'account-A');
  // v0.x snapshot profiles
  await writeLegacyProfile(p.profilesRoot, 'Main', FAKE_TOKEN_A, 'account-A');
  await writeLegacyProfile(p.profilesRoot, 'Second Account', FAKE_TOKEN_B, 'account-B');
  await fs.writeFile(path.join(p.profilesRoot, 'active-profile.json'),
    JSON.stringify({ activeProfile: 'Main', savedAt: new Date().toISOString() }));

  const migLog = [];
  const report = await core.migrateToV2(p, (m) => { migLog.push(m); logLines.push(m); });

  // active profile: stale snapshot removed, name became the default label
  assert.strictEqual(report.becameDefault, 'Main');
  assert.ok(!fss.existsSync(path.join(p.profilesRoot, 'Main')));
  assert.strictEqual(await core.getDefaultLabel(p), 'Main');
  // live default account untouched by migration
  assert.strictEqual((await readLiveMarker(p)).token, FAKE_TOKEN_A);

  // its login files were backed up before removal
  const backupNames = await fs.readdir(path.join(p.profilesRoot, '_backups'));
  const mainBackup = backupNames.find(n => n.includes('-migrate-Main'));
  assert.ok(mainBackup, 'migrate backup for Main must exist');
  const backedUp = JSON.parse(await fs.readFile(
    path.join(p.profilesRoot, '_backups', mainBackup, '.credentials.json'), 'utf8'));
  assert.strictEqual(backedUp.claudeAiOauth.accessToken, FAKE_TOKEN_A);
  assert.ok(fss.existsSync(path.join(p.profilesRoot, '_backups', mainBackup, '.claude.json')));
  // the FULL stale snapshot was archived (renamed), not deleted
  assert.strictEqual(
    JSON.parse(await fs.readFile(path.join(p.profilesRoot, '_backups', mainBackup, 'snapshot', '.claude', 'settings.json'), 'utf8')).marker,
    'account-A', 'whole snapshot archived under the migrate backup');
  assert.ok(backupNames.some(n => n.includes('-migrate-Second Account')), 'non-active profile also backed up');

  // non-active profile: renamed (no spaces in v2) and flattened into a live dir
  assert.deepStrictEqual(report.renamed, [{ from: 'Second Account', to: 'Second-Account' }]);
  assert.deepStrictEqual(report.migrated, ['Second-Account']);
  assert.ok(!fss.existsSync(path.join(p.profilesRoot, 'Second Account')));
  const sdir = path.join(p.profilesRoot, 'Second-Account');
  assert.ok(!fss.existsSync(path.join(sdir, '.claude')), 'snapshot subdir flattened away');
  const sCreds = JSON.parse(await fs.readFile(path.join(sdir, '.credentials.json'), 'utf8'));
  assert.strictEqual(sCreds.claudeAiOauth.accessToken, FAKE_TOKEN_B, 'login preserved through migration');
  assert.strictEqual(await fs.readFile(path.join(sdir, 'sessions', 'session.txt'), 'utf8'), 'session-of-account-B');
  assert.strictEqual(JSON.parse(await fs.readFile(path.join(sdir, 'settings.json'), 'utf8')).marker, 'account-B');
  const sMeta = JSON.parse(await fs.readFile(path.join(sdir, 'profile.json'), 'utf8'));
  assert.strictEqual(sMeta.name, 'Second-Account');
  assert.strictEqual(sMeta.schemaVersion, 2);
  assert.strictEqual(mode(sdir), 0o700);
  assert.strictEqual(mode(path.join(sdir, '.credentials.json')), 0o600);

  // legacy marker file removed; listProfiles now shows a clean v2 world
  assert.ok(!fss.existsSync(path.join(p.profilesRoot, 'active-profile.json')));
  const all = await core.listProfiles(p);
  assert.deepStrictEqual(all.map(x => x.name), ['default', 'Second-Account']);
  assert.strictEqual(all[0].label, 'Main');
  const second = all[1];
  assert.strictEqual(second.legacyLayout, false);
  assert.strictEqual(second.loggedIn, true);
  assert.strictEqual(second.email, 'account-B@example.com');
  assert.strictEqual(second.schemaVersion, 2);

  // migration must never log token material
  assert.ok(!migLog.join('\n').includes('sk-fake'), 'migration log leaked a token');
});

test('migrateToV2 distrusts a stale active marker and shadowing names', async () => {
  const p = subPaths('mig2');
  // live default belongs to account-A, but the marker claims 'Old' (account-B
  // snapshot) is active — e.g. profilesRoot restored from another machine.
  await writeLiveState(p, FAKE_TOKEN_A, 'account-A');
  await writeLegacyProfile(p.profilesRoot, 'Old', FAKE_TOKEN_B, 'account-B');
  // a legacy profile whose name would shadow the built-in default
  await writeLegacyProfile(p.profilesRoot, 'Default', FAKE_TOKEN_B, 'account-C');
  await fs.writeFile(path.join(p.profilesRoot, 'active-profile.json'),
    JSON.stringify({ activeProfile: 'Old' }));

  const report = await core.migrateToV2(p, (m) => logLines.push(m));

  // stale marker: 'Old' is NOT collapsed into the default account
  assert.strictEqual(report.becameDefault, undefined);
  assert.strictEqual(await core.getDefaultLabel(p), undefined);
  assert.ok(report.warnings.some(w => w.includes('Old')), 'stale-marker warning expected');
  assert.ok(fss.existsSync(path.join(p.profilesRoot, 'Old', '.credentials.json')),
    'Old migrated as a normal live profile, login preserved');

  // 'Default' cannot keep a name that isDefaultName() would shadow
  const renamedDefault = report.renamed.find(r => r.from === 'Default');
  assert.ok(renamedDefault, "profile literally named 'Default' must be renamed");
  assert.ok(!fss.existsSync(path.join(p.profilesRoot, 'Default')));
  const newDir = path.join(p.profilesRoot, renamedDefault.to);
  assert.ok(fss.existsSync(path.join(newDir, '.credentials.json')), 'its login stays reachable');
  assert.strictEqual(await core.resolveProfileForDir(p, path.join(sandbox, 'home'), path.join(sandbox, 'home')), 'default');
  assert.notStrictEqual((await core.configDirFor(p, renamedDefault.to)), p.claudeDir);
});

test('legacy restore: restoreBackup rebuilds the live default with a pre-restore safety copy', async () => {
  const p = subPaths('restore');
  await writeLiveState(p, FAKE_TOKEN_A, 'live-A');

  // a v0.x-style full backup of account B
  const bdir = path.join(p.profilesRoot, '_backups', '2020-01-01T00-00-00-000Z-manual');
  await fs.mkdir(path.join(bdir, '.claude', 'sessions'), { recursive: true });
  await fs.writeFile(path.join(bdir, '.claude', '.credentials.json'), JSON.stringify(credsFor(FAKE_TOKEN_B), null, 2), { mode: 0o600 });
  await fs.writeFile(path.join(bdir, '.claude', 'settings.json'), JSON.stringify({ marker: 'backup-B' }));
  await fs.writeFile(path.join(bdir, '.claude', 'sessions', 'session.txt'), 'session-of-backup-B');
  await fs.writeFile(path.join(bdir, '.claude.json'), JSON.stringify({ userID: 'backup-B' }), { mode: 0o600 });
  await fs.writeFile(path.join(bdir, 'backup.json'), JSON.stringify({ dir: bdir, reason: 'manual', createdAt: '2020-01-01T00:00:00.000Z' }));

  const listed = await core.listBackups(p);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].reason, 'manual');

  // wreck the live default
  await fs.rm(p.claudeDir, { recursive: true, force: true });
  await fs.writeFile(p.claudeJson, JSON.stringify({ userID: 'wrecked' }), { mode: 0o600 });
  assert.ok(!fss.existsSync(p.claudeDir));

  await core.restoreBackup(p, listed[0], log);
  const live = await readLiveMarker(p);
  assert.strictEqual(live.token, FAKE_TOKEN_B);
  assert.strictEqual(live.marker, 'backup-B');
  assert.strictEqual(live.userID, 'backup-B');
  assert.strictEqual(live.session, 'session-of-backup-B');
  assert.strictEqual(mode(p.claudeDir), 0o700);
  assert.strictEqual(mode(path.join(p.claudeDir, '.credentials.json')), 0o600);
  assert.strictEqual(mode(p.claudeJson), 0o600);

  // a pre-restore safety backup captured the wrecked state first
  const safety = (await core.listBackups(p)).find(b => b.reason === 'pre-restore');
  assert.ok(safety, 'pre-restore safety backup must exist');
  const saved = JSON.parse(await fs.readFile(path.join(safety.dir, '.claude.json'), 'utf8'));
  assert.strictEqual(saved.userID, 'wrecked');
});

test('replaceLiveState: rename-phase failure rolls back already-swapped pieces', async () => {
  const p = subPaths('restore'); // live state = backup-B from the previous test
  const before = await readLiveMarker(p);

  // Monkey-patch fs.rename used by core (fs/promises) to fail on the final
  // rename (staged .claude.json -> live), after .claude was already swapped.
  const realRename = fs.rename;
  let calls = 0;
  fs.rename = async (a, b) => {
    if (b === p.claudeJson && String(a).includes('.staging-')) {
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
  const after = await readLiveMarker(p);
  assert.deepStrictEqual(after, before, 'live state must be rolled back after rename-phase failure');
  assert.ok(!fss.existsSync(path.join(p.claudeDir, 'marker.txt')));
  const leftovers = (await fs.readdir(path.dirname(p.claudeDir)))
    .filter(n => n.includes('.staging-') || n.includes('.old-'));
  assert.deepStrictEqual(leftovers, []);
});

test('no token material in any log or script output', async () => {
  const joined = logLines.join('\n') + '\n' + outputs.join('\n');
  assert.ok(logLines.length > 0, 'expected some log lines to inspect');
  assert.ok(outputs.length > 0, 'expected some script outputs to inspect');
  assert.ok(!joined.includes('sk-fake'), 'logs/outputs must never contain tokens');
  assert.ok(!joined.includes('refresh-account'), 'logs/outputs must never contain refresh tokens');
});

// ---------------------------------------------------------------------------

(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-switcher-test-'));
  sandbox = await fs.realpath(sandbox); // bash $PWD is physical; keep paths identical
  await fs.mkdir(path.join(sandbox, 'home'), { recursive: true });
  await fs.mkdir(path.join(sandbox, 'mig'), { recursive: true });
  await fs.mkdir(path.join(sandbox, 'restore'), { recursive: true });
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
