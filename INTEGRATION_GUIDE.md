# Auto-Updater Integration Guide

This guide shows how to add automatic updates to your Poptropica desktop app.

## What It Does

On application startup, the auto-updater will:
1. Check if a new version is available
2. Download the update (patch or full)
3. Extract files to your game directory
4. Prompt user to restart to apply changes

## Quick Integration (3 Steps)

### Step 1: Add Auto-Updater to main.js

Open `electron-pepper/src/main.js` and add this at the top:

```javascript
const AutoUpdater = require('./auto-updater');
const path = require('path');
const fs = require('fs');

// Load update configuration
const updateConfigPath = path.join(__dirname, 'update-config.json');
let updateConfig = {};

if (fs.existsSync(updateConfigPath)) {
  updateConfig = JSON.parse(fs.readFileSync(updateConfigPath, 'utf8'));
}

// Create auto-updater
const autoUpdater = new AutoUpdater(updateConfig);
```

### Step 2: Start Updater When App is Ready

In your `app.on('ready', ...)` handler, add:

```javascript
app.on('ready', () => {
  // Your existing code (create window, etc.)
  createWindow();

  // Start auto-updater - checks for updates immediately and then hourly
  console.log('[Main] Starting auto-updater...');
  autoUpdater.start();
});
```

### Step 3: Configure Update URL

Edit `electron-pepper/update-config.json`:

```json
{
  "updateCheckUrl": "https://your-server.com/poptropica/version.json",
  "updateDownloadBaseUrl": "https://your-server.com/poptropica/updates/",
  "checkInterval": 3600000,
  "autoDownload": true,
  "autoInstall": true
}
```

**For GitHub Releases:**
```json
{
  "updateCheckUrl": "https://raw.githubusercontent.com/andrewleewiles/poptropica-as2-desktop/main/version.json",
  "checkInterval": 3600000,
  "autoDownload": true,
  "autoInstall": true
}
```

That's it! Updates will now happen automatically.

## Complete Example

Here's a minimal complete main.js with auto-updater:

```javascript
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// ============================================
// AUTO-UPDATER SETUP
// ============================================
const AutoUpdater = require('./auto-updater');

const updateConfigPath = path.join(__dirname, 'update-config.json');
let updateConfig = {};

if (fs.existsSync(updateConfigPath)) {
  try {
    updateConfig = JSON.parse(fs.readFileSync(updateConfigPath, 'utf8'));
    console.log('[Main] Loaded update configuration');
  } catch (error) {
    console.error('[Main] Error loading update config:', error);
  }
}

const autoUpdater = new AutoUpdater(updateConfig);

// ============================================
// APP CODE
// ============================================
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      plugins: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'base-pepper.html'));
}

app.on('ready', () => {
  createWindow();

  // Start checking for updates
  autoUpdater.start();
});

app.on('will-quit', () => {
  autoUpdater.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
```

## How Updates Work

### Update Flow

```
App Starts
    ↓
Auto-updater checks version.json
    ↓
New version available?
    ↓ YES
Download patch ZIP (e.g., 5 MB with 3 changed files)
    ↓
Extract to game directory (overwrites old files)
    ↓
Show dialog: "Update installed! Restart now?"
    ↓
User clicks "Restart Now"
    ↓
App restarts with new files
```

### What Gets Updated

When you release a patch update:
- Changed SWF files (scenes, popups, framework, gameplay, char)
- Changed sound files
- Changed JavaScript (main.js, preload.js, etc.)
- Changed HTML files (base-pepper.html, etc.)

User profiles and preferences are preserved!

## Testing Updates

### 1. Create a Test Update

```bash
# Change some files
vim content/www.poptropica.com/framework.swf
vim electron-pepper/src/main.js

# Create patch
./release-patch.sh 0.1.1

# This creates: updates/poptropica-patch-0.1.1.zip
```

### 2. Set Up Local Test Server

```bash
# In a separate terminal, serve the updates directory
cd updates
python3 -m http.server 8000

# Now updates are available at:
# http://localhost:8000/poptropica-patch-0.1.1.zip
```

### 3. Create Test version.json

```bash
cat > version.json << 'EOF'
{
  "version": "0.1.1",
  "patchType": "incremental",
  "downloadUrl": "http://localhost:8000/poptropica-patch-0.1.1.zip",
  "filesChanged": 3
}
EOF

# Serve it
python3 -m http.server 8001
```

