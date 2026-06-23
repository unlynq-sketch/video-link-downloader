const API = "http://localhost:8787";

const urlInput = document.querySelector("#url");
const downloadButton = document.querySelector("#download");
const clearButton = document.querySelector("#clear");
const helperStatus = document.querySelector("#helperStatus");
const platformLabel = document.querySelector("#platform");
const state = document.querySelector("#state");
const details = document.querySelector("#details");
const progressBar = document.querySelector("#progressBar");
const meta = document.querySelector("#meta");
const activeJobKey = "videoLinkDownloader.activeJob";

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

function detectPlatform(value) {
  try {
    const url = new URL(cleanMediaUrl(value));
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) {
      return "YouTube";
    }

    if (host === "instagram.com" || host.endsWith(".instagram.com")) {
      return "Instagram";
    }

    return "";
  } catch {
    return "";
  }
}

function selectedFormat() {
  return document.querySelector('input[name="format"]:checked')?.value || "mp4";
}

function setProgress(value = 0) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  progressBar.style.width = `${percent}%`;
}

function formatJobMeta(job) {
  const parts = [];
  if (Number.isFinite(job.progressPercent) && job.progressPercent > 0) {
    parts.push(`${Math.round(job.progressPercent)}%`);
  }
  if (job.totalSize) parts.push(job.totalSize);
  if (job.speed) parts.push(job.speed);
  if (job.eta) parts.push(`ETA ${job.eta}`);
  return parts.join(" • ");
}

function cleanProgressText(value) {
  return String(value || "Working...")
    .replace(/^\[download\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function setStatus(title, message, options = {}) {
  state.textContent = title;
  details.textContent = message;
  meta.textContent = options.meta || "";
  setProgress(options.progress || 0);
}

function clearActiveJob() {
  localStorage.removeItem(activeJobKey);
}

function resetPanelStatus() {
  clearActiveJob();
  downloadButton.disabled = false;
  setStatus("Ready", "Paste a YouTube or Instagram video link, choose a format, then start the download.");
}

function sendToChromeDownloads(job) {
  if (!job.fileName) return false;

  const link = document.createElement("a");
  link.href = `${API}/api/jobs/${encodeURIComponent(job.id)}/file?cleanup=1`;
  link.download = job.fileName;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  return true;
}

async function checkHelper() {
  try {
    const response = await fetch(`${API}/api/health`);
    if (!response.ok) throw new Error("Helper unavailable");
    helperStatus.textContent = "Helper connected";
  } catch {
    helperStatus.textContent = "Start the local helper before downloading";
  }
}

function resetLinkInput() {
  urlInput.value = "";
  urlInput.setAttribute("value", "");
}

function updatePlatform() {
  const url = cleanMediaUrl(urlInput.value);
  const platform = detectPlatform(url);
  platformLabel.textContent = platform || (urlInput.value.trim() ? "Unsupported link" : "Waiting for link");
}

async function pollJob(id) {
  const response = await fetch(`${API}/api/jobs/${encodeURIComponent(id)}`);
  const job = await response.json();

  if (!response.ok) {
    clearActiveJob();
    throw new Error(job.error || "Could not read job status.");
  }

  if (job.status === "complete") {
    clearActiveJob();
    setStatus("Complete", "Download finished. Sending it to Chrome Downloads...", {
      progress: 100,
      meta: job.fileName || "Finished"
    });
    const sentToChrome = sendToChromeDownloads(job);
    setStatus(
      "Complete",
      sentToChrome
        ? `Chrome download started: ${job.fileName || "download"}`
        : "Download finished, but the file name was missing.",
      {
        progress: 100,
        meta: sentToChrome ? "Chrome Downloads" : "Needs retry"
      }
    );
    downloadButton.disabled = false;
    return;
  }

  if (job.status === "failed") {
    clearActiveJob();
    setStatus("Failed", job.error || "Download failed.", {
      progress: job.progressPercent || 0
    });
    downloadButton.disabled = false;
    return;
  }

  setStatus("Downloading", cleanProgressText(job.progress || "Starting..."), {
    progress: job.progressPercent || 0,
    meta: formatJobMeta(job)
  });
  setTimeout(() => pollJob(id).catch(error => {
    clearActiveJob();
    setStatus("Failed", error.message);
    downloadButton.disabled = false;
  }), 1000);
}

async function restoreActiveJob() {
  const savedJob = localStorage.getItem(activeJobKey);
  if (savedJob) {
    downloadButton.disabled = true;
    setStatus("Reconnecting", "Restoring the active download...", { progress: 4 });
    pollJob(savedJob).catch(error => {
      clearActiveJob();
      setStatus("Ready", "Old download cleared. Paste a link to start again.", {
        progress: 0,
        meta: error.message
      });
      downloadButton.disabled = false;
    });
    return;
  }

  try {
    const response = await fetch(`${API}/api/active`);
    const { job } = await response.json();
    if (!response.ok || !job?.id) return;

    localStorage.setItem(activeJobKey, job.id);
    downloadButton.disabled = true;
    setStatus("Reconnecting", "Restoring the active download...", {
      progress: job.progressPercent || 4,
      meta: formatJobMeta(job)
    });
    pollJob(job.id);
  } catch {
    clearActiveJob();
  }
}

downloadButton.addEventListener("click", async () => {
  const url = cleanMediaUrl(urlInput.value);
  const platform = detectPlatform(url);

  if (!url) {
    setStatus("Missing link", "Paste a media link first.");
    return;
  }

  if (!platform) {
    setStatus("Unsupported link", "For now this extension only accepts YouTube and Instagram video links.");
    return;
  }

  downloadButton.disabled = true;
  setStatus("Starting", "Sending the link to the local helper...", { progress: 2 });

  try {
    const response = await fetch(`${API}/api/download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        format: selectedFormat(),
        hasRights: true
      })
    });

    const job = await response.json();
    if (response.status === 409 && job.job?.id) {
      localStorage.setItem(activeJobKey, job.job.id);
      setStatus("Already running", "Reconnected to the active download.", {
        progress: job.job.progressPercent || 4,
        meta: formatJobMeta(job.job)
      });
      pollJob(job.job.id);
      return;
    }
    if (!response.ok) throw new Error(job.error || "Download could not start.");

    localStorage.setItem(activeJobKey, job.id);
    setStatus("Queued", `Preparing highest available ${selectedFormat().toUpperCase()} from ${platform}...`, {
      progress: 4,
      meta: platform
    });
    pollJob(job.id);
  } catch (error) {
    clearActiveJob();
    setStatus("Could not start", error.message);
    downloadButton.disabled = false;
  }
});

urlInput.addEventListener("input", updatePlatform);
clearButton.addEventListener("click", () => {
  resetLinkInput();
  updatePlatform();
  resetPanelStatus();
});

checkHelper();
resetLinkInput();
updatePlatform();
restoreActiveJob();
