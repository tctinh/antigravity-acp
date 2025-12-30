#!/bin/bash
set -e

VERSION="${1:-0.1.0}"
RELEASE_DIR="release"

echo "Building antigravity-acp v${VERSION} for all platforms..."

# Clean previous builds
rm -rf bin/ "$RELEASE_DIR/"
mkdir -p bin "$RELEASE_DIR"

# Build all platforms
echo "Building darwin-arm64..."
bun build src/cli.ts --compile --target=bun-darwin-arm64 --outfile bin/antigravity-acp-darwin-arm64

echo "Building darwin-x64..."
bun build src/cli.ts --compile --target=bun-darwin-x64 --outfile bin/antigravity-acp-darwin-x64

echo "Building linux-x64..."
bun build src/cli.ts --compile --target=bun-linux-x64 --outfile bin/antigravity-acp-linux-x64

echo "Building linux-arm64..."
bun build src/cli.ts --compile --target=bun-linux-arm64 --outfile bin/antigravity-acp-linux-arm64

echo "Building windows-x64..."
bun build src/cli.ts --compile --target=bun-windows-x64 --outfile bin/antigravity-acp-windows-x64.exe

# Package for release
echo "Packaging releases..."

# macOS ARM64
cd bin && tar -czvf "../$RELEASE_DIR/antigravity-acp-darwin-arm64.tar.gz" antigravity-acp-darwin-arm64 && cd ..

# macOS x64
cd bin && tar -czvf "../$RELEASE_DIR/antigravity-acp-darwin-x64.tar.gz" antigravity-acp-darwin-x64 && cd ..

# Linux x64
cd bin && tar -czvf "../$RELEASE_DIR/antigravity-acp-linux-x64.tar.gz" antigravity-acp-linux-x64 && cd ..

# Linux ARM64
cd bin && tar -czvf "../$RELEASE_DIR/antigravity-acp-linux-arm64.tar.gz" antigravity-acp-linux-arm64 && cd ..

# Windows x64
cd bin && zip "../$RELEASE_DIR/antigravity-acp-windows-x64.zip" antigravity-acp-windows-x64.exe && cd ..

echo ""
echo "Build complete! Release archives in $RELEASE_DIR/:"
ls -lh "$RELEASE_DIR/"
