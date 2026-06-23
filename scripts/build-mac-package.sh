#!/bin/zsh
set -euo pipefail

ROOT_DIR="${0:A:h:h}"
DIST_DIR="$ROOT_DIR/dist"
PACKAGE_DIR="$DIST_DIR/video-link-downloader-mac"
ZIP_PATH="$DIST_DIR/video-link-downloader-mac.zip"

rm -rf "$PACKAGE_DIR" "$ZIP_PATH"
mkdir -p "$PACKAGE_DIR"

rsync -a "$ROOT_DIR/extension/" "$PACKAGE_DIR/extension/"
rsync -a "$ROOT_DIR/helper/" "$PACKAGE_DIR/helper/" \
  --exclude "downloads/" \
  --exclude ".venv-py39-backup/" \
  --exclude "helper.log"
rsync -a "$ROOT_DIR/mac/" "$PACKAGE_DIR/mac/"
cp "$ROOT_DIR/mac/Install Video Link Downloader.command" "$PACKAGE_DIR/Install Video Link Downloader.command"
cp "$ROOT_DIR/mac/START HERE - Mac.command" "$PACKAGE_DIR/START HERE - Mac.command"
cp "$ROOT_DIR/OPEN FIRST - Mac Setup.html" "$PACKAGE_DIR/OPEN FIRST - Mac Setup.html"
cp "$ROOT_DIR/README.md" "$PACKAGE_DIR/README.md"
cp "$ROOT_DIR/START-HERE.txt" "$PACKAGE_DIR/START-HERE.txt"

find "$PACKAGE_DIR/mac" -name "*.command" -exec chmod +x {} \;
chmod +x "$PACKAGE_DIR/Install Video Link Downloader.command"
chmod +x "$PACKAGE_DIR/START HERE - Mac.command"
mkdir -p "$PACKAGE_DIR/helper/downloads"

cd "$DIST_DIR"
zip -qr "$ZIP_PATH" "video-link-downloader-mac"

echo "$ZIP_PATH"
