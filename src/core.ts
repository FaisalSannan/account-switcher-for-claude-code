/**
 * Core logic for Account Switcher for Claude Code — v2 "live profiles" model.
 *
 * v0.x snapshotted ~/.claude and swapped it on every switch, which meant one
 * live account at a time, a window reload per switch, and snapshots whose
 * OAuth tokens rotted while another account was live.
 *
 * v2 keeps every account permanently live instead:
 *
 *   - Each profile directory under ~/.claude-profiles/<Name> IS a real
 *     CLAUDE_CONFIG_DIR: its own credentials, settings, sessions, history.
 *   - The original ~/.claude (+ ~/.claude.json) stays as the built-in
 *     "default" profile. Nothing is ever moved or copied at switch time.
 *   - "Switching" only decides which profile NEW Claude processes use, via
 *     the per-directory map (map.conf), a .claude-profile file in a project,
 *     or the CLAUDE_PROFILE / CLAUDE_CONFIG_DIR environment variables.
 *     Routing is applied by a tiny wrapper script that the official Claude
 *     extension launches instead of its binary (claudeCode.claudeProcessWrapper),
 *     and by any terminal launcher that sources _bin/profile-env.sh.
 *   - Running sessions keep their process and their account untouched; a
 *     switch can never interrupt them. There is no logout code path at all,
 *     so a reboot or VM shutdown cannot sign any account out: every login
 *     lives only in its profile's directory until the user deletes it.
 *
 * This module has NO dependency on the 'vscode' API so it can be unit-tested
 * directly with node. All paths are injected via the Paths object.
 *
 * Safety rules enforced here:
 *  - Never log or return token/credential values; validation reports shape only.
 *  - Migration from the v0.x layout backs up login files before touching them.
 *  - File permissions: 700 on profile dirs, 600 on credential/state JSONs.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

export interface Paths {
  /** Default account's config dir, normally ~/.claude */
  claudeDir: string;
  /** Default account's root JSON, normally ~/.claude.json */
  claudeJson: string;
  /** Root folder holding all profiles, normally ~/.claude-profiles */
  profilesRoot: string;
}

export interface ProfileInfo {
  /** Directory name, or 'default' for the built-in ~/.claude profile. */
  name: string;
  /** The CLAUDE_CONFIG_DIR this profile represents. */
  dir: string;
  isDefault: boolean;
  /** Optional display label carried over from a v0.x active profile. */
  label?: string;
  /** Account email from .claude.json (never tokens). */
  email?: string;
  /** Whether a credentials file is present (presence only, never contents). */
  loggedIn: boolean;
  /** True when the profile still has the v0.x snapshot layout (.claude/ inside). */
  legacyLayout: boolean;
  createdAt?: string;
  schemaVersion: number;
}

export interface MapEntry {
  /** Absolute directory prefix (longest match wins). */
  prefix: string;
  /** Profile name, or 'default'. */
  profile: string;
}

export interface ValidationResult {
  ok: boolean;
  /** Human-readable issues. Never contains credential values. */
  errors: string[];
  warnings: string[];
}

export interface MigrationReport {
  migrated: string[];
  becameDefault?: string;
  renamed: Array<{ from: string; to: string }>;
  warnings: string[];
}

export interface BackupInfo {
  dir: string;
  reason: string;
  createdAt: string;
}

export type Logger = (message: string) => void;

export const DEFAULT_PROFILE = 'default';
export const RESERVED_PREFIX = '_';

const BACKUPS_DIRNAME = '_backups';
const BIN_DIRNAME = '_bin';
const PROFILE_META = 'profile.json';
const BACKUP_META = 'backup.json';
const MAP_FILE = 'map.conf';
const DEFAULT_LABEL_FILE = '_default.label';
const CREDENTIALS_REL = '.credentials.json';
const LEGACY_ACTIVE_FILE = 'active-profile.json';

function noop(): void { /* default logger */ }

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * v2 names are path- and shell-safe: no spaces (they live in a `path|profile`
 * map file and in environment variables).
 */
export function cleanProfileName(input: string): string {
  return input.trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-.]+$/g, '');
}

export function isValidProfileName(name: string): boolean {
  return name.length > 0 && name.length <= 64 &&
    name.toLowerCase() !== DEFAULT_PROFILE &&
    !name.startsWith(RESERVED_PREFIX) &&
    cleanProfileName(name) === name;
}

// ---------------------------------------------------------------------------
// Small fs helpers
// ---------------------------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function ensureDir(dir: string, mode = 0o700): Promise<void> {
  // Never chmod a directory that already exists: staging next to ~/.claude.json
  // must not silently tighten the user's $HOME permissions.
  if (await exists(dir)) { return; }
  await fs.mkdir(dir, { recursive: true, mode });
  try { await fs.chmod(dir, mode); } catch { /* best effort on shared mounts */ }
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch { return undefined; }
}

