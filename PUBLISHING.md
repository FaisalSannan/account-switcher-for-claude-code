# Publishing guide

How to publish this extension to both extension stores. You need both:
regular **VS Code** users install from the Microsoft Marketplace;
**code-server / VSCodium** users install from Open VSX.

The manifest is already prepared with `"publisher": "faisalsannan"` — the
accounts you create below must use **exactly that ID** (or change it in
`package.json` and rebuild).

> ⚠️ Tokens created below are passwords. Never paste them into chats, issues
> or commits. Put them in a terminal environment variable just before use.

---

## 1. Microsoft VS Code Marketplace (one-time setup ~15 min)

1. **Azure DevOps account** (the Marketplace runs on it):
   go to https://dev.azure.com and sign in / sign up with a Microsoft
   account. Create an organization when prompted (any name, e.g.
   `faisalsannan`).
2. **Personal Access Token (PAT):**
   - In Azure DevOps click the ⚙️/user icon → **Personal access tokens** →
     **New Token**.
   - Name: `vsce-publish`. Organization: **All accessible organizations**.
   - Expiration: up to 1 year.
   - Scopes: **Custom defined** → click "Show all scopes" → under
     **Marketplace** tick **Manage**.
   - Create, and copy the token somewhere safe (shown only once).
3. **Create the publisher:**
   go to https://marketplace.visualstudio.com/manage → **Create publisher** →
   ID: `faisalsannan` (must match package.json), display name:
   `Faisal Sannan`.
4. **Publish** (from the project folder):

   ```bash
   read -s VSCE_PAT   # paste the PAT, press Enter (not echoed)
   npx vsce publish --no-dependencies -p "$VSCE_PAT"
   ```

   Future releases: bump `"version"` in package.json, commit, run the same
   command.

## 2. Open VSX (one-time setup ~10 min)

1. Go to https://open-vsx.org → **Login** with your GitHub account.
2. Open your avatar → **Settings** → **Publisher Agreement** → read and sign
   it (required once; needs your Eclipse account, the site walks you
   through creating one).
3. Still in Settings → **Access Tokens** → **Generate New Token** → copy it.
4. **Create your namespace and publish** (from the project folder):

   ```bash
   read -s OVSX_PAT   # paste the token, press Enter
   npx ovsx create-namespace faisalsannan -p "$OVSX_PAT"   # first time only
   npx ovsx publish --no-dependencies -p "$OVSX_PAT"
   ```

5. Optional but recommended: claim namespace *verification* so the listing
   loses its "unverified" badge — open an issue at
   https://github.com/EclipseFdn/open-vsx.org using the "Claim ownership"
   template.

## 3. After publishing

- Listing URLs:
  - https://marketplace.visualstudio.com/items?itemName=faisalsannan.account-switcher-for-claude-code
  - https://open-vsx.org/extension/faisalsannan/account-switcher-for-claude-code
- Add both install links to the README.
- The "Sponsor" button on the Marketplace listing comes from the `sponsor`
  field in package.json; on GitHub it comes from `.github/FUNDING.yml`
  (requires enabling **GitHub Sponsors** on your account:
  https://github.com/sponsors → "Join the waitlist"/"Set up").

## Release checklist (every version)

1. Bump `"version"` in `package.json`.
2. `npm test` — all tests must pass.
3. `npm run package` — builds the `.vsix`.
4. Commit, tag `v<version>`, push with `--tags`.
5. `npx vsce publish` + `npx ovsx publish` (tokens as above).
6. Create a GitHub release for the tag and attach the `.vsix`.
