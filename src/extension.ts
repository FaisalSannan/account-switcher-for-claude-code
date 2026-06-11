import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as core from './core';

const LEGACY_PROFILES_KEY = 'claudeProfileSwitcher.profiles';
const LEGACY_ACTIVE_KEY = 'claudeProfileSwitcher.activeProfile';
const MIGRATED_KEY = 'claudeProfileSwitcher.migratedToDiskV1';

let ctx: vscode.ExtensionContext;
let statusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  ctx = context;
  output = vscode.window.createOutputChannel('Claude Profile Switcher');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  statusBar.command = 'claudeProfileSwitcher.switchProfile';
  statusBar.tooltip = 'Switch official Claude Code account profile';
  context.subscriptions.push(statusBar, output);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProfileSwitcher.importCurrent', guard(importCurrent)),
    vscode.commands.registerCommand('claudeProfileSwitcher.createEmpty', guard(createEmpty)),
    vscode.commands.registerCommand('claudeProfileSwitcher.switchProfile', guard(switchProfile)),
    vscode.commands.registerCommand('claudeProfileSwitcher.syncActive', guard(syncActive)),
    vscode.commands.registerCommand('claudeProfileSwitcher.backupNow', guard(backupNow)),
    vscode.commands.registerCommand('claudeProfileSwitcher.restoreLastBackup', guard(restoreLastBackup)),
    vscode.commands.registerCommand('claudeProfileSwitcher.showStatus', guard(showStatus)),
    vscode.commands.registerCommand('claudeProfileSwitcher.openProfilesFolder', guard(openProfilesFolder)),
    vscode.commands.registerCommand('claudeProfileSwitcher.deleteProfile', guard(deleteProfile))
  );

  void (async () => {
    await migrateLegacyProfiles();
    await updateStatusBar();
  })();
}

export function deactivate() { /* nothing to clean up */ }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function guard(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`error: ${msg}`);
      vscode.window.showErrorMessage(`Claude Profile Switcher: ${msg}`);
    } finally {
      await updateStatusBar();
    }
  };
}

function log(message: string) {
  output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function cfg() { return vscode.workspace.getConfiguration('claudeProfileSwitcher'); }

function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function paths(): core.Paths {
  return {
    claudeDir: expandHome(cfg().get<string>('activeClaudeDir')?.trim() || path.join(os.homedir(), '.claude')),
    claudeJson: expandHome(cfg().get<string>('activeClaudeJson')?.trim() || path.join(os.homedir(), '.claude.json')),
    profilesRoot: expandHome(cfg().get<string>('profilesRoot')?.trim() || path.join(os.homedir(), '.claude-profiles'))
  };
}

function maxBackups(): number {
  return cfg().get<number>('maxBackups') ?? 25;
}

async function updateStatusBar() {
  try {
    const active = await core.getActiveProfileName(paths());
    statusBar.text = active ? `$(account) Claude: ${active}` : '$(account) Claude: no profile';
  } catch {
    statusBar.text = '$(account) Claude: no profile';
  }
  statusBar.show();
}

async function promptProfileName(title: string, prompt: string, value?: string): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    title, prompt, value,
    validateInput: v => {
      const cleaned = core.cleanProfileName(v);
      if (!cleaned) { return 'Enter a profile name (letters, digits, dot, dash, underscore, space).'; }
      if (!core.isValidProfileName(cleaned)) { return 'Name must not start with "_" or "." and must be at most 64 chars.'; }
      return undefined;
    }
  });
  return input ? core.cleanProfileName(input) : undefined;
}

