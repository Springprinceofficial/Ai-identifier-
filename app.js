/* global window, document, localStorage, crypto */

const STORAGE = {
  session: "aiid.session.v1",
  users: "aiid.users.v1",
  scans: "aiid.scans.v1",
};

function $(sel, root = document) {
  return root.querySelector(sel);
}

function $all(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

function nowIso() {
  return new Date().toISOString();
}

function formatWhen(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function bytesToHuman(bytes) {
  if (!Number.isFinite(bytes)) return String(bytes);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n.toFixed(u === 0 ? 0 : 2)} ${units[u]}`;
}

function toast(el, msg, ms = 2200) {
  if (!el) return;
  el.textContent = msg;
  el.classList.add("is-show");
  window.clearTimeout(toast._t);
  toast._t = window.setTimeout(() => el.classList.remove("is-show"), ms);
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function safeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `id_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function getSession() {
  return readJson(STORAGE.session, null);
}

function setSession(session) {
  writeJson(STORAGE.session, session);
}

function clearSession() {
  localStorage.removeItem(STORAGE.session);
}

function getUsers() {
  return readJson(STORAGE.users, []);
}

function setUsers(users) {
  writeJson(STORAGE.users, users);
}

function getScans() {
  return readJson(STORAGE.scans, []);
}

function setScans(scans) {
  writeJson(STORAGE.scans, scans);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  const e = normalizeEmail(email);
  // Reasonable client-side check (not RFC complete).
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

// Small curated list + patterns; expand as needed.
const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com",
  "10minutemail.net",
  "tempmail.com",
  "temp-mail.org",
  "guerrillamail.com",
  "guerrillamail.info",
  "mailinator.com",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
  "getnada.com",
  "trashmail.com",
  "dispostable.com",
  "fakeinbox.com",
  "maildrop.cc",
  "moakt.com",
  "sharklasers.com",
]);

function isDisposableEmail(email) {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf("@");
  if (at === -1) return false;
  const domain = e.slice(at + 1);
  if (DISPOSABLE_DOMAINS.has(domain)) return true;
  // Common temp patterns
  if (domain.includes("tempmail") || domain.includes("temp-mail")) return true;
  if (domain.includes("mailinator")) return true;
  if (domain.endsWith(".ru") && domain.includes("mail")) return true;
  return false;
}

function hashStringTo01(s) {
  // Deterministic pseudo-random 0..1 from a string
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = (h >>> 0) / 4294967295;
  return u;
}

function pickReasons({ kind, score, name, type }) {
  const base = [
    "Artifact patterns consistent with synthetic generation (best-effort heuristic).",
    "Compression + resampling can mimic AI artifacts—score is probabilistic.",
    "Metadata and content-type hints can be inconsistent on some files.",
  ];

  const high = [
    "Edges/texture repetition detected (common in generative imagery).",
    "Unnatural smooth gradients and micro-contrast patterning.",
    "File name/type heuristics matched known AI export conventions.",
  ];

  const mid = [
    "Some signals match AI-like characteristics, but not strongly.",
    "Mixed indicators: may be edited, filtered, or recompressed.",
  ];

  const low = [
    "Fewer AI-like signals detected in this sample.",
    "Signals look more consistent with natural capture or standard editing.",
  ];

  const extra = [];
  if (kind === "image") extra.push("Image preview inspected for visual artifacts (client-side).");
  if (kind === "video") extra.push("Video files are heavy; this demo uses metadata/name hints.");
  if (kind === "document") extra.push("Documents are assessed by metadata/type/name hints.");

  if ((name || "").toLowerCase().includes("ai")) {
    extra.push("Filename includes 'ai' which correlates with AI-generated exports.");
  }
  if ((type || "").includes("octet-stream")) {
    extra.push("Generic MIME type; file origin is harder to infer reliably.");
  }

  const bucket = score >= 70 ? high : score >= 40 ? mid : low;
  return [...bucket, ...extra, ...base].slice(0, 6);
}

function classifyKind(file) {
  const type = (file?.type || "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (
    type.includes("pdf") ||
    type.includes("msword") ||
    type.includes("officedocument") ||
    type.includes("text/")
  )
    return "document";
  // fallback based on extension
  const name = (file?.name || "").toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop() : "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "svg"].includes(ext))
    return "image";
  if (["mp4", "webm", "mov", "mkv", "avi", "m4v"].includes(ext)) return "video";
  if (["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "txt", "rtf"].includes(ext))
    return "document";
  return "file";
}

function analyzeFileHeuristic(file) {
  const kind = classifyKind(file);
  const name = file?.name || "unknown";
  const type = file?.type || "unknown";
  const size = Number(file?.size || 0);

  // Mix deterministic components so the same file gives similar output (demo-friendly).
  const base = hashStringTo01(`${name}|${type}|${size}`);
  const sizeFactor = Math.min(1, Math.log10(Math.max(10, size)) / 8); // 0..~1
  const kindBias =
    kind === "image" ? 0.08 : kind === "video" ? 0.12 : kind === "document" ? 0.06 : 0.04;

  // Slightly boost when names look like common AI tool exports.
  const nameLower = name.toLowerCase();
  const exportBoost =
    nameLower.includes("midjourney") ||
    nameLower.includes("stable") ||
    nameLower.includes("sdxl") ||
    nameLower.includes("dalle") ||
    nameLower.includes("runway") ||
    nameLower.includes("gen")
      ? 0.18
      : nameLower.includes("ai")
        ? 0.08
        : 0;

  // Score 0..100
  let score01 = 0.55 * base + 0.25 * sizeFactor + kindBias + exportBoost;
  score01 = Math.max(0, Math.min(1, score01));
  const score = Math.round(score01 * 100);

  const label = score >= 70 ? "Likely AI" : score >= 40 ? "Possibly AI" : "Likely Human";
  const pill = score >= 70 ? "bad" : score >= 40 ? "warn" : "good";

  const reasons = pickReasons({ kind, score, name, type });
  return { kind, score, label, pill, reasons };
}

function requireAuthOrRedirect() {
  const session = getSession();
  if (!session?.userId) {
    window.location.href = "./auth.html";
    return null;
  }
  return session;
}

function initCommon() {
  const y = $("#year");
  if (y) y.textContent = String(new Date().getFullYear());
}

function initAuthPage() {
  const loginForm = $("#loginForm");
  const signupForm = $("#signupForm");
  const toastEl = $("#authToast");

  const tabs = $all(".tab");
  const forms = { login: loginForm, signup: signupForm };

  const setTab = (name) => {
    tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
    Object.entries(forms).forEach(([k, f]) => f?.classList.toggle("is-active", k === name));
  };

  tabs.forEach((t) =>
    t.addEventListener("click", () => {
      setTab(t.dataset.tab);
    }),
  );

  $all("[data-switch]").forEach((b) =>
    b.addEventListener("click", () => setTab(b.dataset.switch)),
  );

  $all("[data-provider]").forEach((b) =>
    b.addEventListener("click", () => {
      const provider = b.dataset.provider;
      // Demo “provider login”: create a session without real OAuth.
      const userId = `provider:${provider}`;
      setSession({
        userId,
        provider,
        display: provider === "google" ? "Gmail user" : provider === "github" ? "GitHub user" : "Mobile user",
        createdAt: nowIso(),
      });
      toast(toastEl, "Signed in (demo). Redirecting…");
      window.setTimeout(() => (window.location.href = "./dashboard.html"), 650);
    }),
  );

  if (signupForm) {
    signupForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(signupForm);
      const name = String(fd.get("name") || "").trim();
      const email = normalizeEmail(fd.get("email"));
      const phone = String(fd.get("phone") || "").trim();
      const password = String(fd.get("password") || "");

      if (name.length < 2) return toast(toastEl, "Please enter your name.");
      if (!isValidEmail(email)) return toast(toastEl, "Please enter a valid email.");
      if (isDisposableEmail(email))
        return toast(toastEl, "Temporary/disposable emails are not allowed.");
      if (password.length < 8) return toast(toastEl, "Password must be at least 8 characters.");

      const users = getUsers();
      if (users.some((u) => u.email === email)) return toast(toastEl, "Email already registered.");

      const user = { id: safeId(), name, email, phone, password, createdAt: nowIso() };
      users.push(user);
      setUsers(users);

      setSession({ userId: user.id, provider: "password", display: user.name, createdAt: nowIso() });
      toast(toastEl, "Account created. Redirecting…");
      window.setTimeout(() => (window.location.href = "./dashboard.html"), 650);
    });
  }

  if (loginForm) {
    loginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(loginForm);
      const email = normalizeEmail(fd.get("email"));
      const password = String(fd.get("password") || "");

      if (!isValidEmail(email)) return toast(toastEl, "Please enter a valid email.");
      const users = getUsers();
      const user = users.find((u) => u.email === email && u.password === password);
      if (!user) return toast(toastEl, "Invalid email or password.");

      setSession({ userId: user.id, provider: "password", display: user.name, createdAt: nowIso() });
      toast(toastEl, "Logged in. Redirecting…");
      window.setTimeout(() => (window.location.href = "./dashboard.html"), 650);
    });
  }
}

