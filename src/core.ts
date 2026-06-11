/**
 * Core profile-switching logic for the official Claude Code VS Code extension state.
 *
 * This module has NO dependency on the 'vscode' API so it can be unit-tested
 * directly with node. All paths are injected via the Paths object.
 *
 * Safety rules enforced here:
 *  - Never log or return token/credential values; validation reports shape only.
 *  - Every live-state mutation is preceded by a timestamped backup.
 *  - Live-state replacement uses staged copies + rename (atomic on same fs),
 *    with automatic rollback if any step fails.
 *  - File permissions are enforced after every restore (700 on .claude,
 *    600 on .claude.json and .credentials.json).
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

export interface Paths {
  /** Live Claude config dir, normally ~/.claude */
  claudeDir: string;
  /** Live Claude root JSON, normally ~/.claude.json */
  claudeJson: string;
  /** Root folder holding all saved profiles, normally ~/.claude-profiles */
  profilesRoot: string;
}

export interface ProfileMeta {
  name: string;
  createdAt: string;
  lastSavedAt?: string;
  schemaVersion: 1;
}

export interface ProfileInfo extends ProfileMeta {
  dir: string;
  hasClaudeDir: boolean;
  hasClaudeJson: boolean;
  hasCredentials: boolean;
}

export interface BackupInfo {
  dir: string;
  reason: string;
  createdAt: string;
  activeProfile?: string;
}

export interface ValidationResult {
  ok: boolean;
  /** Human-readable issues. Never contains credential values. */
  errors: string[];
  warnings: string[];
}

export type Logger = (message: string) => void;

const BACKUPS_DIRNAME = '_backups';
const ACTIVE_FILE = 'active-profile.json';
const PROFILE_META = 'profile.json';
const BACKUP_META = 'backup.json';
const CREDENTIALS_REL = '.credentials.json';

export const RESERVED_PREFIX = '_';

function noop(): void { /* default logger */ }

export function cleanProfileName(input: string): string {
  return input.trim()
    .replace(/[^a-zA-Z0-9._ -]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^[-. ]+|[-. ]+$/g, '');
}