async function pickProfile(title: string, opts?: { excludeActive?: boolean }): Promise<core.ProfileInfo | undefined> {
  const p = paths();
  const profiles = await core.listProfiles(p);
  if (!profiles.length) {
    const pick = await vscode.window.showInformationMessage(
      'No profiles yet. Import your current Claude account first.', 'Import Current Account');
    if (pick) { await importCurrent(); }
    return undefined;
  }
  const active = await core.getActiveProfileName(p);
  const items = profiles
    .filter(pr => !(opts?.excludeActive && pr.name === active))
    .map(pr => ({
      label: pr.name,
      description: pr.name === active ? '● active now'
        : pr.lastSavedAt ? `saved ${pr.lastSavedAt}`
        : 'empty / not yet logged in',
      detail: pr.hasCredentials ? undefined : 'No saved credentials — login required after switching.',
      profile: pr
    }));
  const selected = await vscode.window.showQuickPick(items, { title });
  return selected?.profile;
}

function showWarnings(warnings: string[]) {
  for (const w of warnings) { vscode.window.showWarningMessage(`Claude Profile Switcher: ${w}`); }
}

// ---------------------------------------------------------------------------
// Migration from v0.2.0 (profiles lived in globalStorage + globalState)
// ---------------------------------------------------------------------------

