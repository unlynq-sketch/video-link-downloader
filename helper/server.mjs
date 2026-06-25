import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.VLD_PORT || 8787);
const HOST = "localhost";
const HELPER_VERSION = "2026.06.24.1";
const REPO_RAW_BASE = "https://raw.githubusercontent.com/unlynq-sketch/video-link-downloader/main";
const appDir = dirname(fileURLToPath(import.meta.url));
const downloadsDir = join(appDir, "downloads");
const configPath = join(appDir, "config.json");
const isWindows = process.platform === "win32";
const localYtDlp = isWindows
  ? join(appDir, ".venv", "Scripts", "yt-dlp.exe")
  : join(appDir, ".venv", "bin", "yt-dlp");
const localPython = isWindows
  ? join(appDir, ".venv", "Scripts", "python.exe")
  : join(appDir, ".venv", "bin", "python");
const bundledNodeBin = join(
  process.env.HOME || "/Users/amanrana",
  ".cache",
  "codex-runtimes",
  "codex-primary-runtime",
  "dependencies",
  "node",
  "bin"
);
const jobs = new Map();
const children = new Map();
const EXTRACT_TIMEOUT_MS = 45_000;
const DEFAULT_CONFIG = {
  chromeProfile: ""
};
let updateState = {
  status: "idle",
  message: "Ready",
  updatedAt: ""
};

await mkdir(downloadsDir, { recursive: true });

async function readConfig() {
  try {
    return {
      ...DEFAULT_CONFIG,
      ...JSON.parse(await readFile(configPath, "utf8"))
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function writeConfig(config) {
  await writeFile(configPath, `${JSON.stringify({
    ...DEFAULT_CONFIG,
    ...config
  }, null, 2)}\n`, "utf8");
}

function findImageioFfmpeg() {
  const sitePackagesRoots = isWindows
    ? [join(appDir, ".venv", "Lib", "site-packages")]
    : ["python3.13", "python3.12", "python3.11", "python3.10", "python3.9"].map(version =>
      join(appDir, ".venv", "lib", version, "site-packages")
    );

  for (const root of sitePackagesRoots) {
    const binariesDir = join(root, "imageio_ffmpeg", "binaries");
    if (!existsSync(binariesDir)) continue;

    const binary = readdirSync(binariesDir).find(name =>
      isWindows
        ? /^ffmpeg.*\.exe$/i.test(name)
        : /^ffmpeg-/i.test(name)
    );
    if (binary) return join(binariesDir, binary);
  }

  return "ffmpeg";
}

const localFfmpeg = findImageioFfmpeg();

function chromeUserDataDir() {
  if (isWindows) {
    return join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
  }

  if (process.platform === "darwin") {
    return join(process.env.HOME || "", "Library", "Application Support", "Google", "Chrome");
  }

  return join(process.env.HOME || "", ".config", "google-chrome");
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function listChromeProfiles() {
  const root = chromeUserDataDir();
  const config = await readConfig();
  let lastUsed = "";

  try {
    const localState = await readJsonFile(join(root, "Local State"));
    lastUsed = localState.profile?.last_used || "";
  } catch {
    // Chrome may not be installed or may not have created Local State yet.
  }

  const profiles = [];
  if (!existsSync(root)) {
    return { root, selected: config.chromeProfile, profiles };
  }

  for (const id of readdirSync(root).filter(name => name === "Default" || /^Profile \d+$/.test(name)).sort()) {
    const prefsPath = join(root, id, "Preferences");
    const cookiesPath = join(root, id, "Cookies");
    let name = id;
    let signedIn = false;

    try {
      const prefs = await readJsonFile(prefsPath);
      name = prefs.profile?.name || id;
      signedIn = Boolean(prefs.account_info?.length);
    } catch {
      // Keep the folder id as the display name.
    }

    profiles.push({
      id,
      name,
      signedIn,
      hasCookies: existsSync(cookiesPath),
      isLastUsed: id === lastUsed,
      selected: id === config.chromeProfile
    });
  }

  return { root, selected: config.chromeProfile, profiles };
}

function chromeCookieSource(profile) {
  return profile ? `chrome:${profile}` : "chrome";
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true"
  });
  res.end(json);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": `VideoLinkDownloaderHelper/${HELPER_VERSION}`
    }
  });
  if (!response.ok) {
    throw new Error(`Could not download update file (${response.status}).`);
  }
  return response.text();
}

