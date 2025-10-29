#!/usr/bin/env node

/**
 * Poptropica AS2 Desktop - Incremental Patch Update Creator
 *
 * Creates a ZIP containing ONLY changed files since the last version.
 * Much smaller and faster than full updates!
 *
 * Usage:
 *   node create-patch-update.js <new-version> [--base-version <old-version>]
 *
 * Examples:
 *   node create-patch-update.js 0.1.1
 *   node create-patch-update.js 0.1.1 --base-version 0.1.0
 *
 * This tracks changes using git to create minimal patch files.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

// Parse command line arguments
const args = process.argv.slice(2);
const version = args[0];
const baseVersionIndex = args.indexOf('--base-version');
let baseVersion = null;

if (baseVersionIndex !== -1 && args[baseVersionIndex + 1]) {
  baseVersion = args[baseVersionIndex + 1];
}

if (!version) {
  console.error('Error: Version number required');
  console.error('Usage: node create-patch-update.js <version> [--base-version <old-version>]');
  console.error('Example: node create-patch-update.js 0.1.1 --base-version 0.1.0');
  process.exit(1);
}

// Validate version format
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Error: Version must be in format X.Y.Z (e.g., 0.1.1)');
  process.exit(1);
}

const outputDir = path.join(__dirname, 'updates');
const patchFile = path.join(outputDir, `poptropica-patch-${version}.zip`);
const manifestFile = path.join(outputDir, `patch-manifest-${version}.json`);
const changelogFile = path.join(outputDir, `changelog-${version}.txt`);

// Create updates directory if it doesn't exist
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Check if this version already exists
if (fs.existsSync(patchFile)) {
  console.error(`Error: Patch for version ${version} already exists`);
  console.error(`File: ${patchFile}`);
  console.error('Please use a different version number or delete the existing patch');
  process.exit(1);
}

console.log(`\nCreating patch update for version ${version}...`);
console.log('='.repeat(60));

// Directories we care about
const trackedDirs = [
  'content/',
  'electron-pepper/src/'
];

// Find changed files
let changedFiles = [];

try {
  // Check if git is available and we're in a git repo
  const isGitRepo = execSync('git rev-parse --is-inside-work-tree 2>/dev/null || echo "false"', {
    encoding: 'utf8',
    cwd: __dirname
  }).trim() === 'true';

  if (isGitRepo) {
    console.log('\nUsing git to detect changed files...\n');

    // If base version specified, compare against that tag
    if (baseVersion) {
      console.log(`Comparing against base version: v${baseVersion}`);

      try {
        // Get list of changed files between tags
        const diffOutput = execSync(`git diff --name-only v${baseVersion} HEAD`, {
          encoding: 'utf8',
          cwd: __dirname
        });

        changedFiles = diffOutput.split('\n').filter(f => f.trim() !== '');
      } catch (error) {
        console.error(`Warning: Tag v${baseVersion} not found. Falling back to uncommitted changes.`);
        baseVersion = null; // Fall through to next check
      }
    }

    // If no base version or tag not found, use uncommitted + staged changes
    if (!baseVersion || changedFiles.length === 0) {
      console.log('Detecting uncommitted and staged changes...');

      // Get modified and new files (staged and unstaged)
      const statusOutput = execSync('git status --porcelain', {
        encoding: 'utf8',
        cwd: __dirname
      });

      changedFiles = statusOutput.split('\n')
        .map(line => line.trim())
        .filter(line => line !== '')
        .map(line => {
          // Format: "XY filename" where X=staged, Y=unstaged
          // M  = modified, A = added, D = deleted, ?? = untracked
          const match = line.match(/^[MADR? ][MADR? ] (.+)$/);
          return match ? match[1] : line.substring(3);
        })
        .filter(f => f.trim() !== '');
    }

    // Filter to only include tracked directories
    changedFiles = changedFiles.filter(file => {
      return trackedDirs.some(dir => file.startsWith(dir));
    });

  } else {
    console.log('⚠ Git not available. Please specify files manually.\n');
    console.log('Creating a full update instead...\n');

    // Fall back to including everything
    changedFiles = trackedDirs.map(dir => dir);
  }

  if (changedFiles.length === 0) {
    console.log('⚠ No changed files detected!');
    console.log('');
    console.log('Options:');
    console.log('  1. Make changes to files in content/ or electron-pepper/src/');
    console.log('  2. Use --base-version to compare against a previous release');
    console.log('  3. Use create-update-package.js for a full update');
    console.log('');
    process.exit(1);
  }

  console.log(`Found ${changedFiles.length} changed file(s):\n`);

  // Categorize changes
  const categories = {
    content: [],
    electron: []
  };

  changedFiles.forEach(file => {
    console.log(`  ✓ ${file}`);
    if (file.startsWith('content/')) {
      categories.content.push(file);
    } else if (file.startsWith('electron-pepper/')) {
      categories.electron.push(file);
    }
  });

  console.log('\nChange summary:');
  console.log(`  Content files: ${categories.content.length}`);
  console.log(`  Electron files: ${categories.electron.length}`);

  // Create changelog
  const changelogContent = [
    `Poptropica AS2 Desktop - Patch ${version}`,
    `Created: ${new Date().toISOString()}`,
    baseVersion ? `Base version: ${baseVersion}` : 'Base version: current',
    '',
    `Changed files: ${changedFiles.length}`,
    '',
    'Content Updates:',
    ...categories.content.map(f => `  - ${f}`),
    '',
    'Electron Updates:',
    ...categories.electron.map(f => `  - ${f}`),
  ].join('\n');

  fs.writeFileSync(changelogFile, changelogContent);
  console.log(`\n✓ Created changelog: ${changelogFile}`);

  // Create temporary file list for zip
  const fileListPath = path.join(outputDir, `.filelist-${version}.txt`);
  fs.writeFileSync(fileListPath, changedFiles.join('\n'));

  // Create the patch ZIP
  console.log('\nPackaging files...\n');

  const zipCommand = `zip -r "${patchFile}" -@ < "${fileListPath}"`;

  try {
    execSync(zipCommand, {
      stdio: 'inherit',
      cwd: __dirname
    });
  } catch (error) {
    // Clean up temp file
    fs.unlinkSync(fileListPath);
    throw error;
  }

  // Clean up temp file
  fs.unlinkSync(fileListPath);

  // Get file size
  const stats = fs.statSync(patchFile);
  const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

  // Calculate checksums for each file
  const fileChecksums = {};
  changedFiles.forEach(file => {
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const fileBuffer = fs.readFileSync(filePath);
      const hash = crypto.createHash('sha256');
      hash.update(fileBuffer);
      fileChecksums[file] = hash.digest('hex');
    }
  });

  // Create manifest
  const manifest = {
    version: version,
    patchType: 'incremental',
    baseVersion: baseVersion || 'current',
    createdAt: new Date().toISOString(),
    fileSizeBytes: stats.size,
    fileSizeMB: parseFloat(fileSizeMB),
    filesChanged: changedFiles.length,
    files: changedFiles,
    fileChecksums: fileChecksums,
    categories: {
      content: categories.content.length,
      electron: categories.electron.length
    }
  };

  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('✓ Patch update created successfully!');
  console.log('='.repeat(60));
  console.log(`  Patch file: ${patchFile}`);
  console.log(`  Size: ${fileSizeMB} MB (${changedFiles.length} files)`);
  console.log(`  Manifest: ${manifestFile}`);
  console.log(`  Changelog: ${changelogFile}`);

  console.log('\nNext steps:');
  console.log('  1. Test the patch on a clean installation');
  console.log('  2. Upload to GitHub Releases:');
  console.log(`     - Tag: v${version}`);
  console.log(`     - Upload: ${path.basename(patchFile)}`);
  console.log(`     - Upload: ${path.basename(changelogFile)}`);
  console.log('  3. Update version.json with new version info');
  console.log('='.repeat(60) + '\n');

} catch (error) {
  console.error('\n❌ Error creating patch update:');
  console.error(error.message);
  process.exit(1);
}