async function writeJsonAtomic(file: string, value: unknown, mode = 0o600): Promise<void> {
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode });
  await fs.rename(tmp, file);
}

async function copyTree(src: string, dest: string): Promise<void> {
  await ensureDir(path.dirname(dest));
  await fs.cp(src, dest, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupsRoot(paths: Paths): string {
  return path.join(paths.profilesRoot, BACKUPS_DIRNAME);
}

function binRoot(paths: Paths): string {
  return path.join(paths.profilesRoot, BIN_DIRNAME);
}

// ---------------------------------------------------------------------------
// Default-profile label (carried over from the v0.x active profile name)
// ---------------------------------------------------------------------------

export async function getDefaultLabel(paths: Paths): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(paths.profilesRoot, DEFAULT_LABEL_FILE), 'utf8');
    const label = raw.split('\n')[0].trim();
    return label || undefined;
  } catch { return undefined; }
}

export async function setDefaultLabel(paths: Paths, label: string | undefined): Promise<void> {
  const file = path.join(paths.profilesRoot, DEFAULT_LABEL_FILE);
  if (!label) { await fs.rm(file, { force: true }); return; }
  await ensureDir(paths.profilesRoot);
  await fs.writeFile(file, label + '\n', { mode: 0o644 });
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/** Account email from a config dir's .claude.json. Reads no token material. */
async function emailFor(claudeJsonFile: string): Promise<string | undefined> {
  const data = await readJson<{ oauthAccount?: { emailAddress?: string } }>(claudeJsonFile);
  const email = data?.oauthAccount?.emailAddress;
  return typeof email === 'string' && email ? email : undefined;
}

/** Resolve a profile name (or the default label, case-insensitive 'default') to its config dir. */
export async function configDirFor(paths: Paths, name: string): Promise<string> {
  if (await isDefaultName(paths, name)) { return paths.claudeDir; }
  const dir = path.join(paths.profilesRoot, name);
  if (!(await exists(dir))) { throw new Error(`Profile does not exist: '${name}'`); }
  return dir;
}

export async function isDefaultName(paths: Paths, name: string): Promise<boolean> {
  if (name.toLowerCase() === DEFAULT_PROFILE) { return true; }
  const label = await getDefaultLabel(paths);
  return label !== undefined && name === label;
}

export async function listProfiles(paths: Paths): Promise<ProfileInfo[]> {
  const out: ProfileInfo[] = [];
  out.push({
    name: DEFAULT_PROFILE,
    dir: paths.claudeDir,
    isDefault: true,
    label: await getDefaultLabel(paths),
    email: await emailFor(paths.claudeJson),
    loggedIn: await exists(path.join(paths.claudeDir, CREDENTIALS_REL)),
    legacyLayout: false,
    schemaVersion: 2
  });

  if (!(await exists(paths.profilesRoot))) { return out; }
  const entries = await fs.readdir(paths.profilesRoot, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(RESERVED_PREFIX) || e.name.startsWith('.')) { continue; }
    const dir = path.join(paths.profilesRoot, e.name);
    const meta = await readJson<{ name?: string; createdAt?: string; schemaVersion?: number }>(
      path.join(dir, PROFILE_META));
    const legacyLayout = await exists(path.join(dir, '.claude'));
    out.push({
      name: e.name,
      dir,
      isDefault: false,
      email: await emailFor(path.join(dir, '.claude.json')),
      loggedIn: await exists(path.join(dir, legacyLayout ? '.claude' : '.', CREDENTIALS_REL)),
      legacyLayout,
      createdAt: meta?.createdAt,
      schemaVersion: meta?.schemaVersion ?? (legacyLayout ? 1 : 2)
    });
  }
  return [out[0], ...out.slice(1).sort((a, b) => a.name.localeCompare(b.name))];
}

export async function getProfile(paths: Paths, name: string): Promise<ProfileInfo | undefined> {
  const all = await listProfiles(paths);
  if (name.toLowerCase() === DEFAULT_PROFILE) { return all[0]; }
  const label = await getDefaultLabel(paths);
  if (label && name === label) { return all[0]; }
  return all.find(p => p.name === name);
}

export interface CreateOptions {
  /** Copy settings.json and CLAUDE.md from the default account (default true). */
  seedFromDefault?: boolean;
  /**
   * Copy onboarding state and workspace-trust decisions from the default
   * account's .claude.json so the new profile skips first-run dialogs
   * (default true). Never copies tokens — those live in .credentials.json,
   * which is not touched: the new profile starts logged out.
   */
  copyTrust?: boolean;
}