function sendFile(res, filePath, options = {}) {
  const safeDownloadsDir = resolve(downloadsDir);
  const safeFilePath = resolve(filePath);

  if (!safeFilePath.startsWith(`${safeDownloadsDir}/`) || !existsSync(safeFilePath)) {
    sendJson(res, 404, { error: "File not found." });
    return;
  }

  const fileName = basename(safeFilePath);
  const ext = fileName.split(".").pop()?.toLowerCase();
  const contentType = ext === "mp3"
    ? "audio/mpeg"
    : ext === "mp4"
      ? "video/mp4"
      : "application/octet-stream";

  const stream = createReadStream(safeFilePath);
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": statSync(safeFilePath).size,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "access-control-allow-origin": "*"
  });
  stream.pipe(res);

  if (options.cleanup) {
    stream.on("close", () => {
      unlink(safeFilePath).catch(() => {});
    });
  }
}

async function deleteJobFile(job) {
  if (!job?.file) return false;

  const safeDownloadsDir = resolve(downloadsDir);
  const safeFilePath = resolve(job.file);
  if (!safeFilePath.startsWith(`${safeDownloadsDir}/`) || !existsSync(safeFilePath)) {
    return false;
  }

  await unlink(safeFilePath);
  job.file = "";
  job.fileName = "";
  job.cleanedUp = true;
  return true;
}

async function runUpdateCommand(command, args) {
  return runProcess(command, args, {
    cwd: appDir,
    env: {
      ...process.env,
      PATH: existsSync(bundledNodeBin)
        ? `${bundledNodeBin}:${process.env.PATH || ""}`
        : process.env.PATH
    }
  });
}

async function updatePythonPackages() {
  if (!existsSync(localPython)) {
    throw new Error("Local Python engine is missing. Run the installer again.");
  }

  updateState.message = "Updating downloader engine...";
  await runUpdateCommand(localPython, ["-m", "pip", "install", "--upgrade", "pip"]);
  await runUpdateCommand(localPython, ["-m", "pip", "install", "--upgrade", "--pre", "yt-dlp"]);
  await runUpdateCommand(localPython, ["-m", "pip", "install", "--upgrade", "imageio-ffmpeg", "curl-cffi"]);
}

async function updateHelperFiles() {
  updateState.message = "Updating helper files...";
  const files = ["helper/server.mjs", "helper/package.json"];

  for (const file of files) {
    const targetPath = join(appDir, basename(file));
    const tempPath = `${targetPath}.update`;
    const text = await fetchText(`${REPO_RAW_BASE}/${file}`);
    await writeFile(tempPath, text, "utf8");
    await rename(tempPath, targetPath);
  }
}