export function isValidProfileName(name: string): boolean {
  return name.length > 0 && name.length <= 64 &&
    !name.startsWith(RESERVED_PREFIX) &&
    cleanProfileName(name) === name;
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function ensureDir(dir: string, mode = 0o700): Promise<void> {
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

/** Copy src to a fresh destination (dest must not exist). Preserves modes/timestamps. */
async function copyTree(src: string, dest: string): Promise<void> {
  await ensureDir(path.dirname(dest));
  await fs.cp(src, dest, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function profileDir(paths: Paths, name: string): string {
  return path.join(paths.profilesRoot, name);
}

function backupsRoot(paths: Paths): string {
  return path.join(paths.profilesRoot, BACKUPS_DIRNAME);
}

/**
 * Enforce restrictive permissions on live (or staged) Claude state.
 * Never fails the operation: permission tightening is best-effort but reported.
 */
export async function enforcePermissions(claudeDir: string, claudeJson: string, log: Logger = noop): Promise<void> {
  const tighten = async (p: string, mode: number) => {
    if (!(await exists(p))) { return; }
    try { await fs.chmod(p, mode); }
    catch { log(`warning: could not set mode ${mode.toString(8)} on ${p}`); }
  };
  await tighten(claudeDir, 0o700);
  await tighten(claudeJson, 0o600);
  await tighten(path.join(claudeDir, CREDENTIALS_REL), 0o600);
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export async function getActiveProfileName(paths: Paths): Promise<string | undefined> {
  const data = await readJson<{ activeProfile?: string }>(path.join(paths.profilesRoot, ACTIVE_FILE));
  return data?.activeProfile || undefined;
}

export async function setActiveProfileName(paths: Paths, name: string | undefined): Promise<void> {
  await ensureDir(paths.profilesRoot);
  await writeJsonAtomic(path.join(paths.profilesRoot, ACTIVE_FILE), {
    activeProfile: name ?? null,
    updatedAt: new Date().toISOString()
  });
}

export async function listProfiles(paths: Paths): Promise<ProfileInfo[]> {
  if (!(await exists(paths.profilesRoot))) { return []; }
  const entries = await fs.readdir(paths.profilesRoot, { withFileTypes: true });
  const out: ProfileInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(RESERVED_PREFIX) || e.name.startsWith('.')) { continue; }
    const dir = path.join(paths.profilesRoot, e.name);
    const meta = await readJson<ProfileMeta>(path.join(dir, PROFILE_META));
    out.push({
      name: meta?.name ?? e.name,
      createdAt: meta?.createdAt ?? new Date(0).toISOString(),
      lastSavedAt: meta?.lastSavedAt,
      schemaVersion: 1,
      dir,
      hasClaudeDir: await exists(path.join(dir, '.claude')),
      hasClaudeJson: await exists(path.join(dir, '.claude.json')),
      hasCredentials: await exists(path.join(dir, '.claude', CREDENTIALS_REL))
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getProfile(paths: Paths, name: string): Promise<ProfileInfo | undefined> {
  return (await listProfiles(paths)).find(p => p.name === name);
}

export async function createEmptyProfile(paths: Paths, name: string): Promise<ProfileInfo> {
  if (!isValidProfileName(name)) { throw new Error(`Invalid profile name: '${name}'`); }
  const dir = profileDir(paths, name);
  if (await exists(dir)) { throw new Error(`Profile already exists: '${name}'`); }
  await ensureDir(paths.profilesRoot);
  await ensureDir(dir);
  const meta: ProfileMeta = { name, createdAt: new Date().toISOString(), schemaVersion: 1 };
  await writeJsonAtomic(path.join(dir, PROFILE_META), meta);
  const info = await getProfile(paths, name);
  if (!info) { throw new Error(`Failed to create profile '${name}'`); }
  return info;
}

/**
 * Copy the live Claude state into the given profile.
 * The profile's previous snapshot is replaced atomically: the new copy is staged
 * inside the profile dir, then swapped in via rename, so a crash mid-copy never
 * corrupts the existing snapshot.
 */
export async function saveLiveToProfile(paths: Paths, name: string, log: Logger = noop): Promise<void> {
  const dir = profileDir(paths, name);
  if (!(await exists(dir))) { throw new Error(`Profile does not exist: '${name}'`); }

  const targets: Array<{ live: string; snap: string }> = [
    { live: paths.claudeDir, snap: path.join(dir, '.claude') },
    { live: paths.claudeJson, snap: path.join(dir, '.claude.json') }
  ];

  for (const t of targets) {
    if (!(await exists(t.live))) {
      // Live piece missing (e.g. logged out): remove stale snapshot piece too,
      // so the profile faithfully mirrors the live state.
      await fs.rm(t.snap, { recursive: true, force: true });
      continue;
    }
    const suffix = `-staging-${crypto.randomBytes(4).toString('hex')}`;
    const staged = t.snap + suffix;
    const old = t.snap + suffix + '-old';
    await copyTree(t.live, staged);
    if (await exists(t.snap)) { await fs.rename(t.snap, old); }
    try {
      await fs.rename(staged, t.snap);
    } catch (err) {
      if (await exists(old)) { await fs.rename(old, t.snap); }
      await fs.rm(staged, { recursive: true, force: true });
      throw err;
    }
    await fs.rm(old, { recursive: true, force: true });
  }

  const metaFile = path.join(dir, PROFILE_META);
  const meta = (await readJson<ProfileMeta>(metaFile)) ??
    { name, createdAt: new Date().toISOString(), schemaVersion: 1 as const };
  meta.lastSavedAt = new Date().toISOString();
  await writeJsonAtomic(metaFile, meta);
  log(`saved live state into profile '${name}'`);
}

export async function deleteProfile(paths: Paths, name: string): Promise<void> {
  const dir = profileDir(paths, name);
  if (!(await exists(dir))) { throw new Error(`Profile does not exist: '${name}'`); }
  await fs.rm(dir, { recursive: true, force: true });
  if ((await getActiveProfileName(paths)) === name) {
    await setActiveProfileName(paths, undefined);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a profile before switching to it. Reports structural problems only:
 * no credential values are read into the result, only their presence/shape.
 */
export async function validateProfile(paths: Paths, name: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dir = profileDir(paths, name);

  if (!(await exists(dir))) {
    return { ok: false, errors: [`Profile folder missing: ${dir}`], warnings };
  }

  const hasDir = await exists(path.join(dir, '.claude'));
  const hasJson = await exists(path.join(dir, '.claude.json'));
  if (!hasDir && !hasJson) {
    warnings.push('Profile is empty (no saved Claude state). After switching you will need to log in.');
    return { ok: true, errors, warnings };
  }

  if (hasJson) {
    const parsed = await readJson<unknown>(path.join(dir, '.claude.json'));
    if (parsed === undefined) { errors.push('.claude.json in profile is not valid JSON.'); }
  }

  const credFile = path.join(dir, '.claude', CREDENTIALS_REL);
  if (await exists(credFile)) {
    const creds = await readJson<{ claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown } }>(credFile);
    if (!creds) {
      errors.push('.credentials.json in profile is not valid JSON.');
    } else if (typeof creds.claudeAiOauth?.accessToken !== 'string' || creds.claudeAiOauth.accessToken.length === 0) {
      errors.push('.credentials.json has no usable access token.');
    } else {
      if (typeof creds.claudeAiOauth.refreshToken !== 'string' || creds.claudeAiOauth.refreshToken.length === 0) {
        warnings.push('Profile has no refresh token; the session may expire and require re-login.');
      }
      const exp = creds.claudeAiOauth.expiresAt;
      if (typeof exp === 'number' && exp < Date.now()) {
        warnings.push('Saved access token is expired; Claude should refresh it automatically on next use.');
      }
    }
  } else if (hasDir) {
    warnings.push('Profile has no .credentials.json; you may be asked to log in after switching.');
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export async function backupLive(paths: Paths, reason: string, opts?: { maxBackups?: number; log?: Logger }): Promise<BackupInfo> {
  const log = opts?.log ?? noop;
  const safeReason = reason.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60);
  const dir = path.join(backupsRoot(paths), `${timestamp()}-${safeReason}`);
  await ensureDir(backupsRoot(paths));
  await ensureDir(dir);
  if (await exists(paths.claudeDir)) { await copyTree(paths.claudeDir, path.join(dir, '.claude')); }
  if (await exists(paths.claudeJson)) { await copyTree(paths.claudeJson, path.join(dir, '.claude.json')); }
  const info: BackupInfo = {
    dir,
    reason: safeReason,
    createdAt: new Date().toISOString(),
    activeProfile: await getActiveProfileName(paths)
  };
  await writeJsonAtomic(path.join(dir, BACKUP_META), info);
  log(`backup created: ${dir}`);
  await pruneBackups(paths, opts?.maxBackups ?? 25, log);
  return info;
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

async function pruneBackups(paths: Paths, maxBackups: number, log: Logger): Promise<void> {
  if (maxBackups <= 0) { return; }
  const backups = await listBackups(paths);
  const excess = backups.length - maxBackups;
  for (let i = 0; i < excess; i++) {
    await fs.rm(backups[i].dir, { recursive: true, force: true });
    log(`pruned old backup: ${path.basename(backups[i].dir)}`);
  }
}

// ---------------------------------------------------------------------------
// Atomic live-state replacement
// ---------------------------------------------------------------------------

/**
 * Replace the live Claude state with the contents of `sourceDir`
 * (which holds optional `.claude/` and `.claude.json`).
 *
 * Strategy: stage copies next to the live paths, then swap via rename
 * (atomic on the same filesystem). If anything fails mid-swap, every
 * completed rename is undone before the error propagates.
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
    // Phase 1: stage copies (no live mutation yet; failures here only need
    // staged copies cleaned up, which the rollback below also handles).
    for (const p of pieces) {
      const s: Staged = { live: p.live };
      staged.push(s);
      if (await exists(p.src)) {
        s.staged = `${p.live}.staging-${rand}`;
        await copyTree(p.src, s.staged);
      }
    }

    // Phase 2: swap via renames, recording undo info as we go.
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
    // Rollback: restore any piece whose live path we already touched.
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

  // Phase 3: success — drop the displaced old state and enforce permissions.
  for (const s of staged) {
    if (s.old) { await fs.rm(s.old, { recursive: true, force: true }); }
  }
  await enforcePermissions(paths.claudeDir, paths.claudeJson, log);
}

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

export interface SwitchResult {
  backup: BackupInfo;
  warnings: string[];
}

/**
 * Full switch flow:
 *  1. validate target profile
 *  2. save live state into the currently-active profile (if known)
 *  3. timestamped backup of live state
 *  4. atomically replace live state with the target profile's snapshot
 *  5. record new active profile
 * On any failure after step 3 the swap rolls itself back and the previous
 * active profile name is preserved.
 */
export async function switchToProfile(paths: Paths, targetName: string, opts?: { maxBackups?: number; log?: Logger }): Promise<SwitchResult> {
  const log = opts?.log ?? noop;
  const target = await getProfile(paths, targetName);
  if (!target) { throw new Error(`Profile does not exist: '${targetName}'`); }

  const validation = await validateProfile(paths, targetName);
  if (!validation.ok) {
    throw new Error(`Profile '${targetName}' failed validation: ${validation.errors.join(' ')}`);
  }

  const activeName = await getActiveProfileName(paths);
  if (activeName && activeName !== targetName && await getProfile(paths, activeName)) {
    await saveLiveToProfile(paths, activeName, log);
  }

  const backup = await backupLive(paths, `switch-to-${targetName}`, { maxBackups: opts?.maxBackups, log });

  try {
    await replaceLiveState(paths, target.dir, log);
  } catch (err) {
    log(`switch to '${targetName}' failed and was rolled back`);
    throw err;
  }

  await setActiveProfileName(paths, targetName);
  log(`switched active Claude profile to '${targetName}'`);
  return { backup, warnings: validation.warnings };
}

/**
 * Restore the most recent backup (or a specific one). Takes a fresh safety
 * backup of the current live state first, so a restore is itself reversible.
 */
export async function restoreBackup(paths: Paths, backup?: BackupInfo, opts?: { maxBackups?: number; log?: Logger }): Promise<BackupInfo> {
  const log = opts?.log ?? noop;
  const all = await listBackups(paths);
  const chosen = backup ?? all.filter(b => !b.reason.startsWith('pre-restore')).pop() ?? all.pop();
  if (!chosen) { throw new Error('No backups found.'); }

  await backupLive(paths, 'pre-restore', { maxBackups: opts?.maxBackups, log });
  await replaceLiveState(paths, chosen.dir, log);
  await setActiveProfileName(paths, chosen.activeProfile);
  log(`restored backup ${path.basename(chosen.dir)}`);
  return chosen;
}

/**
 * Import the current live state as a brand-new named profile and mark it active.
 */
export async function importLiveAsProfile(paths: Paths, name: string, log: Logger = noop): Promise<ProfileInfo> {
  if (!(await exists(paths.claudeDir)) && !(await exists(paths.claudeJson))) {
    throw new Error(`No live Claude state found at ${paths.claudeDir} or ${paths.claudeJson}.`);
  }
  await createEmptyProfile(paths, name);
  await saveLiveToProfile(paths, name, log);
  await setActiveProfileName(paths, name);
  const info = await getProfile(paths, name);
  if (!info) { throw new Error(`Import failed for '${name}'`); }
  return info;
}