export async function createProfile(paths: Paths, name: string, opts: CreateOptions = {}, log: Logger = noop): Promise<ProfileInfo> {
  if (!isValidProfileName(name)) { throw new Error(`Invalid profile name: '${name}'`); }
  if (await isDefaultName(paths, name)) { throw new Error(`'${name}' is the default account`); }
  const dir = path.join(paths.profilesRoot, name);
  if (await exists(dir)) { throw new Error(`Profile already exists: '${name}'`); }
  await ensureDir(paths.profilesRoot);
  await ensureDir(dir);

  if (opts.seedFromDefault !== false) {
    for (const f of ['settings.json', 'CLAUDE.md']) {
      const src = path.join(paths.claudeDir, f);
      if (await exists(src)) { await fs.copyFile(src, path.join(dir, f)); }
    }
  }

  if (opts.copyTrust !== false) {
    const src = await readJson<Record<string, unknown>>(paths.claudeJson);
    if (src) {
      const seed: Record<string, unknown> = {};
      for (const k of ['hasCompletedOnboarding', 'theme', 'autoUpdaterStatus', 'preferredNotifChannel']) {
        if (src[k] !== undefined) { seed[k] = src[k]; }
      }
      const projects = src.projects as Record<string, { hasTrustDialogAccepted?: boolean }> | undefined;
      if (projects) {
        const trusted: Record<string, { hasTrustDialogAccepted: true }> = {};
        for (const [p, v] of Object.entries(projects)) {
          if (v && v.hasTrustDialogAccepted) { trusted[p] = { hasTrustDialogAccepted: true }; }
        }
        if (Object.keys(trusted).length) { seed.projects = trusted; }
      }
      await writeJsonAtomic(path.join(dir, '.claude.json'), seed);
    }
  }

  await writeJsonAtomic(path.join(dir, PROFILE_META), {
    name, createdAt: new Date().toISOString(), schemaVersion: 2
  });
  log(`created profile '${name}' at ${dir}`);
  const info = await getProfile(paths, name);
  if (!info) { throw new Error(`Failed to create profile '${name}'`); }
  return info;
}

/** Delete a profile directory and any map entries routing to it. */
export async function deleteProfile(paths: Paths, name: string): Promise<void> {
  if (await isDefaultName(paths, name)) { throw new Error('The default account cannot be deleted.'); }
  const dir = path.join(paths.profilesRoot, name);
  if (!(await exists(dir))) { throw new Error(`Profile does not exist: '${name}'`); }
  await fs.rm(dir, { recursive: true, force: true });
  const map = (await listMap(paths)).filter(m => m.profile !== name);
  await writeMap(paths, map);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export async function validateProfile(paths: Paths, name: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const info = await getProfile(paths, name);
  if (!info) { return { ok: false, errors: [`Profile does not exist: '${name}'`], warnings }; }
  if (info.legacyLayout) {
    warnings.push('Profile still uses the v0.x snapshot layout; run migration.');
  }
  const credFile = path.join(info.dir, CREDENTIALS_REL);
  if (!(await exists(credFile))) {
    warnings.push('Not logged in yet — open a login terminal for this profile once.');
    return { ok: true, errors, warnings };
  }
  const creds = await readJson<{ claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown } }>(credFile);
  if (!creds) {
    errors.push('.credentials.json is not valid JSON.');
  } else if (typeof creds.claudeAiOauth?.accessToken !== 'string' || creds.claudeAiOauth.accessToken.length === 0) {
    errors.push('.credentials.json has no usable access token.');
  } else {
    if (typeof creds.claudeAiOauth.refreshToken !== 'string' || creds.claudeAiOauth.refreshToken.length === 0) {
      warnings.push('No refresh token; the session may expire and require re-login.');
    }
    const exp = creds.claudeAiOauth.expiresAt;
    if (typeof exp === 'number' && exp < Date.now()) {
      warnings.push('Access token is expired; Claude should refresh it automatically on next use.');
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Directory -> profile routing (map.conf + .claude-profile files)
// ---------------------------------------------------------------------------

export async function listMap(paths: Paths): Promise<MapEntry[]> {
  const file = path.join(paths.profilesRoot, MAP_FILE);
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return []; }
  const out: MapEntry[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) { continue; }
    const sep = t.indexOf('|');
    if (sep <= 0) { continue; }
    const prefix = t.slice(0, sep).trim().replace(/\/+$/, '');
    const profile = t.slice(sep + 1).trim();
    if (prefix && profile) { out.push({ prefix, profile }); }
  }
  return out;
}

async function writeMap(paths: Paths, entries: MapEntry[]): Promise<void> {
  await ensureDir(paths.profilesRoot);
  const header = [
    '# Claude Code account routing: which profile new sessions use, per folder.',
    '# Format:  /absolute/path/prefix|profile-name     (longest match wins)',
    '# Managed by Account Switcher for Claude Code; hand-edits are preserved',
    '# in format but may be rewritten. CLAUDE_CONFIG_DIR / CLAUDE_PROFILE and a',
    '# .claude-profile file in the folder always take precedence over this map.',
    ''
  ].join('\n');
  const body = entries.map(e => `${e.prefix}|${e.profile}`).join('\n');
  const file = path.join(paths.profilesRoot, MAP_FILE);
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, header + body + (body ? '\n' : ''), { mode: 0o644 });
  await fs.rename(tmp, file);
}

