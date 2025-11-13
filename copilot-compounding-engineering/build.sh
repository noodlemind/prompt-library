#!/bin/bash

# Build script for Copilot Compounding Engineering VSIX extension

set -e

echo "Building Copilot Compounding Engineering VSIX..."
echo ""

# Check if vsce is installed
if ! command -v vsce &> /dev/null; then
    echo "Error: vsce is not installed."
    echo "Install it with: npm install -g @vscode/vsce"
    exit 1
fi

# Clean previous builds
rm -f *.vsix

# Create out directory (even though we don't compile TypeScript)
mkdir -p out
cp extension.js out/

# Package the extension
echo "Packaging extension..."
vsce package

# List the generated file
echo ""
echo "✓ Build complete!"
echo ""
ls -lh *.vsix
echo ""
echo "To install:"
echo "  code --install-extension $(ls *.vsix | head -1)"
echo ""
echo "Or install via VS Code:"
echo "  1. Open VS Code"
echo "  2. Go to Extensions (Cmd/Ctrl+Shift+X)"
echo "  3. Click '...' menu → Install from VSIX"
echo "  4. Select the .vsix file"
