# GitHub Setup for Updates

The auto-updater is now integrated! Here's how it works and what you need to do.

## How It Works Now

When users launch the app:
1. App starts and creates the game window
2. Auto-updater checks: `https://raw.githubusercontent.com/andrewleewiles/poptropica-as2-desktop/main/version.json`
3. If a newer version exists → downloads the patch
4. Prompts user: "Update downloaded! Restart to install?"
5. User restarts → patch is applied

## Initial Setup (Do Once)

### 1. Commit These Files to GitHub

You need to commit just a few key files:

```bash
# Remove the git lock (already done)
rm .git/index.lock

# Stage only what's needed
git add version.json
git add electron-pepper/src/auto-updater.js
git add electron-pepper/src/main.js
git add electron-pepper/package.json
git add create-patch-update.js
git add release-patch.sh
git add *.md

# Commit
git commit -m "Add auto-updater system

- Integrated auto-updater into main.js
- Checks GitHub for version.json
- Downloads patches from GitHub Releases
- Initial version: 0.1.0"

# Push to GitHub
git push origin main
```

### 2. Verify version.json is Accessible

After pushing, check that this URL works:
```
https://raw.githubusercontent.com/andrewleewiles/poptropica-as2-desktop/main/version.json
```

You should see the version info!

## Releasing Your First Update

When you want to push an update to users:

### 1. Make Changes Locally

```bash
# Edit any files in content/ or electron-pepper/src/
vim content/www.poptropica.com/scenes/islandWest/sceneWestMain.swf
vim electron-pepper/src/main.js
```

### 2. Create a Patch

```bash
./release-patch.sh 0.1.1
```

This creates: `updates/poptropica-patch-0.1.1.zip`

### 3. Create GitHub Release

```bash
# Create and push tag
git tag v0.1.1
git push origin v0.1.1
```

Then go to: https://github.com/andrewleewiles/poptropica-as2-desktop/releases
- Click "Draft a new release"
- Choose tag: v0.1.1
- Title: "Version 0.1.1"
- Upload: `updates/poptropica-patch-0.1.1.zip`
- Publish release

### 4. Update version.json

Edit `version.json`:

```json
{
  "version": "0.1.1",
  "patchType": "incremental",
  "releaseDate": "2025-10-29",
  "downloadUrl": "https://github.com/andrewleewiles/poptropica-as2-desktop/releases/download/v0.1.1/poptropica-patch-0.1.1.zip",
  "releaseNotes": "Bug fixes for Wild West island",
  "changelog": [
    "Fixed crash in saloon scene",
    "Improved profile switching"
  ]
}
```

### 5. Commit and Push version.json

```bash
git add version.json
git commit -m "Release version 0.1.1"
git push origin main
```

Done! Users will get the update within 1 hour (or immediately if they restart the app).

## Current State

- ✅ Auto-updater integrated into main.js
- ✅ Configured to check GitHub
- ✅ version.json created (v0.1.0 - current version)
- ⏳ Need to push to GitHub
- ⏳ Future patches will go to GitHub Releases

## Testing

To test the update system locally:

1. **Package the app:**
   ```bash
   cd electron-pepper
   npm run build:mac  # or build:win64
   ```

2. **Run the packaged app** and check console logs for:
   ```
   [AutoUpdater] Initializing...
   [AutoUpdater] Started - will check for updates periodically
   [AutoUpdater] Checking for updates...
   ```

3. **No updates yet?** You'll see:
   ```
   [AutoUpdater] Already on latest version
   ```

## What Gets Committed to GitHub?

**Small files (commit these):**
- Code files (*.js, *.md)
- version.json
- Update scripts
- Electron app code

**Large files (DON'T commit, distribute separately):**
- content/ directory (2GB+) - users get this in initial download
- Patches (updates/) - go to GitHub Releases
- Built apps (*.app, *.exe) - go to GitHub Releases

## Distribution Strategy

**Initial Distribution:**
- Zip up the full game (including content/)
- Upload to Google Drive, Mega, or host yourself
- Users download once (1-2 GB)

**Updates:**
- Create patches with changed files only (5-50 MB typically)
- Upload to GitHub Releases
- Users auto-update via the app

## Questions?

- "Update check failed?" → Check if version.json is pushed to GitHub
- "Download failed?" → Check if the patch ZIP is on GitHub Releases
- "Users not updating?" → They need to restart the app or wait up to 1 hour

See INTEGRATION_GUIDE.md for more details!
