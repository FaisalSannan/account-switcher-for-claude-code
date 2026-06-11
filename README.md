# Claude Official Profile Switcher (unofficial)

Switch between multiple **official Claude Code for VS Code** accounts without
logging out of any of them. Each account's local state (`~/.claude/` and
`~/.claude.json`) is snapshotted into a named profile; switching swaps the
live state atomically and reloads the window.

> ## ⚠️ Warning — unofficial tool
> This extension is **not made or endorsed by Anthropic**. It works by
> copying and swapping the official Claude extension's local state files
> (`~/.claude` and `~/.claude.json`), which include OAuth credentials,
> sessions and settings. Use it at your own risk, for private use.
>
> - It never modifies the Anthropic extension itself.
> - It never edits, prints or logs tokens — files are only copied as-is.
> - Every state change is preceded by a timestamped backup.
> - Profile snapshots contain **login credentials**. The profiles folder is
>   created with `700` permissions — do not commit it, sync it, or loosen it.

## How it works

```
~/.claude-profiles/
├── active-profile.json        # which profile is currently live
├── Main/
│   ├── profile.json           # metadata (name, createdAt, lastSavedAt)
│   ├── .claude/               # snapshot of ~/.claude
│   └── .claude.json           # snapshot of ~/.claude.json
├── Work/
│   └── ...
└── _backups/
    └── 2026-06-11T12-00-00-000Z-switch-to-Work/
        ├── backup.json        # reason, time, active profile at the time
        ├── .claude/
        └── .claude.json
```

A switch does, in order:

1. **Validate** the target profile (folder exists, JSON parses, credentials
   file has a usable shape — values are never read into logs or UI).
2. **Save** the live state into the currently active profile.
3. **Back up** the live state to `_backups/<timestamp>-switch-to-<name>/`.
4. **Swap**: the target snapshot is copied to staging paths next to
   `~/.claude`, then moved into place with `rename()` (atomic on the same
   filesystem). If any step fails, all completed renames are undone and the
   previous state is left intact.
5. **Enforce permissions**: `~/.claude` → `700`, `~/.claude.json` and
   `~/.claude/.credentials.json` → `600`.
6. **Reload** the window so the official Claude extension rereads the state.

## Commands (Command Palette)

| Command | What it does |
|---|---|
| Import Current Claude Account | Save the currently logged-in account as a new named profile and mark it active |
| Create Empty Profile | Create a profile with no state; switch to it, reload, then log in with the second account |
| Switch Official Claude Account | Pick a profile; saves + backs up current state, swaps, reloads |
| Save Current State to Active Profile | Re-snapshot the live state into the active profile |
| Backup Current Claude State | Manual timestamped backup |
| Restore Last Backup | Restore the most recent backup (takes a fresh `pre-restore` backup first) |
| Show Status | Active profile, profile list, paths, backup count |
| Open Profiles Folder | Open/copy the profiles folder path |
| Delete Profile | Delete a non-active profile's snapshot |

The status bar shows the active profile (e.g. `Claude: Main`); clicking it
opens the switch menu.

## First-time setup for two accounts

1. While logged in with account 1: **Import Current Claude Account** → name it `Main`.
2. **Create Empty Profile** → name it `Work`.
3. **Switch Official Claude Account** → `Work`. The window reloads with no
   Claude login (account 1 stays saved in its profile).
4. Log in to the Claude panel with account 2.
5. **Save Current State to Active Profile** (saves account 2 into `Work`).
6. From now on, switch freely between `Main` and `Work`. Both stay logged in.

Tip: before switching, let any running Claude task finish — the official
extension may write to `~/.claude` while it works.

## Recovery instructions

If anything goes wrong (interrupted switch, wrong account, corrupted state):

1. **From VS Code:** run `Claude Profile Switcher: Restore Last Backup`.
2. **Manually** (terminal), pick the newest folder in
   `~/.claude-profiles/_backups/` and restore it:

   ```bash
   ls ~/.claude-profiles/_backups/            # newest = last in list
   B=~/.claude-profiles/_backups/<chosen-backup>
   rm -rf ~/.claude ~/.claude.json
   cp -a "$B/.claude"      ~/.claude        2>/dev/null || true
   cp -a "$B/.claude.json" ~/.claude.json   2>/dev/null || true
   chmod 700 ~/.claude
   chmod 600 ~/.claude.json ~/.claude/.credentials.json 2>/dev/null || true
   ```

3. Reload the VS Code / code-server window.
4. Worst case (no usable backup): delete `~/.claude` and `~/.claude.json`
   and log in to the Claude panel again. Nothing outside your home directory
   is ever touched.

Stray `~/.claude.staging-*` / `~/.claude.old-*` entries can only exist after
a hard crash mid-swap; they are safe to delete after restoring a backup.

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeProfileSwitcher.profilesRoot` | `~/.claude-profiles` | Where profiles and backups live |
| `claudeProfileSwitcher.activeClaudeDir` | `~/.claude` | Live Claude config dir |
| `claudeProfileSwitcher.activeClaudeJson` | `~/.claude.json` | Live Claude root JSON |
| `claudeProfileSwitcher.reloadAfterSwitch` | `true` | Auto-reload the window after a switch |
| `claudeProfileSwitcher.maxBackups` | `25` | Backups kept in `_backups` (oldest pruned; `0` = keep all) |

## Build from source

```bash
npm install
npm test          # compiles + runs the core test suite in a temp sandbox
npm run package   # produces claude-official-profile-switcher-<version>.vsix
```

Install with: `code-server --install-extension claude-official-profile-switcher-<version>.vsix`
(or VS Code: *Extensions: Install from VSIX…*).

## Notes & limitations

- VS Code/code-server is reloaded after a switch; unsaved editors prompt as usual.
- Switching while a Claude task is actively writing to `~/.claude` can snapshot
  a mid-write state; the backup taken before each switch covers this.
- Profiles created by v0.2.0 of this extension (stored in extension global
  storage) are migrated automatically to `~/.claude-profiles` on first run.