/** Route a folder to a profile. Routing to 'default' removes the entry. */
export async function setMapping(paths: Paths, dirPath: string, profile: string): Promise<void> {
  const prefix = path.resolve(dirPath).replace(/\/+$/, '');
  const entries = (await listMap(paths)).filter(e => e.prefix !== prefix);
  if (!(await isDefaultName(paths, profile))) {
    await configDirFor(paths, profile); // throws for unknown profiles
    entries.push({ prefix, profile });
  }
  await writeMap(paths, entries);
}

export async function removeMapping(paths: Paths, dirPath: string): Promise<void> {
  const prefix = path.resolve(dirPath).replace(/\/+$/, '');
  await writeMap(paths, (await listMap(paths)).filter(e => e.prefix !== prefix));
}

/**
 * Which profile a directory routes to (mirrors _bin/profile-env.sh, minus
 * environment variables, which don't apply to the extension's own UI).
 * Precedence: nearest .claude-profile file, then longest map.conf prefix,
 * then 'default'.
 */
export async function resolveProfileForDir(paths: Paths, dirPath: string, homeDir: string): Promise<string> {
  let d = path.resolve(dirPath);
  for (;;) {
    const marker = path.join(d, '.claude-profile');
    if (await exists(marker)) {
      const name = (await fs.readFile(marker, 'utf8')).split('\n')[0].trim();
      if (name) { return normalizeResolvedName(paths, name); }
    }
    if (d === homeDir || path.dirname(d) === d) { break; }
    d = path.dirname(d);
  }
  const target = path.resolve(dirPath);
  let best: MapEntry | undefined;
  for (const e of await listMap(paths)) {
    if (target === e.prefix || target.startsWith(e.prefix + '/')) {
      if (!best || e.prefix.length > best.prefix.length) { best = e; }
    }
  }
  return best ? normalizeResolvedName(paths, best.profile) : DEFAULT_PROFILE;
}

async function normalizeResolvedName(paths: Paths, name: string): Promise<string> {
  if (await isDefaultName(paths, name)) { return DEFAULT_PROFILE; }
  return (await exists(path.join(paths.profilesRoot, name))) ? name : DEFAULT_PROFILE;
}

// ---------------------------------------------------------------------------
// Helper scripts (single source of truth for the shell routing logic)
// ---------------------------------------------------------------------------

const PROFILE_ENV_TEMPLATE = `# profile-env.sh — Claude Code account routing (generated by
# Account Switcher for Claude Code v__VERSION__; regenerated on activation —
# do not edit by hand).
#
# Sourced by launchers before starting Claude. Decides which account's
# CLAUDE_CONFIG_DIR a NEW process uses. Precedence:
#   1. CLAUDE_CONFIG_DIR already set  -> respected untouched
#   2. CLAUDE_PROFILE=<name>          -> that profile
#   3. nearest .claude-profile file from $PWD up to $HOME
#   4. longest matching prefix in map.conf
#   5. default account (~/.claude)
# Routing never logs anything in or out; it only picks a directory.

claude_profile_apply() {
  [ -n "\${CLAUDE_CONFIG_DIR:-}" ] && return 0
  local root="__PROFILES_ROOT__" name="" label="" d=""
  [ -f "$root/_default.label" ] && IFS= read -r label < "$root/_default.label"

  if [ -n "\${CLAUDE_PROFILE:-}" ]; then
    name="$CLAUDE_PROFILE"
  else
    d="$PWD"
    while :; do
      if [ -f "$d/.claude-profile" ]; then
        IFS= read -r name < "$d/.claude-profile"
        break
      fi
      { [ "$d" = "/" ] || [ "$d" = "$HOME" ]; } && break
      d="\${d%/*}"
      [ -z "$d" ] && d="/"
    done
    if [ -z "$name" ] && [ -f "$root/map.conf" ]; then
      local prefix profile best="" bestlen=-1
      while IFS='|' read -r prefix profile; do
        prefix="\${prefix%\$'\\r'}"; profile="\${profile%\$'\\r'}"
        [ -z "$prefix" ] && continue
        case "$prefix" in \\#*) continue ;; esac
        prefix="\${prefix%/}"
        case "$prefix" in "~"*) prefix="$HOME\${prefix#\\~}" ;; esac
        if [ "$PWD" = "$prefix" ] || [ "\${PWD#"$prefix"/}" != "$PWD" ]; then
          if [ "\${#prefix}" -gt "$bestlen" ]; then
            best="$profile"
            bestlen="\${#prefix}"
          fi
        fi
      done < "$root/map.conf"
      name="$best"
    fi
  fi

  name="\${name%\$'\\r'}"
  [ -z "$name" ] && return 0
  case "$name" in [Dd]efault) return 0 ;; esac
  [ -n "$label" ] && [ "$name" = "$label" ] && return 0
  if [ -d "$root/$name" ]; then
    export CLAUDE_CONFIG_DIR="$root/$name"
  else
    echo "claude-profiles: unknown profile '$name'; using default account" >&2
  fi
  return 0
}
`;

