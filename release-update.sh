#!/bin/bash

# Poptropica AS2 Desktop - Release Update Script
# This script automates the process of creating and releasing an update

set -e  # Exit on error

echo "=========================================="
echo "Poptropica AS2 Desktop - Release Update"
echo "=========================================="
echo ""

# Check if version argument is provided
if [ -z "$1" ]; then
    echo "Error: Version number required"
    echo "Usage: ./release-update.sh <version>"
    echo "Example: ./release-update.sh 0.1.1"
    exit 1
fi

VERSION=$1

# Validate version format
if ! [[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: Version must be in format X.Y.Z (e.g., 0.1.1)"
    exit 1
fi

echo "Preparing update for version: $VERSION"
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

# Step 2: Create update package
echo "Step 2: Creating update package..."
node create-update-package.js $VERSION
echo ""

# Step 3: Ask about git commit
echo "Step 3: Git operations"
read -p "Create git commit for version $VERSION? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    git add electron-pepper/package.json
    git commit -m "Release version $VERSION"
    echo "✓ Created git commit"

    read -p "Create and push git tag v$VERSION? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        git tag "v$VERSION"
        git push origin main
        git push origin "v$VERSION"
        echo "✓ Created and pushed git tag v$VERSION"
    fi
fi
echo ""

# Step 4: Display next steps
echo "=========================================="
echo "✓ Update package created successfully!"
echo "=========================================="
echo ""
echo "Files created:"
echo "  - updates/poptropica-update-$VERSION.zip"
echo "  - updates/manifest-$VERSION.json"
echo ""
echo "Next steps:"
echo ""
echo "  1. Test the update:"
echo "     unzip updates/poptropica-update-$VERSION.zip -d /tmp/test"
echo ""
echo "  2a. GitHub Releases (recommended):"
echo "     - Go to: https://github.com/andrewleewiles/poptropica-as2-desktop/releases"
echo "     - Click 'Draft a new release'"
echo "     - Choose tag: v$VERSION"
echo "     - Upload: updates/poptropica-update-$VERSION.zip"
echo "     - Update version.json with the download URL"
echo ""
echo "  2b. Or upload to your server:"
echo "     scp updates/poptropica-update-$VERSION.zip user@server:/path/to/updates/"
echo "     # Update and upload version.json"
echo ""
echo "=========================================="