function scheduleRestart() {
  updateState.message = "Restarting helper...";

  setTimeout(() => {
    if (process.platform === "darwin") {
      const child = spawn("zsh", [
        "-lc",
        `sleep 1; launchctl kickstart -k "gui/$(id -u)/com.amanrana.video-link-downloader-helper" >/dev/null 2>&1 || "${process.execPath}" "${join(appDir, "server.mjs")}"`
      ], {
        cwd: appDir,
        detached: true,
        stdio: "ignore"
      });
      child.unref();
      process.exit(0);
      return;
    }

    const child = spawn(process.execPath, [join(appDir, "server.mjs")], {
      cwd: appDir,
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    process.exit(0);
  }, 750);
}

async function updateHelper() {
  if (updateState.status === "running") {
    return updateState;
  }

  if (activeJob()) {
    throw new Error("Wait for the current download to finish before updating.");
  }

  updateState = {
    status: "running",
    message: "Starting update...",
    updatedAt: new Date().toISOString()
  };

  try {
    await updatePythonPackages();
    await updateHelperFiles();
    updateState = {
      status: "restarting",
      message: "Updated. Restarting helper...",
      updatedAt: new Date().toISOString()
    };
    scheduleRestart();
    return updateState;
  } catch (error) {
    updateState = {
      status: "failed",
      message: error.message,
      updatedAt: new Date().toISOString()
    };
    throw error;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function cleanMediaUrl(value) {
  const trimmed = String(value || "").trim();
  const firstUrlIndex = trimmed.search(/https?:\/\//i);
  if (firstUrlIndex < 0) return trimmed;

  const fromFirstUrl = trimmed.slice(firstUrlIndex).split(/\s/)[0];
  const secondUrlIndex = fromFirstUrl.slice(1).search(/https?:\/\//i);
  if (secondUrlIndex >= 0) {
    return fromFirstUrl.slice(0, secondUrlIndex + 1);
  }

  return fromFirstUrl;
}

function isHttpUrl(value) {
  try {
    const url = new URL(cleanMediaUrl(value));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function detectPlatform(value) {
  try {
    const url = new URL(cleanMediaUrl(value));
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) {
      return "youtube";
    }

    if (host === "instagram.com" || host.endsWith(".instagram.com")) {
      return "instagram";
    }

    return "";
  } catch {
    return "";
  }
}

function makeArgs({ url, format, platform, chromeProfile = "" }) {
  const suffix = format === "mp3" ? "audio" : "video";
  const outputTemplate = join(downloadsDir, `%(title).180B [%(id)s] ${suffix}.%(ext)s`);
  const common = [
    "--no-playlist",
    "--force-overwrites",
    "--restrict-filenames",
    "--newline",
    "--retries",
    "1",
    "--fragment-retries",
    "1",
    "--abort-on-unavailable-fragment",
    "--cookies-from-browser",
    chromeCookieSource(chromeProfile),
    "-o",
    outputTemplate
  ];

  if (existsSync(localFfmpeg)) {
    common.push("--ffmpeg-location", localFfmpeg);
  }

  if (format === "mp3") {
    return [
      ...common,
      "-f",
      platform === "youtube"
        ? "ba[protocol^=http]/b[ext=mp4][protocol^=http]/ba/best"
        : "ba/best",
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
      url
    ];
  }

  return [
    ...common,
    "-f",
    platform === "youtube"
      ? "bv*[ext=mp4][protocol^=http]+ba[ext=m4a][protocol^=http]/b[ext=mp4][protocol^=http]/bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/best"
      : "bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
    "--merge-output-format",
    "mp4",
    url
  ];
}

function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const { timeoutMs, ...spawnOptions } = options;
    const child = spawn(command, args, spawnOptions);
    let output = "";
    let timeout = null;

    if (timeoutMs) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Command timed out."));
      }, timeoutMs);
    }

    child.stdout?.on("data", chunk => {
      output += chunk.toString();
    });
    child.stderr?.on("data", chunk => {
      output += chunk.toString();
    });
    child.on("error", error => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", code => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) {
        resolvePromise(output);
      } else {
        reject(new Error(output.trim() || `${command} exited with code ${code}`));
      }
    });
  });
}

async function getYtDlpVersion() {
  if (!existsSync(localPython)) return "";
  try {
    return (await runProcess(localPython, ["-m", "yt_dlp", "--version"], {
      cwd: appDir,
      timeoutMs: 10_000
    })).trim();
  } catch {
    return "";
  }
}