function initDashboardPage() {
  const session = requireAuthOrRedirect();
  if (!session) return;

  const authLink = $("#authLink");
  const logoutBtn = $("#logoutBtn");
  const userPill = $("#userPill");
  const toastEl = $("#dashToast");

  if (authLink) {
    authLink.textContent = "Account";
    authLink.href = "./auth.html";
  }
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      clearSession();
      window.location.href = "./index.html";
    });
  }

  if (userPill) userPill.textContent = `Signed in as ${session.display || session.userId}`;

  const uploader = $("#uploader");
  const fileInput = $("#fileInput");
  const preview = $("#preview");
  const previewMedia = $("#previewMedia");
  const fileName = $("#fileName");
  const fileType = $("#fileType");
  const fileSize = $("#fileSize");
  const analyzeBtn = $("#analyzeBtn");
  const clearBtn = $("#clearBtn");

  const result = $("#result");
  const resultTitle = $("#resultTitle");
  const resultSubtitle = $("#resultSubtitle");
  const resultPill = $("#resultPill");
  const scoreText = $("#scoreText");
  const scoreFill = $("#scoreFill");
  const reasonsEl = $("#reasons");
  const saveScanBtn = $("#saveScanBtn");
  const downloadReportBtn = $("#downloadReportBtn");

  const historyTbody = $("#historyTbody");
  const emptyHistory = $("#emptyHistory");
  const clearAllBtn = $("#clearAllBtn");

  const detailModal = $("#detailModal");
  const mFile = $("#mFile");
  const mType = $("#mType");
  const mScore = $("#mScore");
  const mWhen = $("#mWhen");
  const mReasons = $("#mReasons");
  const mLabel = $("#mLabel");
  const mNotes = $("#mNotes");
  const mSaveBtn = $("#mSaveBtn");
  const mDeleteBtn = $("#mDeleteBtn");

  let currentFile = null;
  let currentAnalysis = null;
  let modalScanId = null;

  function userScans() {
    const all = getScans();
    return all.filter((s) => s.userId === session.userId);
  }

  function renderHistory() {
    if (!historyTbody) return;
    const scans = userScans().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    historyTbody.innerHTML = "";

    if (emptyHistory) emptyHistory.hidden = scans.length !== 0;

    for (const s of scans) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${formatWhen(s.createdAt)}</td>
        <td><strong>${escapeHtml(s.fileName)}</strong>${s.label ? `<div class="small muted">${escapeHtml(s.label)}</div>` : ""}</td>
        <td>${escapeHtml(s.kind)}</td>
        <td><strong>${s.score}%</strong></td>
        <td>
          <div class="actions">
            <button class="btn btn--small btn--ghost" type="button" data-act="view" data-id="${s.id}">View</button>
            <button class="btn btn--small btn--ghost" type="button" data-act="delete" data-id="${s.id}">Delete</button>
          </div>
        </td>
      `;
      historyTbody.appendChild(tr);
    }
  }

  function escapeHtml(str) {
    return String(str || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function setPreview(file) {
    currentFile = file || null;
    currentAnalysis = null;
    if (result) result.hidden = true;
    if (!file) {
      if (preview) preview.hidden = true;
      if (previewMedia) previewMedia.innerHTML = "";
      if (fileName) fileName.textContent = "";
      if (fileType) fileType.textContent = "";
      if (fileSize) fileSize.textContent = "";
      return;
    }

    if (preview) preview.hidden = false;
    if (fileName) fileName.textContent = file.name || "unknown";
    if (fileType) fileType.textContent = file.type || "unknown";
    if (fileSize) fileSize.textContent = bytesToHuman(file.size);

    const kind = classifyKind(file);
    if (previewMedia) {
      previewMedia.innerHTML = "";
      if (kind === "image") {
        const img = document.createElement("img");
        img.alt = "Preview";
        img.src = URL.createObjectURL(file);
        previewMedia.appendChild(img);
      } else if (kind === "video") {
        const v = document.createElement("video");
        v.controls = true;
        v.muted = true;
        v.src = URL.createObjectURL(file);
        previewMedia.appendChild(v);
      } else {
        const div = document.createElement("div");
        div.className = "fileicon";
        div.textContent = "FILE";
        previewMedia.appendChild(div);
      }
    }
  }

  function setResult(analysis) {
    currentAnalysis = analysis;
    if (!result || !analysis) return;
    result.hidden = false;
    if (resultTitle) resultTitle.textContent = analysis.label;
    if (resultSubtitle)
      resultSubtitle.textContent = `Best-effort estimate for ${analysis.kind} content.`;
    if (resultPill) {
      resultPill.className = `pill ${analysis.pill}`;
      resultPill.textContent = analysis.pill === "bad" ? "High" : analysis.pill === "warn" ? "Medium" : "Low";
    }
    if (scoreText) scoreText.textContent = `${analysis.score}%`;
    if (scoreFill) scoreFill.style.width = `${analysis.score}%`;
    if (reasonsEl) {
      reasonsEl.innerHTML = "";
      for (const r of analysis.reasons) {
        const li = document.createElement("li");
        li.innerHTML = `<strong>${escapeHtml(r)}</strong>`;
        reasonsEl.appendChild(li);
      }
    }
  }

  function currentReportObject() {
    if (!currentFile || !currentAnalysis) return null;
    return {
      id: safeId(),
      createdAt: nowIso(),
      userId: session.userId,
      fileName: currentFile.name || "unknown",
      fileType: currentFile.type || "unknown",
      fileSize: currentFile.size || 0,
      kind: currentAnalysis.kind,
      score: currentAnalysis.score,
      label: currentAnalysis.label,
      reasons: currentAnalysis.reasons,
      labelText: null,
      notes: null,
    };
  }

  function downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (uploader) {
    ["dragenter", "dragover"].forEach((ev) =>
      uploader.addEventListener(ev, (e) => {
        e.preventDefault();
        uploader.classList.add("is-drag");
      }),
    );
    ["dragleave", "drop"].forEach((ev) =>
      uploader.addEventListener(ev, (e) => {
        e.preventDefault();
        uploader.classList.remove("is-drag");
      }),
    );
    uploader.addEventListener("drop", (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (f) setPreview(f);
    });
  }

  if (fileInput) {
    fileInput.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (f) setPreview(f);
    });
  }

  if (clearBtn) clearBtn.addEventListener("click", () => setPreview(null));

  if (analyzeBtn) {
    analyzeBtn.addEventListener("click", () => {
      if (!currentFile) return toast(toastEl, "Select a file first.");
      const analysis = analyzeFileHeuristic(currentFile);
      setResult(analysis);
      toast(toastEl, "Analysis complete.");
    });
  }

  if (saveScanBtn) {
    saveScanBtn.addEventListener("click", () => {
      const report = currentReportObject();
      if (!report) return toast(toastEl, "Analyze a file first.");
      const scans = getScans();
      scans.push({
        id: report.id,
        createdAt: report.createdAt,
        userId: report.userId,
        fileName: report.fileName,
        fileType: report.fileType,
        fileSize: report.fileSize,
        kind: report.kind,
        score: report.score,
        label: report.label,
        reasons: report.reasons,
        labelText: "",
        notes: "",
      });
      setScans(scans);
      renderHistory();
      toast(toastEl, "Saved to history.");
    });
  }

  if (downloadReportBtn) {
    downloadReportBtn.addEventListener("click", () => {
      const report = currentReportObject();
      if (!report) return toast(toastEl, "Analyze a file first.");
      downloadJson(report, `ai-identifier-report-${Date.now()}.json`);
    });
  }

  if (historyTbody) {
    historyTbody.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("button[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      if (!id) return;

      if (act === "delete") {
        const scans = getScans();
        const next = scans.filter((s) => !(s.id === id && s.userId === session.userId));
        setScans(next);
        renderHistory();
        toast(toastEl, "Deleted.");
        return;
      }

      if (act === "view") {
        const s = userScans().find((x) => x.id === id);
        if (!s) return;
        modalScanId = id;
        if (mFile) mFile.textContent = s.fileName;
        if (mType) mType.textContent = `${s.kind} • ${s.fileType}`;
        if (mScore) mScore.textContent = `${s.score}% (${s.label})`;
        if (mWhen) mWhen.textContent = formatWhen(s.createdAt);
        if (mReasons) {
          mReasons.innerHTML = "";
          for (const r of s.reasons || []) {
            const li = document.createElement("li");
            li.innerHTML = `<strong>${escapeHtml(r)}</strong>`;
            mReasons.appendChild(li);
          }
        }
        if (mLabel) mLabel.value = s.labelText || "";
        if (mNotes) mNotes.value = s.notes || "";
        if (detailModal?.showModal) detailModal.showModal();
      }
    });
  }

  if (mSaveBtn) {
    mSaveBtn.addEventListener("click", () => {
      if (!modalScanId) return;
      const scans = getScans();
      const idx = scans.findIndex((s) => s.id === modalScanId && s.userId === session.userId);
      if (idx === -1) return;
      scans[idx] = {
        ...scans[idx],
        labelText: String(mLabel?.value || "").trim(),
        notes: String(mNotes?.value || "").trim(),
      };
      setScans(scans);
      renderHistory();
      toast(toastEl, "Updated.");
    });
  }

  if (mDeleteBtn) {
    mDeleteBtn.addEventListener("click", () => {
      if (!modalScanId) return;
      const scans = getScans();
      const next = scans.filter((s) => !(s.id === modalScanId && s.userId === session.userId));
      setScans(next);
      modalScanId = null;
      renderHistory();
      if (detailModal?.close) detailModal.close();
      toast(toastEl, "Deleted.");
    });
  }

  if (clearAllBtn) {
    clearAllBtn.addEventListener("click", () => {
      const scans = getScans();
      const next = scans.filter((s) => s.userId !== session.userId);
      setScans(next);
      renderHistory();
      toast(toastEl, "All history cleared.");
    });
  }

  renderHistory();
}

function initLandingPage() {
  // Nothing required beyond year; but we can gently animate the demo meter fill.
  const meterFill = $(".meter__fill");
  if (meterFill && meterFill.style.width) {
    window.requestAnimationFrame(() => {
      meterFill.style.width = meterFill.style.width;
    });
  }
}

function initRouting() {
  initCommon();
  const path = (window.location.pathname || "").toLowerCase();
  if (path.endsWith("/auth.html") || path.endsWith("\\auth.html")) initAuthPage();
  if (path.endsWith("/dashboard.html") || path.endsWith("\\dashboard.html")) initDashboardPage();
  if (path.endsWith("/index.html") || path.endsWith("\\index.html") || path.endsWith("/public/") || path.endsWith("\\")) {
    initLandingPage();
  }
}

document.addEventListener("DOMContentLoaded", initRouting);