const WRAPPER_TEMPLATE = `#!/usr/bin/env bash
# claude-wrapper.sh — process wrapper for the official Claude Code extension
# (generated by Account Switcher for Claude Code v__VERSION__; configured via
# the claudeCode.claudeProcessWrapper setting — do not edit by hand).
#
# The official extension invokes:  claude-wrapper.sh <real-claude-binary> [args...]
# This applies the per-folder account routing and then execs the real binary
# untouched. With no routing configured, behavior is identical to having no
# wrapper. It never logs anything in or out, so running sessions on other
# accounts are never affected.
set -uo pipefail

if [ -f "__PROFILES_ROOT__/_bin/profile-env.sh" ]; then
  . "__PROFILES_ROOT__/_bin/profile-env.sh"
  claude_profile_apply
fi

# Breadcrumb for debugging routing (paths and profile names only, no secrets).
{
  log="__PROFILES_ROOT__/_bin/resolve.log"
  printf '%s pwd=%s config=%s\\n' "$(date -Is 2>/dev/null || echo -)" "$PWD" "\${CLAUDE_CONFIG_DIR:-default}" >> "$log" 2>/dev/null || true
  if [ -f "$log" ] && [ "$(wc -l < "$log" 2>/dev/null || echo 0)" -gt 500 ]; then
    tail -n 250 "$log" > "$log.tmp" 2>/dev/null && mv "$log.tmp" "$log" 2>/dev/null || true
  fi
} 2>/dev/null || true

if [ "$#" -gt 0 ] && [ -x "$1" ]; then
  exec "$@"
fi

# The extension always passes the real binary as $1; reaching this point means
# an unexpected invocation. Fail loudly rather than guessing at a binary.
echo "claude-wrapper: expected the Claude binary as first argument, got: \${1:-<none>}" >&2
exit 127
`;

export interface HelperScripts {
  profileEnv: string;
  wrapper: string;
}

