# Poptropica AS2 Desktop - Update System

This document explains how to create and distribute updates to users who already have Poptropica installed.

## Overview

The update system consists of three components:

1. **Update Package Creator** (`create-update-package.js`) - Creates ZIP files with updated content
2. **Auto-Updater Module** (`electron-pepper/src/auto-updater.js`) - Downloads and installs updates
3. **Version Server** - Hosts version.json and update ZIP files

## Architecture

### What Gets Updated

The update system handles:

- **Content Directory** (`content/`)
  - All SWF files (framework.swf, gameplay.swf, char.swf, scenes, popups)
  - Sound files (MP3, OGG, WAV)
  - Avatar assets
  - All other game assets

- **Electron Host Code** (`electron-pepper/src/`)
  - main.js, preload.js, profile-manager.js
  - All renderer HTML files (base-pepper.html, etc.)

### What Doesn't Get Updated

- Application executable (Electron runtime)
- FFDec and Java tools
- node_modules dependencies
- User profiles and preferences

## Creating an Update Package

### Step 1: Make Your Changes

Edit any files in:
- `content/` directory
- `electron-pepper/src/*.js`
- `electron-pepper/src/renderer/*.html`

### Step 2: Update Version Number

Edit `electron-pepper/package.json` and increment the version:

```json
{
  "version": "0.1.1"
}
```

Use semantic versioning (MAJOR.MINOR.PATCH):
- **MAJOR**: Breaking changes
- **MINOR**: New features, backward compatible
- **PATCH**: Bug fixes

### Step 3: Create the Update Package

Run the packaging script:

```bash
node create-update-package.js 0.1.1
```

This creates:
- `updates/poptropica-update-0.1.1.zip` - The update package
- `updates/manifest-0.1.1.json` - Metadata about the update

### Step 4: Test the Update

Before distributing, test on a clean installation:

```bash
# Extract to a test installation
unzip updates/poptropica-update-0.1.1.zip -d /path/to/test/installation

# Run and verify everything works
cd /path/to/test/installation/electron-pepper
npm start
```

## Distributing Updates

### Option A: Self-Hosted Server (Recommended for Control)

1. **Upload update files to your web server:**
   ```
   https://your-server.com/poptropica/updates/poptropica-update-0.1.1.zip
   ```

2. **Create/update version.json:**
   ```json
   {
     "version": "0.1.1",
     "releaseDate": "2025-10-29",
     "releaseNotes": "Bug fixes and performance improvements",
     "downloadUrl": "https://your-server.com/poptropica/updates/poptropica-update-0.1.1.zip",
     "fileSizeBytes": 1234567890,
     "fileSizeMB": 1177.38,
     "changelog": [
       "Fixed scene transition bug",
       "Updated sound system",
       "Performance improvements"
     ]
   }
   ```

3. **Upload version.json:**
   ```
   https://your-server.com/poptropica/version.json
   ```

4. **Configure the auto-updater** in `electron-pepper/update-config.json`:
   ```json
   {
     "updateCheckUrl": "https://your-server.com/poptropica/version.json",
     "updateDownloadBaseUrl": "https://your-server.com/poptropica/updates/",
     "checkInterval": 3600000,
     "autoDownload": true,
     "autoInstall": false
   }
   ```

### Option B: GitHub Releases (Free, Easy)

1. **Create a new release on GitHub:**
   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

2. **Upload the ZIP file to the release:**
   - Go to: https://github.com/andrewleewiles/poptropica-as2-desktop/releases
   - Click "Create a new release"
   - Choose tag: v0.1.1
   - Upload: `poptropica-update-0.1.1.zip`

3. **Create a version.json file in a separate repository or GitHub Pages:**
   ```json
   {
     "version": "0.1.1",
     "downloadUrl": "https://github.com/andrewleewiles/poptropica-as2-desktop/releases/download/v0.1.1/poptropica-update-0.1.1.zip"
   }
   ```

4. **Host version.json somewhere accessible:**
   - GitHub Pages (in a separate repo)
   - GitHub Gist (make it public)
   - Any web server

### Option C: Cloud Storage (Simplest)

1. **Upload to cloud storage** (Dropbox, Google Drive, etc.)

2. **Get direct download link**

3. **Update version.json** and host it somewhere

## Integrating Auto-Updater in Electron

### Basic Integration

In `electron-pepper/src/main.js`, add:

```javascript
const AutoUpdater = require('./auto-updater');
const updateConfig = require('./update-config.json');

// Create auto-updater instance
const autoUpdater = new AutoUpdater(updateConfig);

// Start checking for updates
app.on('ready', () => {
  // ... your existing code ...

  // Start auto-updater
  autoUpdater.start();
});

// Stop updater on quit
app.on('will-quit', () => {
  autoUpdater.stop();
});
```

### Manual Update Check

Add a menu item or button to manually check for updates:

```javascript
const { Menu } = require('electron');

const menu = Menu.buildFromTemplate([
  {
    label: 'Help',
    submenu: [
      {
        label: 'Check for Updates',
        click: async () => {
          const updateInfo = await autoUpdater.checkForUpdates();
          if (updateInfo) {
            // Update available
          } else {
            // Already up to date
          }
        }
      }
    ]
  }
]);

Menu.setApplicationMenu(menu);
```

## Update Flow

1. **User starts application**
2. **Auto-updater checks version.json** (hourly by default)
3. **If newer version available:**
   - Downloads update ZIP to temp directory
   - Extracts files to application directory (overwrites old files)
   - Shows dialog: "Update installed! Restart now?"
4. **User restarts**
5. **New version runs**

## Configuration Options

Edit `electron-pepper/update-config.json`:

```json
{
  "updateCheckUrl": "https://your-server.com/poptropica/version.json",
  "updateDownloadBaseUrl": "https://your-server.com/poptropica/updates/",
  "checkInterval": 3600000,
  "autoDownload": true,
  "autoInstall": false
}
```

- **updateCheckUrl**: URL to version.json file
- **updateDownloadBaseUrl**: Base URL for update ZIP files
- **checkInterval**: How often to check (milliseconds, default: 1 hour)
- **autoDownload**: Automatically download updates (default: true)
- **autoInstall**: Automatically install updates (default: false for safety)

## Manual Update Installation

Users can also manually install updates:

1. Download `poptropica-update-X.Y.Z.zip`
2. Extract to installation directory (overwrite existing files)
3. Restart application

## Troubleshooting

### Update Check Fails

- Verify version.json URL is accessible
- Check internet connection
- Look at Electron console logs

### Update Download Fails

- Check download URL in version.json
- Verify file exists on server
- Check disk space

### Update Installation Fails

- Ensure user has write permissions to installation directory
- Check that no files are locked (application should be running during update)
- Try manual installation

## Security Considerations

### Future Enhancements (TODO)

1. **Add checksum verification:**
   ```javascript
   // In auto-updater.js
   const crypto = require('crypto');

   verifyChecksum(filePath, expectedChecksum) {
     const hash = crypto.createHash('sha256');
     const fileBuffer = fs.readFileSync(filePath);
     hash.update(fileBuffer);
     return hash.digest('hex') === expectedChecksum;
   }
   ```

2. **Sign update packages:**
   - Use code signing certificates
   - Verify signatures before installing

3. **HTTPS only:**
   - Always use HTTPS for version.json and downloads
   - Prevents man-in-the-middle attacks

## Best Practices

1. **Always test updates** before distributing
2. **Keep a backup** of the previous version
3. **Document changes** in version.json changelog
4. **Use semantic versioning** consistently
5. **Don't break user data** (profiles, preferences)
6. **Consider phased rollouts** for major updates

## Example Workflow

### Weekly Bug Fix Update

```bash
# 1. Fix bugs in code
vim content/www.poptropica.com/framework.swf  # via FFDec
vim electron-pepper/src/main.js

# 2. Update version
vim electron-pepper/package.json  # 0.1.0 -> 0.1.1

# 3. Create package
node create-update-package.js 0.1.1

# 4. Test
unzip updates/poptropica-update-0.1.1.zip -d /tmp/test-install
cd /tmp/test-install/electron-pepper && npm start

# 5. Upload to server
scp updates/poptropica-update-0.1.1.zip user@server:/var/www/poptropica/updates/

# 6. Update version.json
vim version.json  # Update to 0.1.1
scp version.json user@server:/var/www/poptropica/

# 7. Done! Users will auto-update within 1 hour
```

## File Sizes

Typical update package sizes:

- **Small update** (code only): ~50-100 MB
- **Medium update** (code + some scenes): ~200-500 MB
- **Large update** (code + scenes + sounds): ~1-2 GB

Users need sufficient disk space and bandwidth for updates.

## Support

For issues or questions about the update system:
- Check console logs in Electron DevTools
- Verify server URLs are accessible
- Test with manual update installation first