async function migrateLegacyProfiles() {
  if (ctx.globalState.get<boolean>(MIGRATED_KEY)) { return; }
  type LegacyProfile = { name: string; dir: string; createdAt: string; lastSavedAt?: string };
  const legacy = ctx.globalState.get<LegacyProfile[]>(LEGACY_PROFILES_KEY, []);
  const p = paths();
  try {
    const existing = await core.listProfiles(p);
    let migrated = 0;
    for (const lp of legacy) {
      if (existing.some(e => e.name === lp.name)) { continue; }
      try {
        await fs.access(lp.dir);
      } catch { continue; }
      await core.createEmptyProfile(p, core.cleanProfileName(lp.name) || lp.name);
      const dest = path.join(p.profilesRoot, lp.name);
      for (const piece of ['.claude', '.claude.json']) {
        try {
          await fs.cp(path.join(lp.dir, piece), path.join(dest, piece),
            { recursive: true, force: true, preserveTimestamps: true });
        } catch { /* piece absent in legacy profile */ }
      }
      migrated++;
    }
    const legacyActive = ctx.globalState.get<string>(LEGACY_ACTIVE_KEY);
    if (legacyActive && !(await core.getActiveProfileName(p))) {
      await core.setActiveProfileName(p, legacyActive);
    }
    await ctx.globalState.update(MIGRATED_KEY, true);
    if (migrated > 0) {
      log(`migrated ${migrated} profile(s) from extension storage to ${p.profilesRoot}`);
      vscode.window.showInformationMessage(
        `Claude Profile Switcher: migrated ${migrated} profile(s) to ${p.profilesRoot}. The old copies in extension storage were left untouched.`);
    }
  } catch (err) {
    log(`migration warning: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function importCurrent() {
  const name = await promptProfileName(
    'Import current official Claude account',
    'Name the currently logged-in account, e.g. Main, Work, Personal', 'Main');
  if (!name) { return; }
  const info = await core.importLiveAsProfile(paths(), name, log);
  vscode.window.showInformationMessage(`Imported current Claude account as '${info.name}'. It is now the active profile.`);
}

async function createEmpty() {
  const name = await promptProfileName(
    'Create empty Claude account profile',
    'After switching to it, log in via the official Claude panel.');
  if (!name) { return; }
  await core.createEmptyProfile(paths(), name);
  vscode.window.showInformationMessage(
    `Created empty profile '${name}'. Switch to it, reload, then log in with that account in the Claude panel.`);
}

async function switchProfile() {
  const p = paths();
  const target = await pickProfile('Switch official Claude Code account');
  if (!target) { return; }
  const active = await core.getActiveProfileName(p);
  if (target.name === active) {
    vscode.window.showInformationMessage(`'${target.name}' is already active.`);
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Switch Claude account to '${target.name}'?\n\nCurrent state will be saved to '${active ?? '(backup only — no active profile)'}' and backed up, then the active Claude files are replaced. A window reload is needed afterwards.`,
    { modal: true }, 'Switch');
  if (confirm !== 'Switch') { return; }

  const result = await core.switchToProfile(p, target.name, { maxBackups: maxBackups(), log });
  showWarnings(result.warnings);
  await updateStatusBar();

  if (cfg().get<boolean>('reloadAfterSwitch') !== false) {
    vscode.window.showInformationMessage(`Switched to '${target.name}'. Reloading window…`);
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } else {
    const pick = await vscode.window.showInformationMessage(
      `Switched to '${target.name}'. Reload the window so the Claude extension picks up the new account.`, 'Reload Window');
    if (pick) { await vscode.commands.executeCommand('workbench.action.reloadWindow'); }
  }
}

async function syncActive() {
  const p = paths();
  const active = await core.getActiveProfileName(p);
  if (!active) {
    vscode.window.showErrorMessage('No active profile. Use "Import Current Claude Account" first.');
    return;
  }
  await core.saveLiveToProfile(p, active, log);
  vscode.window.showInformationMessage(`Saved current Claude state into profile '${active}'.`);
}

async function backupNow() {
  const backup = await core.backupLive(paths(), 'manual', { maxBackups: maxBackups(), log });
  vscode.window.showInformationMessage(`Backup created: ${backup.dir}`);
}

async function restoreLastBackup() {
  const p = paths();
  const backups = await core.listBackups(p);
  if (!backups.length) {
    vscode.window.showErrorMessage('No backups found.');
    return;
  }
  const last = backups[backups.length - 1];
  const confirm = await vscode.window.showWarningMessage(
    `Restore backup '${path.basename(last.dir)}' (reason: ${last.reason}, created ${last.createdAt})?\n\nThe current live state will be backed up first, then replaced. A window reload is needed afterwards.`,
    { modal: true }, 'Restore');
  if (confirm !== 'Restore') { return; }
  await core.restoreBackup(p, last, { maxBackups: maxBackups(), log });
  await updateStatusBar();
  const pick = await vscode.window.showInformationMessage(
    'Backup restored. Reload the window so the Claude extension picks up the restored account.', 'Reload Window');
  if (pick) { await vscode.commands.executeCommand('workbench.action.reloadWindow'); }
}

async function showStatus() {
  const p = paths();
  const active = await core.getActiveProfileName(p);
  const profiles = await core.listProfiles(p);
  const backups = await core.listBackups(p);
  const lines = [
    `Active profile: ${active ?? 'none'}`,
    `Profiles (${profiles.length}): ${profiles.map(x => x.name).join(', ') || '—'}`,
    `Backups: ${backups.length}`,
    `Live files: ${p.claudeDir} | ${p.claudeJson}`,
    `Profiles folder: ${p.profilesRoot}`
  ];
  log(lines.join(' | '));
  vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
}

async function openProfilesFolder() {
  const p = paths();
  const pick = await vscode.window.showInformationMessage(
    `Profiles folder: ${p.profilesRoot}`, 'Open in New Window', 'Copy Path');
  if (pick === 'Open in New Window') {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p.profilesRoot), { forceNewWindow: true });
  } else if (pick === 'Copy Path') {
    await vscode.env.clipboard.writeText(p.profilesRoot);
  }
}

async function deleteProfile() {
  const p = paths();
  const target = await pickProfile('Delete Claude profile', { excludeActive: true });
  if (!target) { return; }
  const active = await core.getActiveProfileName(p);
  if (target.name === active) {
    vscode.window.showErrorMessage('Switch away from this profile before deleting it.');
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Delete saved profile '${target.name}'? Its snapshot (including saved login) will be removed. Backups are kept.`,
    { modal: true }, 'Delete');
  if (confirm !== 'Delete') { return; }
  await core.deleteProfile(p, target.name);
  vscode.window.showInformationMessage(`Deleted profile '${target.name}'.`);
}