// Characters that would break out of the double-quoted shell strings the
// profiles root is embedded into below (e.g. `local root="__PROFILES_ROOT__"`).
// A profilesRoot containing one of these could inject arbitrary shell
// commands into the generated, later-sourced/exec'd scripts.
const SHELL_UNSAFE_PATH_CHARS = /["'`$\\\n\r]/;

function assertShellSafePath(p: string, settingName: string): void {
  if (SHELL_UNSAFE_PATH_CHARS.test(p)) {
    throw new Error(
      `claudeProfileSwitcher.${settingName} contains characters ("'` + '`$\\' +
      `' or a newline) that are not safe to embed in a shell script: '${p}'`);
  }
}

export function renderHelperScripts(paths: Paths, version: string): HelperScripts {
  const root = path.resolve(paths.profilesRoot);
  assertShellSafePath(root, 'profilesRoot');
  const fill = (t: string) => t.split('__PROFILES_ROOT__').join(root).split('__VERSION__').join(version);
  return { profileEnv: fill(PROFILE_ENV_TEMPLATE), wrapper: fill(WRAPPER_TEMPLATE) };
}

/** Write _bin/profile-env.sh and _bin/claude-wrapper.sh (idempotent). Returns the wrapper path. */
export async function materializeHelperScripts(paths: Paths, version: string, log: Logger = noop): Promise<string> {
  const scripts = renderHelperScripts(paths, version);
  const bin = binRoot(paths);
  await ensureDir(paths.profilesRoot);
  await ensureDir(bin, 0o755);
  const targets: Array<{ file: string; content: string; mode: number }> = [
    { file: path.join(bin, 'profile-env.sh'), content: scripts.profileEnv, mode: 0o644 },
    { file: path.join(bin, 'claude-wrapper.sh'), content: scripts.wrapper, mode: 0o755 }
  ];
  for (const t of targets) {
    const current = await fs.readFile(t.file, 'utf8').catch(() => undefined);
    if (current !== t.content) {
      const tmp = `${t.file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
      await fs.writeFile(tmp, t.content, { mode: t.mode });
      await fs.rename(tmp, t.file);
      log(`wrote ${t.file}`);
    }
    await fs.chmod(t.file, t.mode).catch(() => undefined);
  }
  return path.join(bin, 'claude-wrapper.sh');
}

// ---------------------------------------------------------------------------
// Migration from the v0.x snapshot layout
// ---------------------------------------------------------------------------

/**
 * Convert v0.x snapshot profiles (<dir>/.claude + <dir>/.claude.json) into
 * live config dirs (contents of .claude/ flattened into <dir>).
 *
 * The profile recorded as active in v0.x is special: its snapshot is stale by
 * design (the live ~/.claude is its real, current state — verified against the
 * account email before trusting the marker). Its ENTIRE snapshot dir is
 * archived into _backups via a same-filesystem rename (nothing is deleted),
 * and its NAME becomes the label of the default profile.
 */
export async function migrateToV2(paths: Paths, log: Logger = noop): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: [], renamed: [], warnings: [] };
  if (!(await exists(paths.profilesRoot))) { return report; }

  const activeName = (await readJson<{ activeProfile?: string }>(
    path.join(paths.profilesRoot, LEGACY_ACTIVE_FILE)))?.activeProfile ?? undefined;

  const entries = await fs.readdir(paths.profilesRoot, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(RESERVED_PREFIX) || e.name.startsWith('.')) { continue; }
    let name = e.name;
    let dir = path.join(paths.profilesRoot, name);
    if (!(await exists(path.join(dir, '.claude')))) { continue; } // already v2 (or empty)

    // Back up login files before touching anything.
    const backupDir = path.join(backupsRoot(paths), `${timestamp()}-migrate-${name}`);
    await ensureDir(backupsRoot(paths));
    await ensureDir(backupDir);
    for (const [src, destName] of [
      [path.join(dir, '.claude', CREDENTIALS_REL), CREDENTIALS_REL],
      [path.join(dir, '.claude.json'), '.claude.json'],
      [path.join(dir, PROFILE_META), PROFILE_META]
    ] as Array<[string, string]>) {
      if (await exists(src)) { await fs.copyFile(src, path.join(backupDir, destName)); }
    }
    await writeJsonAtomic(path.join(backupDir, BACKUP_META), {
      dir: backupDir, reason: `migrate-${name}`, createdAt: new Date().toISOString()
    });

    if (activeName && name === activeName && await liveMatchesSnapshot(paths, dir)) {
      // Live ~/.claude is this profile's real, current state; the snapshot is
      // stale. Archive the WHOLE snapshot (same-fs rename — instant, nothing
      // deleted) in case it still holds sessions the live dir has cleaned up.
      await fs.rename(dir, path.join(backupDir, 'snapshot'));
      await setDefaultLabel(paths, name);
      report.becameDefault = name;
      log(`migration: '${name}' was the active profile — the default account (~/.claude) now carries that label; its full stale snapshot was archived to ${backupDir}/snapshot`);
      continue;
    }
    if (activeName && name === activeName) {
      report.warnings.push(`'${name}' was marked active but the live account does not match its snapshot; migrated it as a normal profile instead.`);
    }

    // v2 names have no spaces and must not collide with 'default', the default
    // label, or an existing profile (the active profile's dir was renamed away
    // above, so a bare exists() check is not enough on its own).
    const finalName = await uniqueMigratedName(paths, name);
    if (finalName !== name) {
      const newDir = path.join(paths.profilesRoot, finalName);
      await fs.rename(dir, newDir);
      report.renamed.push({ from: name, to: finalName });
      name = finalName;
      dir = newDir;
    }

    // Flatten <dir>/.claude/* into <dir>/ (renames on the same filesystem).
    const snap = path.join(dir, '.claude');
    for (const item of await fs.readdir(snap)) {
      const from = path.join(snap, item);
      const to = path.join(dir, item);
      if (await exists(to)) {
        report.warnings.push(`'${name}': kept existing ${item}, legacy copy left at .claude/${item}`);
        continue;
      }
      await fs.rename(from, to);
    }
    if ((await fs.readdir(snap)).length === 0) {
      await fs.rmdir(snap);
    }

    const meta = (await readJson<Record<string, unknown>>(path.join(dir, PROFILE_META))) ?? { name };
    meta.name = name;
    meta.schemaVersion = 2;
    meta.migratedAt = new Date().toISOString();
    await writeJsonAtomic(path.join(dir, PROFILE_META), meta);
    await enforceProfilePermissions(dir);
    report.migrated.push(name);
    log(`migration: '${name}' converted to a live profile at ${dir}`);
  }

  await fs.rm(path.join(paths.profilesRoot, LEGACY_ACTIVE_FILE), { force: true });
  return report;
}

/**
 * True when the live default account plausibly IS the given snapshot's
 * account: emails compared when both sides have one; with either side
 * missing, the v0.x active-profile marker is trusted as before.
 */
async function liveMatchesSnapshot(paths: Paths, snapshotDir: string): Promise<boolean> {
  const liveEmail = await emailFor(paths.claudeJson);
  const snapEmail = await emailFor(path.join(snapshotDir, '.claude.json'));
  if (!liveEmail || !snapEmail) { return true; }
  return liveEmail === snapEmail;
}

/**
 * A migration-safe name: valid under v2 rules, not the default account's name
 * or label, and not an existing directory. Falls back to numbered suffixes.
 */
async function uniqueMigratedName(paths: Paths, original: string): Promise<string> {
  const taken = async (n: string) =>
    !isValidProfileName(n) || (await isDefaultName(paths, n)) ||
    (n !== original && await exists(path.join(paths.profilesRoot, n)));
  if (!(await taken(original))) { return original; }
  const base = cleanProfileName(original) || 'profile';
  if (base !== original && !(await taken(base))) { return base; }
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!(await taken(candidate))) { return candidate; }
  }
}

export async function enforceProfilePermissions(dir: string): Promise<void> {
  const tighten = async (p: string, mode: number) => {
    if (await exists(p)) { await fs.chmod(p, mode).catch(() => undefined); }
  };
  await tighten(dir, 0o700);
  await tighten(path.join(dir, CREDENTIALS_REL), 0o600);
  await tighten(path.join(dir, '.claude.json'), 0o600);
}

// ---------------------------------------------------------------------------
// Login backups (small, credentials + account state only)
// ---------------------------------------------------------------------------

/**
 * Snapshot every profile's login files (.credentials.json + .claude.json)
 * into _backups/<ts>-logins/. Small and safe to run any time; lets a user
 * recover from an accidental profile deletion without re-authenticating.
 */
export async function backupLogins(paths: Paths, log: Logger = noop): Promise<BackupInfo> {
  const dir = path.join(backupsRoot(paths), `${timestamp()}-logins`);
  await ensureDir(backupsRoot(paths));
  await ensureDir(dir);
  const copyLogin = async (label: string, credCandidates: string[], claudeJson: string) => {
    const dest = path.join(dir, label);
    let copied = false;
    const sources: Array<[string, string]> = [[claudeJson, '.claude.json']];
    for (const c of credCandidates) {
      if (await exists(c)) { sources.push([c, CREDENTIALS_REL]); break; }
    }
    for (const [src, destName] of sources) {
      if (await exists(src)) {
        await ensureDir(dest);
        await fs.copyFile(src, path.join(dest, destName));
        await fs.chmod(path.join(dest, destName), 0o600).catch(() => undefined);
        copied = true;
      }
    }
    return copied;
  };
  await copyLogin(DEFAULT_PROFILE, [path.join(paths.claudeDir, CREDENTIALS_REL)], paths.claudeJson);
  for (const p of await listProfiles(paths)) {
    if (p.isDefault) { continue; }
    // Cover both layouts: v2 (top-level) and any legacy/half-migrated remnant
    // (credentials still under .claude/) — a profile must never be skipped.
    await copyLogin(p.name, [
      path.join(p.dir, CREDENTIALS_REL),
      path.join(p.dir, '.claude', CREDENTIALS_REL)
    ], path.join(p.dir, '.claude.json'));
  }
  const info: BackupInfo = { dir, reason: 'logins', createdAt: new Date().toISOString() };
  await writeJsonAtomic(path.join(dir, BACKUP_META), info);
  log(`login snapshot written to ${dir}`);
  return info;
}

/**
 * Detect `.old-*` / `.staging-*` artifacts next to the live default paths —
 * leftovers of a v0.x swap (or legacy-backup restore) killed mid-rename. They
 * may contain the only copy of an account's state, so they are surfaced to
 * the user rather than auto-deleted.
 */
export async function findSwapOrphans(paths: Paths): Promise<string[]> {
  const orphans: string[] = [];
  for (const live of [paths.claudeDir, paths.claudeJson]) {
    const parent = path.dirname(live);
    const base = path.basename(live);
    let names: string[];
    try { names = await fs.readdir(parent); } catch { continue; }
    for (const n of names) {
      if (n.startsWith(`${base}.old-`) || n.startsWith(`${base}.staging-`)) {
        orphans.push(path.join(parent, n));
      }
    }
  }
  return [...new Set(orphans)].sort();
}

export async function listBackups(paths: Paths): Promise<BackupInfo[]> {
  const root = backupsRoot(paths);
  if (!(await exists(root))) { return []; }
  const entries = await fs.readdir(root, { withFileTypes: true });
  const out: BackupInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) { continue; }
    const dir = path.join(root, e.name);
    const meta = await readJson<BackupInfo>(path.join(dir, BACKUP_META));
    out.push(meta ? { ...meta, dir } : { dir, reason: e.name, createdAt: new Date(0).toISOString() });
  }
  // Dir names start with an ISO timestamp, so lexical order == chronological.
  return out.sort((a, b) => path.basename(a.dir).localeCompare(path.basename(b.dir)));
}

export async function pruneBackups(paths: Paths, maxBackups: number, log: Logger = noop): Promise<void> {
  if (maxBackups <= 0) { return; }
  const backups = await listBackups(paths);
  const excess = backups.length - maxBackups;
  for (let i = 0; i < excess; i++) {
    await fs.rm(backups[i].dir, { recursive: true, force: true });
    log(`pruned old backup: ${path.basename(backups[i].dir)}`);
  }
}

// ---------------------------------------------------------------------------
// Legacy recovery: restore a v0.x full backup into the live default account
// ---------------------------------------------------------------------------

/**
 * Replace the live default state with the contents of a backup directory
 * (which holds optional `.claude/` and `.claude.json`). Retained from v0.x
 * solely for disaster recovery of old backups; normal v2 operation never
 * replaces live state.
 */
export async function replaceLiveState(paths: Paths, sourceDir: string, log: Logger = noop): Promise<void> {
  const rand = crypto.randomBytes(4).toString('hex');
  const pieces = [
    { src: path.join(sourceDir, '.claude'), live: paths.claudeDir },
    { src: path.join(sourceDir, '.claude.json'), live: paths.claudeJson }
  ];

  type Staged = { live: string; staged?: string; old?: string; renamedIn?: boolean };
  const staged: Staged[] = [];

  try {
    for (const p of pieces) {
      const s: Staged = { live: p.live };
      staged.push(s);
      if (await exists(p.src)) {
        s.staged = `${p.live}.staging-${rand}`;
        await copyTree(p.src, s.staged);
      }
    }
    for (const s of staged) {
      if (await exists(s.live)) {
        s.old = `${s.live}.old-${rand}`;
        await fs.rename(s.live, s.old);
      }
      if (s.staged) {
        await fs.rename(s.staged, s.live);
        s.staged = undefined;
        s.renamedIn = true;
      }
    }
  } catch (err) {
    for (const s of staged.reverse()) {
      try {
        if (s.renamedIn || s.old) {
          await fs.rm(s.live, { recursive: true, force: true });
          if (s.old && await exists(s.old)) { await fs.rename(s.old, s.live); }
        }
        if (s.staged) { await fs.rm(s.staged, { recursive: true, force: true }); }
      } catch {
        log(`rollback issue on ${s.live}; manual recovery may be needed (see backups folder)`);
      }
    }
    throw err;
  }

  for (const s of staged) {
    if (s.old) { await fs.rm(s.old, { recursive: true, force: true }); }
  }
  await enforceProfilePermissions(paths.claudeDir);
  await fs.chmod(paths.claudeJson, 0o600).catch(() => undefined);
  log(`restored live default state from ${sourceDir}`);
}

export async function restoreBackup(paths: Paths, backup: BackupInfo, log: Logger = noop): Promise<void> {
  // Only full v0.x backups (with a .claude/ dir) are restorable. Restoring a
  // partial backup (e.g. a migrate-* or logins snapshot, which has only a
  // top-level .claude.json) would make replaceLiveState DELETE the live
  // ~/.claude to mirror the "missing" piece — never allow that.
  if (!(await exists(path.join(backup.dir, '.claude')))) {
    throw new Error(`Not a full v0.x backup (no .claude dir inside): ${backup.dir}`);
  }
  const safety = path.join(backupsRoot(paths), `${timestamp()}-pre-restore`);
  await ensureDir(safety);
  if (await exists(paths.claudeDir)) { await copyTree(paths.claudeDir, path.join(safety, '.claude')); }
  if (await exists(paths.claudeJson)) { await copyTree(paths.claudeJson, path.join(safety, '.claude.json')); }
  await writeJsonAtomic(path.join(safety, BACKUP_META), {
    dir: safety, reason: 'pre-restore', createdAt: new Date().toISOString()
  });
  await replaceLiveState(paths, backup.dir, log);
}
