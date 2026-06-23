import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = 8787;
const HOST = "localhost";
const appDir = dirname(fileURLToPath(import.meta.url));
const downloadsDir = join(appDir, "downloads");
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

await mkdir(downloadsDir, { recursive: true });

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

function makeArgs({ url, format, platform }) {
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
    "chrome",
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
    const child = spawn(command, args, options);
    let output = "";

    child.stdout?.on("data", chunk => {
      output += chunk.toString();
    });
    child.stderr?.on("data", chunk => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) {
        resolvePromise(output);
      } else {
        reject(new Error(output.trim() || `${command} exited with code ${code}`));
      }
    });
  });
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

function startJob({ url, format, platform }) {
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
    ? ["-m", "yt_dlp", ...makeArgs({ url, format, platform })]
    : makeArgs({ url, format, platform });
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
    sendJson(res, 200, { ok: true });
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

      const job = startJob({ url, format, platform });
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