### 4. Configure App to Use Test Server

Edit `electron-pepper/update-config.json`:

```json
{
  "updateCheckUrl": "http://localhost:8001/version.json",
  "checkInterval": 10000,
  "autoDownload": true,
  "autoInstall": true
}
```

### 5. Run and Test

```bash
cd electron-pepper
npm start

# Watch the console logs:
# [AutoUpdater] Checking for updates...
# [AutoUpdater] Update available: 0.1.1
# [AutoUpdater] Downloading patch update...
# [AutoUpdater] Update installed successfully
# Dialog appears: "Update installed! Restart now?"
```

## Production Deployment

### Using GitHub Releases (Recommended)

1. **Create a patch update:**
   ```bash
   ./release-patch.sh 0.1.1 --base 0.1.0
   ```

2. **Push to GitHub:**
   ```bash
   git push origin main
   git push origin v0.1.1
   ```

3. **Upload patch to GitHub Release:**
   - Go to: https://github.com/andrewleewiles/poptropica-as2-desktop/releases
   - Click "Draft a new release"
   - Choose tag: v0.1.1
   - Upload: `updates/poptropica-patch-0.1.1.zip`

4. **Update version.json in your repo:**
   ```json
   {
     "version": "0.1.1",
     "patchType": "incremental",
     "downloadUrl": "https://github.com/andrewleewiles/poptropica-as2-desktop/releases/download/v0.1.1/poptropica-patch-0.1.1.zip"
   }
   ```

5. **Commit version.json:**
   ```bash
   git add version.json
   git commit -m "Update version.json for v0.1.1"
   git push origin main
   ```

6. **Configure app to use GitHub:**
   ```json
   {
     "updateCheckUrl": "https://raw.githubusercontent.com/andrewleewiles/poptropica-as2-desktop/main/version.json",
     "autoDownload": true,
     "autoInstall": true
   }
   ```

Done! All users will automatically get the update within 1 hour.

## Configuration Options

### update-config.json

```json
{
  "updateCheckUrl": "URL to version.json",
  "updateDownloadBaseUrl": "Base URL for updates/ (optional)",
  "checkInterval": 3600000,
  "autoDownload": true,
  "autoInstall": true
}
```

- **updateCheckUrl**: Where to check for new versions
- **updateDownloadBaseUrl**: (Optional) Base URL for update files
- **checkInterval**: How often to check (milliseconds, default: 1 hour)
- **autoDownload**: Auto-download updates (default: true)
- **autoInstall**: Auto-install after download (default: true)

### Version.json Format

```json
{
  "version": "0.1.1",
  "patchType": "incremental",
  "downloadUrl": "https://direct-url-to-patch.zip",
  "filesChanged": 3,
  "releaseNotes": "Bug fixes",
  "changelog": ["Fix 1", "Fix 2"]
}
```

## Troubleshooting

### Updates Not Working?

1. **Check console logs:**
   - Open DevTools (View → Toggle Developer Tools)
   - Look for `[AutoUpdater]` messages

2. **Verify version.json is accessible:**
   - Open the `updateCheckUrl` in a browser
   - Should see JSON with version info

3. **Check permissions:**
   - App needs write access to installation directory
   - On macOS: May need to run from Applications folder

### Update Downloaded But Not Installing?

- Check `autoInstall` is `true` in update-config.json
- Look for error messages in console
- Try manual installation: unzip the patch to the game directory

### Users on Old Version?

- Check version.json is updated with new version
- Verify download URL is correct
- Check if users have internet connection

## Advanced: Manual Update Check

Add a menu item to manually check for updates:

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
          if (!updateInfo) {
            dialog.showMessageBox({
              type: 'info',
              message: 'You are up to date!',
              detail: `Version ${app.getVersion()}`
            });
          }
        }
      }
    ]
  }
]);

Menu.setApplicationMenu(menu);
```

## Summary

With the auto-updater integrated:
- ✅ Updates check on startup and hourly
- ✅ Downloads happen automatically in background
- ✅ Installs are one-click (user just clicks "Restart")
- ✅ Supports small patch updates (5 MB) or full updates (1+ GB)
- ✅ Works with GitHub Releases (free hosting)
- ✅ User profiles and preferences are preserved

The system is production-ready and handles everything automatically!