async function runDiagnostics(url = "") {
  const config = await readConfig();
  const profileInfo = await listChromeProfiles();
  const diagnostics = {
    ok: true,
    helperVersion: HELPER_VERSION,
    node: process.version,
    platform: process.platform,
    chromeProfile: config.chromeProfile,
    chromeProfiles: profileInfo.profiles,
    checks: []
  };

  const addCheck = (name, ok, message) => {
    diagnostics.checks.push({ name, ok, message });
    if (!ok) diagnostics.ok = false;
  };

  addCheck("Helper", true, "Helper is running.");
  addCheck("Python engine", existsSync(localPython), existsSync(localPython) ? "Installed." : "Missing. Run installer again.");
  addCheck("FFmpeg", existsSync(localFfmpeg), existsSync(localFfmpeg) ? "Installed." : "Missing. Run installer again.");
  addCheck("Chrome profiles", profileInfo.profiles.length > 0, profileInfo.profiles.length ? `${profileInfo.profiles.length} profile(s) found.` : "No Chrome profiles found.");

  if (config.chromeProfile) {
    const selected = profileInfo.profiles.find(profile => profile.id === config.chromeProfile);
    addCheck("Selected Chrome profile", Boolean(selected), selected ? `${selected.name} selected.` : "Selected profile no longer exists.");
    if (selected) {
      addCheck("Profile cookies", selected.hasCookies, selected.hasCookies ? "Cookie database found." : "No cookie database found for selected profile.");
    }
  } else {
    addCheck("Selected Chrome profile", false, "No profile selected. Choose the Chrome profile you use for YouTube/Instagram.");
  }

  const ytDlpVersion = await getYtDlpVersion();
  diagnostics.ytDlpVersion = ytDlpVersion;
  addCheck("Downloader engine", Boolean(ytDlpVersion), ytDlpVersion ? `yt-dlp ${ytDlpVersion}` : "yt-dlp missing. Click Update helper or run installer.");

  const cleanedUrl = cleanMediaUrl(url);
  if (cleanedUrl) {
    const platform = detectPlatform(cleanedUrl);
    diagnostics.url = cleanedUrl;
    diagnostics.urlPlatform = platform;
    addCheck("Link support", Boolean(platform), platform ? `${platform} link detected.` : "Only YouTube and Instagram links are supported.");

    if (platform && existsSync(localPython)) {
      try {
        const output = await runProcess(localPython, [
          "-m",
          "yt_dlp",
          "--simulate",
          "--no-playlist",
          "--cookies-from-browser",
          chromeCookieSource(config.chromeProfile),
          "--print",
          "%(extractor)s:%(id)s",
          cleanedUrl
        ], {
          cwd: appDir,
          timeoutMs: 35_000,
          env: {
            ...process.env,
            PATH: existsSync(bundledNodeBin)
              ? `${bundledNodeBin}:${process.env.PATH || ""}`
              : process.env.PATH
          }
        });
        addCheck("Link extraction", true, output.trim().split(/\r?\n/).pop() || "Link can be read.");
      } catch (error) {
        addCheck("Link extraction", false, humanError({ text: error.message, platform }));
      }
    }
  }

  return diagnostics;
}

async function makeQuickTimeCompatible(job) {
  if (job.platform !== "instagram" || job.format !== "mp4" || !job.file || !existsSync(job.file) || !existsSync(localFfmpeg)) {
    return;
  }

  const originalFile = job.file;
  const compatibleFile = originalFile.replace(/\.mp4$/i, ".quicktime.mp4");
  if (compatibleFile === originalFile) return;

  job.progress = "Making Instagram MP4 compatible with QuickTime...";
  job.progressPercent = Math.max(job.progressPercent || 0, 98);
  job.eta = "Finishing";

  await runProcess(localFfmpeg, [
    "-y",
    "-i",
    originalFile,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    compatibleFile
  ], { cwd: appDir, stdio: ["ignore", "pipe", "pipe"] });

  await unlink(originalFile).catch(() => {});
  await rename(compatibleFile, originalFile);
  job.file = originalFile;
  job.fileName = basename(originalFile);
}

function humanError({ text, platform }) {
  const lower = text.toLowerCase();

  if (lower.includes("timed out before the download started")) {
    return "YouTube is taking too long to respond. Try again in a minute, or open the video in Chrome first.";
  }

  if (
    platform === "youtube" &&
    (
      lower.includes("http error 403") ||
      lower.includes("forbidden") ||
      lower.includes("fragment") ||
      lower.includes("unable to continue")
    )
  ) {
    return "YouTube blocked this stream. Open the video in Chrome, make sure you are logged in, then retry. If it still fails, this link is currently blocked by YouTube.";
  }

  if (platform === "youtube" && lower.includes("sign in to confirm")) {
    return "YouTube needs your signed-in Chrome session for this video. Log into YouTube in Chrome, then retry.";
  }

  if (platform === "instagram" && (lower.includes("login") || lower.includes("private") || lower.includes("not available"))) {
    return "Instagram blocked this link or it needs login/private access. Open it in Chrome first, make sure you can view it, then retry.";
  }

  if (lower.includes("cookies") && lower.includes("chrome")) {
    return "Could not read Chrome cookies. Keep Chrome open and unlocked, then retry.";
  }

  return text;
}

