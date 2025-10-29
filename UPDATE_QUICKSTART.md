# Update System - Quick Start Guide

Get your update system running in 5 minutes.

## For Developers: Creating Updates

You have two options: **Patch Updates** (recommended, smaller) or **Full Updates** (larger, everything).

### Option A: Patch Update (Recommended)

**Creates a ZIP with ONLY changed files** - much smaller and faster!

#### 1. Make your changes

Edit any files in:
- `content/` directory
- `electron-pepper/src/*.js`
- `electron-pepper/src/renderer/*.html`

#### 2. Create patch (automated script)

```bash
./release-patch.sh 0.1.1 --base 0.1.0
```

**Important:** Always specify `--base <previous-version>` to include ALL changes since the last release.

This creates: `updates/poptropica-patch-0.1.1.zip` (typically 5-50 MB)

### Option B: Full Update

**Creates a ZIP with ALL game files** - larger but includes everything.

#### 1. Make your changes

Same as above.

#### 2. Bump version in package.json

```bash
cd electron-pepper
# Edit package.json: "version": "0.1.0" -> "0.1.1"
```

#### 3. Create full update package

```bash
cd ..
node create-update-package.js 0.1.1
```

This creates: `updates/poptropica-update-0.1.1.zip` (typically 500+ MB)

### 4. Upload to your server

```bash
# Upload the ZIP file
scp updates/poptropica-update-0.1.1.zip user@yourserver.com:/var/www/poptropica/updates/

# Update version.json (see example-version.json)
scp version.json user@yourserver.com:/var/www/poptropica/
```

Done! Users will auto-update within 1 hour.

## For Server Setup: GitHub Releases (Easiest)

### 1. Create a release on GitHub

```bash
git tag v0.1.1
git push origin v0.1.1
```

### 2. Upload update ZIP to the release

- Go to: https://github.com/andrewleewiles/poptropica-as2-desktop/releases
- Click "Draft a new release"
- Choose tag: v0.1.1
- Attach: `poptropica-update-0.1.1.zip`

### 3. Host version.json somewhere

Create a GitHub Gist or use GitHub Pages with this content:

```json
{
  "version": "0.1.1",
  "releaseDate": "2025-10-29",
  "downloadUrl": "https://github.com/andrewleewiles/poptropica-as2-desktop/releases/download/v0.1.1/poptropica-update-0.1.1.zip"
}
```

### 4. Configure auto-updater

Edit `electron-pepper/update-config.json`:

```json
{
  "updateCheckUrl": "https://your-gist-url/version.json",
  "updateDownloadBaseUrl": "https://github.com/andrewleewiles/poptropica-as2-desktop/releases/download/",
  "autoDownload": true,
  "autoInstall": false
}
```

## For Users: Manual Update

If auto-update isn't working:

1. Download `poptropica-update-X.Y.Z.zip` from the releases page
2. Extract to your Poptropica installation folder (overwrite existing files)
3. Restart Poptropica

## Testing

Before distributing an update:

```bash
# Test the update package
mkdir /tmp/poptropica-test
cp -r /path/to/existing/installation/* /tmp/poptropica-test/
unzip updates/poptropica-update-0.1.1.zip -d /tmp/poptropica-test/

# Run the updated version
cd /tmp/poptropica-test/electron-pepper
npm start
```

## Troubleshooting

**Update check fails?**
- Verify version.json URL is accessible in a browser
- Check Electron DevTools console for errors

**Update downloads but doesn't install?**
- Check file permissions
- Try setting `autoInstall: true` in update-config.json

**Want to force an update check?**
- Add "Check for Updates" to the Help menu (see main-with-updater-example.js)

## Learn More

- [UPDATE_SYSTEM.md](UPDATE_SYSTEM.md) - Complete documentation
- [main-with-updater-example.js](electron-pepper/src/main-with-updater-example.js) - Integration example
