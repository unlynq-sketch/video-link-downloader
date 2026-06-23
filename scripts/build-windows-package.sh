#!/bin/zsh
set -euo pipefail

ROOT_DIR="${0:A:h:h}"
DIST_DIR="$ROOT_DIR/dist"
PACKAGE_DIR="$DIST_DIR/video-link-downloader-windows"
ZIP_PATH="$DIST_DIR/video-link-downloader-windows.zip"

rm -rf "$PACKAGE_DIR" "$ZIP_PATH"
mkdir -p "$PACKAGE_DIR"

rsync -a "$ROOT_DIR/extension/" "$PACKAGE_DIR/extension/"
rsync -a "$ROOT_DIR/helper/" "$PACKAGE_DIR/helper/" \
  --exclude "downloads/" \
  --exclude ".venv/" \
  --exclude ".venv-py39-backup/" \
  --exclude "helper.log"
rsync -a "$ROOT_DIR/windows/" "$PACKAGE_DIR/windows/"
cp "$ROOT_DIR/windows/START HERE - Windows.bat" "$PACKAGE_DIR/START HERE - Windows.bat"
cp "$ROOT_DIR/README.md" "$PACKAGE_DIR/README.md"
cp "$ROOT_DIR/START-HERE.txt" "$PACKAGE_DIR/START-HERE.txt"

mkdir -p "$PACKAGE_DIR/helper/downloads"

cd "$DIST_DIR"
zip -qr "$ZIP_PATH" "video-link-downloader-windows"

echo "$ZIP_PATH"