function updateProgress(job, text) {
  const percentMatch = text.match(/\[download\]\s+([\d.]+)%\s+of\s+(.+?)\s+at\s+(.+?)\s+ETA\s+([0-9:]+)/);

  if (percentMatch) {
    job.progressPercent = Number(percentMatch[1]);
    job.totalSize = percentMatch[2].trim();
    job.speed = percentMatch[3].trim();
    job.eta = percentMatch[4].trim();
    return;
  }

  if (text.includes("[Merger]") || text.includes("[ExtractAudio]")) {
    job.progressPercent = Math.max(job.progressPercent || 0, 98);
    job.eta = "Finishing";
  }
}

function startJob({ url, format, platform, chromeProfile = "" }) {
  const id = randomUUID();
  const job = {
    id,
    platform,
    status: "running",
    progress: "",
    progressPercent: 0,
    totalSize: "",
    speed: "",
    eta: "",
    format,
    file: "",
    fileName: "",
    error: "",
    createdAt: new Date().toISOString()
  };
  jobs.set(id, job);

  const usesLocalPython = existsSync(localPython);
  const ytDlpCommand = usesLocalPython ? localPython : existsSync(localYtDlp) ? localYtDlp : "yt-dlp";
  const ytDlpArgs = usesLocalPython
    ? ["-m", "yt_dlp", ...makeArgs({ url, format, platform, chromeProfile })]
    : makeArgs({ url, format, platform, chromeProfile });
  const child = spawn(ytDlpCommand, ytDlpArgs, {
    cwd: appDir,
    env: {
      ...process.env,
      PATH: existsSync(bundledNodeBin)
        ? `${bundledNodeBin}:${process.env.PATH || ""}`
        : process.env.PATH
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.set(id, child);

  const extractTimer = setTimeout(() => {
    if (job.status !== "running" || job.progressPercent > 0) return;
    job.status = "failed";
    job.error = humanError({
      text: "Timed out before the download started.",
      platform
    });
    job.progress = job.error;
    child.kill("SIGTERM");
  }, EXTRACT_TIMEOUT_MS);

  const handleLine = line => {
    const text = line.toString().trim();
    if (!text) return;

    job.progress = text;
    updateProgress(job, text);
    if (job.progressPercent > 0) {
      clearTimeout(extractTimer);
    }

    const destination = text.match(/\[download\] Destination: (.+)$/);
    const merged = text.match(/\[Merger\] Merging formats into "(.+)"$/);
    const extracted = text.match(/\[ExtractAudio\] Destination: (.+)$/);
    if (destination) job.file = destination[1];
    if (merged) job.file = merged[1];
    if (extracted) job.file = extracted[1];
    if (job.file) job.fileName = basename(job.file);
  };

  child.stdout.on("data", chunk => {
    for (const line of chunk.toString().split(/\r?\n/)) handleLine(line);
  });

  child.stderr.on("data", chunk => {
    for (const line of chunk.toString().split(/\r?\n/)) handleLine(line);
  });

  child.on("error", error => {
    clearTimeout(extractTimer);
    children.delete(id);
    job.status = "failed";
    job.error = error.code === "ENOENT"
      ? "The local downloader engine is not installed. Run the Mac installer again."
      : error.message;
  });

  child.on("close", async code => {
    clearTimeout(extractTimer);
    children.delete(id);
    if (job.status === "failed") return;
    if (code === 0) {
      try {
        await makeQuickTimeCompatible(job);
        job.status = "complete";
        job.progress = "Done";
        job.progressPercent = 100;
        job.eta = "Done";
        if (job.file) job.fileName = basename(job.file);
      } catch (error) {
        job.status = "failed";
        job.error = `Instagram downloaded, but MP4 compatibility conversion failed: ${error.message}`;
      }
    } else {
      job.status = "failed";
      job.error = humanError({
        text: job.progress || `yt-dlp exited with code ${code}`,
        platform
      });
    }
  });

  return job;
}

function activeJob() {
  for (const job of jobs.values()) {
    if (job.status === "running") return job;
  }
  return null;
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return null;

  const child = children.get(id);
  if (child) {
    child.kill("SIGTERM");
    children.delete(id);
  }

  if (job.status === "running") {
    job.status = "failed";
    job.error = "Cancelled.";
    job.progress = "Cancelled.";
  }
  return job;
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === "OPTIONS") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && req.url === "/api/health") {
    const config = await readConfig();
    sendJson(res, 200, {
      ok: true,
      version: HELPER_VERSION,
      chromeProfile: config.chromeProfile
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/profiles") {
    sendJson(res, 200, await listChromeProfiles());
    return;
  }

  if (req.method === "POST" && req.url === "/api/profile") {
    try {
      const body = JSON.parse(await readBody(req));
      const profileId = String(body.profile || "").trim();
      const profileInfo = await listChromeProfiles();

      if (profileId && !profileInfo.profiles.some(profile => profile.id === profileId)) {
        sendJson(res, 400, { error: "Selected Chrome profile was not found." });
        return;
      }

      await writeConfig({ chromeProfile: profileId });
      sendJson(res, 200, {
        ok: true,
        selected: profileId
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/diagnostics") {
    try {
      sendJson(res, 200, await runDiagnostics(requestUrl.searchParams.get("url") || ""));
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message
      });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/update") {
    sendJson(res, 200, updateState);
    return;
  }

  if (req.method === "POST" && req.url === "/api/update") {
    try {
      const state = await updateHelper();
      sendJson(res, 202, state);
    } catch (error) {
      sendJson(res, 400, {
        status: "failed",
        message: error.message
      });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/active") {
    sendJson(res, 200, { job: activeJob() });
    return;
  }

  if (req.method === "POST" && req.url === "/api/download") {
    try {
      const body = JSON.parse(await readBody(req));
      const url = cleanMediaUrl(body.url);
      const format = body.format === "mp3" ? "mp3" : "mp4";
      const hasRights = body.hasRights === true;

      if (!hasRights) {
        sendJson(res, 400, { error: "Confirm you have rights or permission to download this media." });
        return;
      }

      if (!isHttpUrl(url)) {
        sendJson(res, 400, { error: "Paste a valid http or https link." });
        return;
      }

      const platform = detectPlatform(url);
      if (!platform) {
        sendJson(res, 400, { error: "Only YouTube and Instagram video links are supported right now." });
        return;
      }

      const running = activeJob();
      if (running) {
        sendJson(res, 409, {
          error: "A download is already running. Wait for it to finish before starting another one.",
          job: running
        });
        return;
      }

      const config = await readConfig();
      const job = startJob({
        url,
        format,
        platform,
        chromeProfile: config.chromeProfile
      });
      sendJson(res, 202, { ...job, platform });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  const fileMatch = requestUrl.pathname.match(/^\/api\/jobs\/([^/]+)\/file$/);
  if (req.method === "GET" && fileMatch) {
    const id = decodeURIComponent(fileMatch[1]);
    const job = jobs.get(id);
    if (!job) {
      sendJson(res, 404, { error: "Job not found." });
      return;
    }
    if (job.status !== "complete" || !job.file) {
      sendJson(res, 409, { error: "File is not ready yet." });
      return;
    }
    sendFile(res, job.file, {
      cleanup: requestUrl.searchParams.get("cleanup") === "1"
    });
    return;
  }

  const cleanupMatch = requestUrl.pathname.match(/^\/api\/jobs\/([^/]+)\/cleanup$/);
  if ((req.method === "POST" || req.method === "DELETE") && cleanupMatch) {
    const id = decodeURIComponent(cleanupMatch[1]);
    const job = jobs.get(id);
    if (!job) {
      sendJson(res, 404, { error: "Job not found." });
      return;
    }

    try {
      const removed = await deleteJobFile(job);
      sendJson(res, 200, { ok: true, removed });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  const cancelMatch = requestUrl.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if ((req.method === "POST" || req.method === "DELETE") && cancelMatch) {
    const id = decodeURIComponent(cancelMatch[1]);
    const job = cancelJob(id);
    if (!job) {
      sendJson(res, 404, { error: "Job not found." });
      return;
    }
    sendJson(res, 200, job);
    return;
  }

  if (req.method === "GET" && requestUrl.pathname.startsWith("/api/jobs/")) {
    const id = decodeURIComponent(requestUrl.pathname.slice("/api/jobs/".length));
    const job = jobs.get(id);
    if (!job) {
      sendJson(res, 404, { error: "Job not found." });
      return;
    }
    sendJson(res, 200, job);
    return;
  }

  sendJson(res, 404, { error: "Not found." });
});

server.listen(PORT, HOST, () => {
  console.log(`Video downloader helper running at http://${HOST}:${PORT}`);
  console.log(`Downloads folder: ${downloadsDir}`);
});
