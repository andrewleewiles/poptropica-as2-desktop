#!/usr/bin/env node

/**
 * Poptropica AS2 Desktop - Update Package Creator
 *
 * Creates a ZIP file containing all updatable game files:
 * - content/ directory (scenes, popups, sounds, SWFs, etc.)
 * - electron-pepper/src/*.js (main.js, preload.js, etc.)
 * - electron-pepper/src/renderer/*.html (base-pepper.html, etc.)
 *
 * Usage:
 *   node create-update-package.js <version>
 *
 * Example:
 *   node create-update-package.js 1.0.1
 *
 * This will create: updates/poptropica-update-1.0.1.zip
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Get version from command line
const version = process.argv[2];
if (!version) {
  console.error('Error: Version number required');
  console.error('Usage: node create-update-package.js <version>');
  console.error('Example: node create-update-package.js 1.0.1');
  process.exit(1);
}

// Validate version format (basic semver check)
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Error: Version must be in format X.Y.Z (e.g., 1.0.1)');
  process.exit(1);
}

const outputDir = path.join(__dirname, 'updates');
const outputFile = path.join(outputDir, `poptropica-update-${version}.zip`);
const manifestFile = path.join(outputDir, `manifest-${version}.json`);

// Create updates directory if it doesn't exist
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
  console.log('Created updates/ directory');
}

// Check if this version already exists
if (fs.existsSync(outputFile)) {
  console.error(`Error: Update package for version ${version} already exists`);
  console.error(`File: ${outputFile}`);
  console.error('Please use a different version number or delete the existing package');
  process.exit(1);
}

console.log(`\nCreating update package for version ${version}...`);
console.log('='.repeat(60));

// Files and directories to include in the update
const includes = [
  'content/',
  'electron-pepper/src/main.js',
  'electron-pepper/src/main-music-editor.js',
  'electron-pepper/src/preload.js',
  'electron-pepper/src/profile-manager.js',
  'electron-pepper/src/store-items-data.js',
  'electron-pepper/src/renderer/'
];

console.log('\nFiles to be packaged:');
includes.forEach(item => console.log(`  ✓ ${item}`));

// Build the zip command
// Using -r for recursive, -q for quiet (we'll show our own progress)
const zipCommand = `zip -r "${outputFile}" ${includes.join(' ')}`;

console.log('\n\nPackaging files...');
console.log('This may take several minutes for large content directories...\n');

try {
  // Execute zip command (remove -q to see zip's own progress)
  execSync(zipCommand, {
    stdio: 'inherit',
    cwd: __dirname
  });

  // Get file size
  const stats = fs.statSync(outputFile);
  const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

  console.log('\n' + '='.repeat(60));
  console.log('✓ Update package created successfully!');
  console.log(`  File: ${outputFile}`);
  console.log(`  Size: ${fileSizeMB} MB`);

  // Create manifest file with metadata
  const manifest = {
    version: version,
    createdAt: new Date().toISOString(),
    fileSizeBytes: stats.size,
    fileSizeMB: parseFloat(fileSizeMB),
    includes: includes,
    checksum: null // TODO: Add SHA256 checksum in future
  };

  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  console.log(`  Manifest: ${manifestFile}`);

  console.log('\nNext steps:');
  console.log('  1. Test the update package on a clean installation');
  console.log('  2. Upload to your update distribution server/CDN');
  console.log('  3. Update the version check endpoint with new version info');
  console.log('='.repeat(60) + '\n');

} catch (error) {
  console.error('\n❌ Error creating update package:');
  console.error(error.message);
  process.exit(1);
}
