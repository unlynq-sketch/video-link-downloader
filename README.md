# Video Link Downloader

A Chrome/Edge extension plus a local helper app for downloading media you own, have permission to download, or that is explicitly free to reuse.

This project does not bypass DRM, paywalls, login walls, private accounts, or platform restrictions. Many sites also prohibit downloading in their terms, so use it only where you have the right to do so.

## What It Does

- Paste a YouTube or Instagram video link into the extension side panel.
- The extension detects the platform from the link.
- Choose `MP4 video` or `MP3 audio`.
- Ask the local helper to save the file in the highest available free quality.
- Watch download progress in Chrome.
- Finished files are handed to Chrome Downloads.

For now, every other platform is blocked on purpose.

## Reliability Controls

The extension includes three helper tools for new devices:

- `Chrome profile`: choose the same Chrome profile where you are logged into YouTube or Instagram.
- `Run diagnostics`: checks helper connection, downloader engine, FFmpeg, Chrome profiles, cookies, and the pasted link.
- `Update helper`: updates the local downloader engine and helper files without reinstalling the extension.

If YouTube blocks a stream with `403`, try selecting the correct Chrome profile first, then run diagnostics. Some YouTube links may still be blocked by YouTube stream protection even when the helper is healthy.

## Mac Install

Simple way:

1. Unzip `video-link-downloader-mac.zip`.
2. Open `OPEN FIRST - Mac Setup.html`.
3. Click `Copy Mac Install Command`.
4. Open Terminal, paste it, and press Enter.
5. In Chrome, click `Load unpacked`.
6. Select the `extension` folder.

This avoids double-clicking a downloaded `.command` file, which is what triggers the Apple verification warning. A fully warning-free Mac installer requires Apple signing and notarization.

For a Mac package, use:

```bash
scripts/build-mac-package.sh
```

That creates:

```text
dist/video-link-downloader-mac.zip
```

The UI opens as a Chrome side panel. It stays inside Chrome while you click around.

## Windows Install

Simple way:

1. Unzip `video-link-downloader-windows.zip`.
2. Open `START HERE - Windows.bat`.
3. In Chrome, click `Load unpacked`.
4. Select the `extension` folder.

For a Windows package, use:

```bash
scripts/build-windows-package.sh
```

That creates:

```text
dist/video-link-downloader-windows.zip
```

The Windows installer uses your own computer for downloads. It installs/uses Node.js, Python, `yt-dlp`, and `ffmpeg`, then starts the helper automatically when Windows logs in.

## Helper

The Mac installer copies the helper to:

```text
~/Applications/Video Link Downloader Helper
```

The Windows installer copies the helper to:

```text
%LOCALAPPDATA%\Video Link Downloader Helper
```

The installer also starts the helper automatically when the computer logs in.

The helper runs at:

```text
http://localhost:8787
```

Downloaded files are temporarily created inside the helper, then sent to Chrome Downloads. The helper copy is cleaned up after Chrome takes the file.

## Local Development

This tested copy uses a local helper environment with:

- `yt-dlp`
- `ffmpeg` through `imageio-ffmpeg`
- `curl-cffi` for browser-style network requests

If you ever need to recreate the helper environment from scratch:

```bash
cd helper
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install --upgrade --pre yt-dlp
python -m pip install imageio-ffmpeg curl-cffi
```

## Start The Helper

From this folder:

```bash
cd helper
node server.mjs
```

## Load The Extension

1. Open Chrome or Edge.
2. Go to `chrome://extensions`.
3. Turn on `Developer mode`.
4. Click `Load unpacked`.
5. Select the `extension` folder in this project.

## Remove From Mac

Open:

```text
mac/uninstall-mac.command
```

## Remove From Windows

Open:

```text
windows/uninstall-windows.bat
```

## Notes

- The browser extension cannot download and convert everything by itself, so the local helper must stay open while downloading.
- MP4 highest quality often downloads separate video and audio streams, then merges them.
- MP3 conversion needs `ffmpeg`.
- Some YouTube or Instagram links may fail because the site blocks downloads, requires login, uses DRM, or does not provide downloadable media.
