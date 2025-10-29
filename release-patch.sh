#!/bin/bash

# Poptropica AS2 Desktop - Release Patch Update Script
# Creates incremental patch updates (only changed files)

set -e  # Exit on error

echo "=========================================="
echo "Poptropica - Release Patch Update"
echo "=========================================="
echo ""

# Check if version argument is provided
if [ -z "$1" ]; then
    echo "Error: Version number required"
    echo "Usage: ./release-patch.sh <version> [--base <base-version>]"
    echo "Example: ./release-patch.sh 0.1.1 --base 0.1.0"
    echo ""
    echo "If --base is not specified, detects changes from git status"
    exit 1
fi

VERSION=$1
BASE_VERSION=""

# Parse --base argument if provided
if [ "$2" == "--base" ] && [ -n "$3" ]; then
    BASE_VERSION=$3
fi

# Validate version format
if ! [[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: Version must be in format X.Y.Z (e.g., 0.1.1)"
    exit 1
fi

echo "Preparing patch update for version: $VERSION"
if [ -n "$BASE_VERSION" ]; then
    echo "Base version: $BASE_VERSION"
else
    echo "Base version: current (detecting uncommitted changes)"
fi
echo ""

# Step 1: Update package.json version
echo "Step 1: Updating package.json version..."
cd electron-pepper
if command -v node &> /dev/null; then
    node -e "const pkg=require('./package.json'); pkg.version='$VERSION'; require('fs').writeFileSync('package.json', JSON.stringify(pkg,null,2)+'\n');"
    echo "✓ Updated package.json to version $VERSION"
else
    echo "⚠ Node.js not found - please manually update electron-pepper/package.json"
fi
cd ..
echo ""

# Step 2: Create patch update
echo "Step 2: Creating patch update (only changed files)..."
if [ -n "$BASE_VERSION" ]; then
    node create-patch-update.js $VERSION --base-version $BASE_VERSION
else
    node create-patch-update.js $VERSION
fi
echo ""

# Step 3: Ask about git commit
echo "Step 3: Git operations"
read -p "Commit changes and create git tag v$VERSION? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    # Stage package.json and any changed files in tracked directories
    git add electron-pepper/package.json
    git add content/ 2>/dev/null || true
    git add electron-pepper/src/ 2>/dev/null || true

    git commit -m "Release patch version $VERSION"
    echo "✓ Created git commit"

    read -p "Push and create tag v$VERSION? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        git tag "v$VERSION"
        git push origin main
        git push origin "v$VERSION"
        echo "✓ Pushed commit and tag v$VERSION"
    fi
fi
echo ""

# Step 4: Display next steps
echo "=========================================="
echo "✓ Patch update created successfully!"
echo "=========================================="
echo ""
echo "Files created:"
echo "  - updates/poptropica-patch-$VERSION.zip"
echo "  - updates/patch-manifest-$VERSION.json"
echo "  - updates/changelog-$VERSION.txt"
echo ""

# Show patch size
if [ -f "updates/poptropica-patch-$VERSION.zip" ]; then
    PATCH_SIZE=$(du -h "updates/poptropica-patch-$VERSION.zip" | cut -f1)
    echo "Patch size: $PATCH_SIZE"
    echo ""
fi

echo "Next steps:"
echo ""
echo "  1. Test the patch:"
echo "     unzip updates/poptropica-patch-$VERSION.zip -d /path/to/existing/installation"
echo ""
echo "  2. Upload to GitHub Releases:"
echo "     - Go to: https://github.com/andrewleewiles/poptropica-as2-desktop/releases"
echo "     - Click 'Draft a new release'"
echo "     - Choose tag: v$VERSION"
echo "     - Upload: updates/poptropica-patch-$VERSION.zip"
echo "     - Upload: updates/changelog-$VERSION.txt"
echo ""
echo "  3. Update version.json on your server:"
echo "     {"
echo "       \"version\": \"$VERSION\","
echo "       \"patchType\": \"incremental\","
if [ -n "$BASE_VERSION" ]; then
echo "       \"baseVersion\": \"$BASE_VERSION\","
fi
echo "       \"downloadUrl\": \"https://github.com/andrewleewiles/poptropica-as2-desktop/releases/download/v$VERSION/poptropica-patch-$VERSION.zip\""
echo "     }"
echo ""
echo "=========================================="
