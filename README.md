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

## Full usage guide

### Knowing which account you're on

After installing and reloading, look at the **bottom-left status bar** of
VS Code / code-server. You'll see the active profile at all times:

```
👤 Claude: Main
```

- `Claude: <name>` — this account's state is currently live.
- `Claude: no profile` — no profile imported yet (see first-time setup below).

You can also run **Claude Profile Switcher: Show Status** from the Command
Palette (`Ctrl+Shift+P`) for the full picture: active profile, all profiles,
backup count and the exact paths in use.

### Switching accounts (day-to-day)

1. **Click `Claude: <name>` in the bottom-left status bar**
   (or `Ctrl+Shift+P` → *Claude Profile Switcher: Switch Official Claude Account*).
2. Pick the account you want from the menu. The currently active one is
   marked `● active now`.
3. Confirm the dialog. The extension saves your current account's state,
   takes a backup, swaps the files, and **reloads the window automatically**.
4. After the reload the Claude panel is on the other account — the status
   bar now shows its name.

> **Important: start a New Chat after switching.**
> Conversations belong to the account that created them. If a chat tab from
> the previous account is still open and you type into it, you'll get
> `No conversation found with session ID: …`. That's not a bug — it means
> sessions are correctly isolated per account. Click the **＋ (New Chat)**
> button in the Claude panel instead. Your old conversations come back
> whenever you switch to the profile they belong to.

### First-time setup (registering your accounts)

1. While logged in with account 1: `Ctrl+Shift+P` →
   **Import Current Claude Account** → name it (e.g. `Main`).
   The status bar now shows `Claude: Main`.
2. **Create Empty Profile** → name it (e.g. `Work`).
3. **Switch** to `Work` (status bar → pick `Work`). The window reloads and
   the Claude panel shows a login screen — account 1 is safely stored in its
   profile, not logged out.
4. Log in to the Claude panel with account 2.
5. Run **Save Current State to Active Profile** once, so the login is
   captured into `Work`.
6. Done. From now on switching is a single click on the status bar, and both
   accounts stay logged in permanently. Repeat steps 2–5 for any third
   account.

### Rules of thumb

- **After every switch → New Chat** (don't reuse a stale conversation tab).
- **Let running Claude tasks finish before switching**, so the snapshot
  isn't taken mid-write.
- **After logging in or changing Claude settings**, run
  *Save Current State to Active Profile* so the profile snapshot is current
  (switching also saves automatically — this is only for extra safety).
- **Something broke?** Run *Restore Last Backup*. Every switch keeps a
  timestamped backup automatically.

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
