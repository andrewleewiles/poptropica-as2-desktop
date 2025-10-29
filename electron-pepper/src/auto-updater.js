/**
 * Poptropica AS2 Desktop - Auto-Updater Module
 *
 * Checks for updates and downloads/applies them automatically.
 * This handles content updates (scenes, sounds, SWFs) and host-side code updates.
 *
 * Architecture:
 * - Checks a remote version.json file for latest version
 * - Downloads update ZIP if newer version available
 * - Extracts update files to application directory
 * - Notifies user and prompts for restart if code was updated
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { app, dialog } = require('electron');
const { execSync } = require('child_process');

class AutoUpdater {
  constructor(config = {}) {
    // Configuration
    this.updateCheckUrl = config.updateCheckUrl || 'https://example.com/poptropica/version.json';
    this.updateDownloadBaseUrl = config.updateDownloadBaseUrl || 'https://example.com/poptropica/updates/';
    this.checkInterval = config.checkInterval || 3600000; // Default: 1 hour
    this.autoDownload = config.autoDownload !== false; // Default: true
    this.autoInstall = config.autoInstall !== false; // Default: true

    // State
    this.currentVersion = app.getVersion(); // From package.json
    this.checking = false;
    this.downloading = false;
    this.updateAvailable = false;
    this.latestVersion = null;
    this.downloadedUpdatePath = null;

    // Paths
    this.appPath = app.getAppPath();
    this.tempDir = path.join(app.getPath('temp'), 'poptropica-updates');

    // Create temp directory if it doesn't exist
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    console.log('[AutoUpdater] Initialized');
    console.log(`[AutoUpdater] Current version: ${this.currentVersion}`);
    console.log(`[AutoUpdater] Update check URL: ${this.updateCheckUrl}`);
  }

  /**
   * Start automatic update checking
   */
  start() {
    console.log('[AutoUpdater] Starting automatic update checks');

    // Check immediately on startup
    this.checkForUpdates();

    // Then check periodically
    this.intervalId = setInterval(() => {
      this.checkForUpdates();
    }, this.checkInterval);
  }

  /**
   * Stop automatic update checking
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[AutoUpdater] Stopped automatic update checks');
    }
  }

  /**
   * Check if a newer version is available
   * @returns {Promise<Object|null>} Update info or null if no update
   */
  async checkForUpdates() {
    if (this.checking) {
      console.log('[AutoUpdater] Already checking for updates');
      return null;
    }

    this.checking = true;
    console.log('[AutoUpdater] Checking for updates...');

    try {
      const versionInfo = await this.fetchVersionInfo();

      if (!versionInfo || !versionInfo.version) {
        console.log('[AutoUpdater] No version info available');
        this.checking = false;
        return null;
      }

      const needsUpdate = this.compareVersions(versionInfo.version, this.currentVersion) > 0;

      if (needsUpdate) {
        console.log(`[AutoUpdater] Update available: ${versionInfo.version} (current: ${this.currentVersion})`);
        this.updateAvailable = true;
        this.latestVersion = versionInfo.version;

        if (this.autoDownload) {
          await this.downloadUpdate(versionInfo);
        }

        this.checking = false;
        return versionInfo;
      } else {
        console.log('[AutoUpdater] Already on latest version');
        this.checking = false;
        return null;
      }

    } catch (error) {
      console.error('[AutoUpdater] Error checking for updates:', error.message);
      this.checking = false;
      return null;
    }
  }

  /**
   * Fetch version information from remote server
   * @returns {Promise<Object>} Version info object
   */
  fetchVersionInfo() {
    return new Promise((resolve, reject) => {
      https.get(this.updateCheckUrl, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const versionInfo = JSON.parse(data);
            resolve(versionInfo);
          } catch (error) {
            reject(new Error('Invalid JSON response'));
          }
        });
      }).on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Download the update package
   * @param {Object} versionInfo - Version information
   * @returns {Promise<string>} Path to downloaded file
   */
  async downloadUpdate(versionInfo) {
    if (this.downloading) {
      console.log('[AutoUpdater] Already downloading update');
      return null;
    }

    this.downloading = true;

    // Support both patch and full updates
    // Prefer patch updates (smaller, faster) if available
    const isPatch = versionInfo.patchType === 'incremental';
    const updateFileName = isPatch
      ? `poptropica-patch-${versionInfo.version}.zip`
      : `poptropica-update-${versionInfo.version}.zip`;

    // Use direct download URL if provided, otherwise construct from base URL
    const updateUrl = versionInfo.downloadUrl || (this.updateDownloadBaseUrl + updateFileName);
    const downloadPath = path.join(this.tempDir, updateFileName);

    console.log(`[AutoUpdater] Downloading ${isPatch ? 'patch' : 'full'} update from: ${updateUrl}`);
    if (isPatch && versionInfo.filesChanged) {
      console.log(`[AutoUpdater] Patch contains ${versionInfo.filesChanged} changed files`);
    }

    try {
      await this.downloadFile(updateUrl, downloadPath);
      console.log(`[AutoUpdater] Update downloaded to: ${downloadPath}`);
      this.downloadedUpdatePath = downloadPath;

      if (this.autoInstall) {
        await this.installUpdate();
      }

      this.downloading = false;
      return downloadPath;

    } catch (error) {
      console.error('[AutoUpdater] Error downloading update:', error.message);
      this.downloading = false;
      throw error;
    }
  }

  /**
   * Download a file from a URL
   * @param {string} url - File URL
   * @param {string} destination - Destination path
   * @returns {Promise<void>}
   */
  downloadFile(url, destination) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destination);

      https.get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
          return;
        }

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });

      }).on('error', (error) => {
        fs.unlink(destination, () => {}); // Clean up partial file
        reject(error);
      });

      file.on('error', (error) => {
        fs.unlink(destination, () => {}); // Clean up partial file
        reject(error);
      });
    });
  }

  /**
   * Install the downloaded update
   * @returns {Promise<void>}
   */
  async installUpdate() {
    if (!this.downloadedUpdatePath || !fs.existsSync(this.downloadedUpdatePath)) {
      throw new Error('No update package available to install');
    }

    console.log('[AutoUpdater] Installing update...');

    try {
      // Extract the ZIP file
      const extractDir = this.appPath;
      console.log(`[AutoUpdater] Extracting to: ${extractDir}`);

      // Use unzip command (cross-platform)
      execSync(`unzip -o "${this.downloadedUpdatePath}" -d "${extractDir}"`, {
        stdio: 'inherit'
      });

      console.log('[AutoUpdater] Update installed successfully');

      // Clean up downloaded file
      fs.unlinkSync(this.downloadedUpdatePath);
      this.downloadedUpdatePath = null;

      // Notify user and prompt for restart
      this.promptRestart();

    } catch (error) {
      console.error('[AutoUpdater] Error installing update:', error.message);
      throw error;
    }
  }

  /**
   * Prompt user to restart the application
   */
  promptRestart() {
    const response = dialog.showMessageBoxSync({
      type: 'info',
      title: 'Update Installed',
      message: 'Poptropica has been updated!',
      detail: `Version ${this.latestVersion} has been installed. Please restart the application to use the latest version.`,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1
    });

    if (response === 0) {
      // User chose to restart
      app.relaunch();
      app.quit();
    }
  }

  /**
   * Compare two semantic version strings
   * @param {string} v1 - First version (e.g., "1.2.3")
   * @param {string} v2 - Second version
   * @returns {number} 1 if v1 > v2, -1 if v1 < v2, 0 if equal
   */
  compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;

      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }

    return 0;
  }
}

module.exports = AutoUpdater;
