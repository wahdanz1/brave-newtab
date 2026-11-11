const MAX_PINS = 5;
const MAX_RECENT = 5;
const PING_INTERVAL_MS = 3000;
const PING_TIMEOUT_MS = 1200;
const PREVIEW_WIDTH = 1280;
// Cross-origin frames hide font and hydration state, so give the page a moment to settle after load.
const PREVIEW_SETTLE_MS = 700;
const COVER_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const MEDIA_TIMEOUT_MS = 5000;
// Rendered at roughly 2x the on-screen card so it stays sharp on HiDPI screens.
const COVER_SIZE = { width: 640, height: 400 };
const ICON_SIZE = 128;
const MAX_HIDDEN_RECENT = 200;
const WALLPAPER_MAX_WIDTH = 1600;
const WALLPAPER_BLUR_PX = 6;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const ICONS = {
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  offline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m19 5 3-3"/><path d="m2 22 3-3"/><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="M7.5 13.5 10 11"/><path d="M10.5 16.5 13 14"/><path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"/></svg>',
  done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
};

const DEFAULTS = {
  pins: [],
  ports: [
    { port: 8080, label: "" },
    { port: 3000, label: "" },
    { port: 5173, label: "" },
    { port: 4321, label: "" },
  ],
};

const hasExtensionApis = typeof chrome !== "undefined" && !!chrome.storage;

// Outside the extension (opened as a plain file) fall back to localStorage so the page still works.
const store = {
  async get(key) {
    if (hasExtensionApis) {
      const result = await chrome.storage.sync.get(key);
      return result[key] ?? DEFAULTS[key];
    }
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : DEFAULTS[key];
    } catch {
      return DEFAULTS[key];
    }
  },
  async set(key, value) {
    if (hasExtensionApis) return chrome.storage.sync.set({ [key]: value });
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};

const editing = { pins: false, dev: false };

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of [].concat(children)) node.append(child);
  return node;
}

function normaliseUrl(input) {
  const trimmed = input.trim();
  return /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// Load events rather than img.decode(), which can stall while the tab is in the background.
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function icon(url) {
  const fallback = el("span", { textContent: hostOf(url).replace(/^www\./, "")[0]?.toUpperCase() ?? "?" });
  const box = el("span", { className: "icon" }, fallback);
  if (hasExtensionApis) {
    const img = el("img", { alt: "", src: `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32` });
    img.addEventListener("load", () => fallback.replaceWith(img), { once: true });
  }
  return box;
}

function tile({ url, label, sub, shortcut, onRemove }) {
  const link = el("a", { className: "tile", href: url, title: url }, [
    icon(url),
    el("span", { className: "tile-label", textContent: label }),
  ]);
  if (shortcut) link.append(el("kbd", { textContent: shortcut }));
  if (sub) link.append(el("span", { className: "tile-sub", textContent: sub }));
  if (onRemove) link.append(removeButton(onRemove));
  return link;
}

function removeButton(onRemove) {
  const button = el("button", { className: "remove", textContent: "×", title: "Remove" });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    onRemove();
  });
  return button;
}

function faviconUrl(url, size) {
  return `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=${size}`;
}

function originPattern(url) {
  return `${new URL(url).origin}/*`;
}

async function hasSiteAccess(url) {
  if (!hasExtensionApis) return false;
  return chrome.permissions.contains({ origins: [originPattern(url)] });
}

function readSiteMedia(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const resolve = (href) => {
    try { return href ? new URL(href, baseUrl).href : null; } catch { return null; }
  };
  const og = doc.querySelector('meta[property="og:image"], meta[name="og:image"]')?.content
    ?? doc.querySelector('meta[name="twitter:image"], meta[property="twitter:image"]')?.content;
  const links = [...doc.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]')];
  const score = (link) => {
    if (link.type === "image/svg+xml" || /\.svg(\?|$)/i.test(link.getAttribute("href") ?? "")) return 10000;
    const size = Number((link.sizes?.value ?? "").split(/x/i)[0]) || 0;
    return /apple-touch-icon/.test(link.rel) ? Math.max(size, 180) : size;
  };
  const best = links.sort((a, b) => score(b) - score(a))[0];
  return { og: resolve(og), icon: resolve(best?.getAttribute("href")) };
}

// Chromium's GPU raster skips mipmaps on big downscales, so large images alias; resample once on the CPU instead.
async function resample(url, width, height, fit) {
  const response = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  if (blob.type.includes("svg")) {
    const img = await loadImage(URL.createObjectURL(blob));
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").drawImage(img, 0, 0, width, height);
    URL.revokeObjectURL(img.src);
    return toDataUrl(canvas);
  }
  const source = await createImageBitmap(blob);
  let sx = 0, sy = 0, sw = source.width, sh = source.height;
  if (fit === "cover") {
    const scale = Math.max(width / sw, height / sh);
    sw = width / scale;
    sh = height / scale;
    sx = (source.width - sw) / 2;
    sy = (source.height - sh) / 2;
  }
  const bitmap = await createImageBitmap(source, sx, sy, sw, sh, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: "high",
  });
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  return toDataUrl(canvas);
}

async function toDataUrl(canvas) {
  const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
  return new Promise((done) => {
    const reader = new FileReader();
    reader.onload = () => done(reader.result);
    reader.readAsDataURL(blob);
  });
}

async function firstWorking(attempts) {
  for (const attempt of attempts) {
    try { return await attempt(); } catch {}
  }
  return null;
}

// Weighted by saturation so monochrome icons give a neutral tint instead of a muddy average.
async function tintFrom(src) {
  const img = await loadImage(src);
  const canvas = new OffscreenCanvas(16, 16);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, 16, 16);
  const data = ctx.getImageData(0, 0, 16, 16).data;
  let r = 0, g = 0, b = 0, weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const max = Math.max(data[i], data[i + 1], data[i + 2]);
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    const w = 0.05 + (max - min) / 255;
    r += data[i] * w;
    g += data[i + 1] * w;
    b += data[i + 2] * w;
    weight += w;
  }
  if (!weight) return null;
  return `rgb(${Math.round(r / weight)} ${Math.round(g / weight)} ${Math.round(b / weight)})`;
}

async function buildCover(url) {
  let media = { og: null, icon: null };
  try {
    const response = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
    if (response.ok) media = readSiteMedia(await response.text(), response.url);
  } catch {}
  const image = media.og ? await firstWorking([() => resample(media.og, COVER_SIZE.width, COVER_SIZE.height, "cover")]) : null;
  if (image) return { image };
  const icon = await firstWorking([
    ...(media.icon ? [() => resample(media.icon, ICON_SIZE, ICON_SIZE, "fill")] : []),
    () => resample(`${new URL(url).origin}/apple-touch-icon.png`, ICON_SIZE, ICON_SIZE, "fill"),
  ]);
  const iconSrc = icon ?? faviconUrl(url, 64);
  let tint = null;
  try { tint = await tintFrom(iconSrc); } catch {}
  return { icon, tint };
}

async function coverFor(url) {
  const key = `cover:${url}`;
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached && Date.now() - cached.at < COVER_CACHE_MS) return cached;
  const cover = { ...(await buildCover(url)), at: Date.now() };
  await chrome.storage.local.set({ [key]: cover });
  return cover;
}

function showCoverFallback(preview, url, cover = {}) {
  const fallback = el("div", { className: "cover cover-fallback" });
  if (hasExtensionApis) {
    fallback.append(el("img", { alt: "", src: cover.icon ?? faviconUrl(url, 64) }));
    if (cover.tint) fallback.style.setProperty("--tint", cover.tint);
  } else {
    fallback.append(icon(url));
  }
  preview.append(fallback);
  requestAnimationFrame(() => { preview.dataset.loaded = ""; });
}

async function fillCover(preview, url) {
  if (!(await hasSiteAccess(url))) return showCoverFallback(preview, url);
  const cover = await coverFor(url);
  if (!cover.image) return showCoverFallback(preview, url, cover);
  const img = el("img", { className: "cover", alt: "", src: cover.image });
  img.addEventListener("load", () => { preview.dataset.loaded = ""; }, { once: true });
  preview.append(img);
}

function pinCard({ url, onRemove }) {
  const preview = el("div", { className: "preview" }, el("div", { className: "skeleton" }));
  const footer = el("div", { className: "card-footer" });
  if (hasExtensionApis) footer.append(el("img", { alt: "", src: faviconUrl(url, 32) }));
  footer.append(el("span"));
  const card = el("a", { className: "preview-card", href: url, title: url }, [
    preview,
    footer,
    el("kbd"),
    removeButton(onRemove),
  ]);
  fillCover(preview, url);
  return card;
}

// Blurred once on a canvas: a live CSS blur on a full-screen layer renders in vertical bands.
function blurredWallpaper(img) {
  const width = Math.min(WALLPAPER_MAX_WIDTH, img.naturalWidth);
  const height = Math.round((width * img.naturalHeight) / img.naturalWidth);
  const screenScale = Math.max(innerWidth / width, innerHeight / height);
  const radius = WALLPAPER_BLUR_PX / screenScale;
  const bleed = radius * 3;
  const canvas = el("canvas", { width, height });
  const ctx = canvas.getContext("2d");
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(img, -bleed, -bleed, width + bleed * 2, height + bleed * 2);
  return canvas;
}

async function renderBackground() {
  try {
    const response = await fetch("backgrounds/photo.json");
    if (!response.ok) return;
    const { images } = await response.json();
    const photo = images[Math.floor(Math.random() * images.length)];
    const img = await loadImage(`backgrounds/${photo.source}`);
    document.querySelector(".backdrop").replaceChildren(blurredWallpaper(img));
    document.body.dataset.wallpaper = "";
    const credit = document.getElementById("credit");
    credit.href = photo.link;
    credit.textContent = `Photo: ${photo.author}`;
    credit.hidden = false;
  } catch {}
}

// Cards are reused across renders so their cover images don't reload and flash.
const pinCards = new Map();

async function removePin(url) {
  const pins = (await store.get("pins")).filter((pin) => pin.url !== url);
  await store.set("pins", pins);
  if (hasExtensionApis) await chrome.storage.local.remove(`cover:${url}`);
  renderPins();
}

async function movePin(fromUrl, toUrl) {
  const pins = await store.get("pins");
  const from = pins.findIndex((pin) => pin.url === fromUrl);
  const to = pins.findIndex((pin) => pin.url === toUrl);
  if (from < 0 || to < 0 || from === to) return;
  const [moved] = pins.splice(from, 1);
  pins.splice(to, 0, moved);
  await store.set("pins", pins);
  renderPins();
}

async function renderPins() {
  const pins = await store.get("pins");
  const root = document.getElementById("pins");
  root.classList.toggle("editing", editing.pins);
  for (const url of pinCards.keys()) {
    if (!pins.some((pin) => pin.url === url)) pinCards.delete(url);
  }
  root.replaceChildren(...pins.map((pin, index) => {
    let card = pinCards.get(pin.url);
    if (!card) {
      card = pinCard({ url: pin.url, onRemove: () => removePin(pin.url) });
      makeReorderable(card, pin.url);
      pinCards.set(pin.url, card);
    }
    card.querySelector("kbd").textContent = String(index + 1);
    card.querySelector(".card-footer span").textContent = pin.name || hostOf(pin.url).replace(/^www\./, "");
    card.draggable = editing.pins;
    return card;
  }));
  if (!pins.length) root.append(el("p", { className: "empty", textContent: "Nothing pinned yet. Use the pencil to add up to five sites." }));
  document.getElementById("pin-form").hidden = !editing.pins || pins.length >= MAX_PINS;
  renderAccessPrompt(pins);
}

async function renderAccessPrompt(pins) {
  if (!hasExtensionApis) return;
  const missing = new Set();
  for (const pin of pins) {
    if (!(await hasSiteAccess(pin.url))) missing.add(originPattern(pin.url));
  }
  const button = document.getElementById("pin-access");
  button.hidden = !missing.size;
  button.onclick = async () => {
    if (!(await chrome.permissions.request({ origins: [...missing] }))) return;
    pinCards.clear();
    renderPins();
  };
}

function makeReorderable(node, url) {
  node.addEventListener("click", (event) => {
    if (editing.pins) event.preventDefault();
  });
  node.addEventListener("dragstart", (event) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/x-pin-url", url);
    node.classList.add("dragging");
  });
  node.addEventListener("dragend", () => node.classList.remove("dragging"));
  node.addEventListener("dragover", (event) => {
    if (!editing.pins || !event.dataTransfer.types.includes("text/x-pin-url")) return;
    event.preventDefault();
    node.classList.add("drop-target");
  });
  node.addEventListener("dragleave", () => node.classList.remove("drop-target"));
  node.addEventListener("drop", (event) => {
    event.preventDefault();
    node.classList.remove("drop-target");
    movePin(event.dataTransfer.getData("text/x-pin-url"), url);
  });
}

async function hideRecent(hostname) {
  const { hiddenRecent = [] } = await chrome.storage.local.get("hiddenRecent");
  const next = [hostname, ...hiddenRecent.filter((host) => host !== hostname)].slice(0, MAX_HIDDEN_RECENT);
  await chrome.storage.local.set({ hiddenRecent: next });
  if (document.startViewTransition) {
    document.startViewTransition(() => renderRecent());
  } else {
    renderRecent();
  }
}

async function renderRecent() {
  const root = document.getElementById("recent");
  if (!hasExtensionApis) {
    root.replaceChildren(el("p", { className: "empty", textContent: "Recent sites need the extension (history access)." }));
    return;
  }
  const items = await chrome.history.search({ text: "", startTime: 0, maxResults: 300 });
  const { hiddenRecent = [] } = await chrome.storage.local.get("hiddenRecent");
  const seen = new Set(hiddenRecent);
  const recent = [];
  for (const item of items) {
    let parsed;
    try { parsed = new URL(item.url); } catch { continue; }
    if (!/^https?:$/.test(parsed.protocol) || LOCAL_HOSTS.has(parsed.hostname)) continue;
    if (seen.has(parsed.hostname)) continue;
    seen.add(parsed.hostname);
    recent.push(item);
    if (recent.length === MAX_RECENT) break;
  }
  root.replaceChildren(...recent.map((item) => {
    const hostname = hostOf(item.url);
    const node = tile({
      url: item.url,
      label: hostname.replace(/^www\./, ""),
      sub: item.title,
      onRemove: () => hideRecent(hostname),
    });
    node.style.viewTransitionName = `recent-${hostname.replace(/[^a-z0-9-]/gi, "-")}`;
    node.querySelector(".remove").title = "Hide from Recent";
    return node;
  }));
  if (!recent.length) root.append(el("p", { className: "empty", textContent: "No history yet." }));
}

async function ping(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    await fetch(`http://localhost:${port}/`, { mode: "no-cors", cache: "no-store", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const previewScaler = new ResizeObserver((entries) => {
  for (const entry of entries) {
    entry.target.style.setProperty("--preview-scale", entry.contentRect.width / PREVIEW_WIDTH);
  }
});

function devCard({ port, label }, onRemove) {
  const preview = el("div", { className: "preview" }, el("div", { className: "skeleton" }));
  previewScaler.observe(preview);
  const card = el("a", { className: "preview-card", href: `http://localhost:${port}/` }, [
    preview,
    el("div", { className: "card-footer" }, [
      el("span", { className: "dot" }),
      el("span", { textContent: label ? `${label} · ${port}` : `localhost:${port}` }),
    ]),
    removeButton(onRemove),
  ]);
  card.dataset.port = port;
  card.dataset.state = "checking";
  return card;
}

function showPreview(card) {
  const preview = card.querySelector(".preview");
  if (preview.querySelector("iframe")) return;
  preview.querySelector(".preview-note")?.remove();
  delete preview.dataset.loaded;
  const frame = el("iframe", {
    src: `http://localhost:${card.dataset.port}/`,
    tabIndex: -1,
    loading: "lazy",
  });
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  frame.setAttribute("aria-hidden", "true");
  frame.addEventListener("load", () => {
    setTimeout(() => {
      if (frame.isConnected) preview.dataset.loaded = "";
    }, PREVIEW_SETTLE_MS);
  }, { once: true });
  preview.append(frame);
}

function showOffline(card) {
  const preview = card.querySelector(".preview");
  preview.querySelector("iframe")?.remove();
  delete preview.dataset.loaded;
  if (preview.querySelector(".preview-note")) return;
  const note = el("div", { className: "preview-note", innerHTML: ICONS.offline, title: "Not running" });
  note.setAttribute("role", "img");
  note.setAttribute("aria-label", "Not running");
  preview.append(note);
}

async function renderDev() {
  const ports = await store.get("ports");
  const root = document.getElementById("dev");
  root.classList.toggle("editing", editing.dev);
  previewScaler.disconnect();
  root.replaceChildren(...ports.map((entry, index) => devCard(entry, async () => {
    ports.splice(index, 1);
    await store.set("ports", ports);
    renderDev();
  })));
  if (!ports.length) root.append(el("p", { className: "empty", textContent: "No ports. Use the pencil to add one." }));
  document.getElementById("dev-form").hidden = !editing.dev;
  refreshDevStatus();
}

async function refreshDevStatus() {
  const cards = [...document.querySelectorAll("#dev [data-port]")];
  await Promise.all(cards.map(async (card) => {
    const up = await ping(card.dataset.port);
    card.dataset.state = up ? "up" : "down";
    up ? showPreview(card) : showOffline(card);
  }));
}

document.querySelectorAll("[data-toggle-edit]").forEach((button) => {
  button.innerHTML = ICONS.edit;
  button.addEventListener("click", () => {
    const key = button.dataset.toggleEdit;
    editing[key] = !editing[key];
    button.innerHTML = editing[key] ? ICONS.done : ICONS.edit;
    button.title = editing[key] ? "Done" : "Edit";
    if (key === "pins") return renderPins();
    // Toggled in place: re-rendering would reload every dev preview iframe.
    document.getElementById("dev").classList.toggle("editing", editing.dev);
    document.getElementById("dev-form").hidden = !editing.dev;
  });
});

document.getElementById("pin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const { name, url } = form.elements;
  const pinUrl = normaliseUrl(url.value);
  // Requested before any await: Brave only shows the prompt inside the submit's user gesture.
  const access = hasExtensionApis
    ? chrome.permissions.request({ origins: [originPattern(pinUrl)] }).catch(() => false)
    : Promise.resolve(false);
  const pins = await store.get("pins");
  if (pins.length >= MAX_PINS || pins.some((pin) => pin.url === pinUrl)) return;
  await access;
  pins.push({ name: name.value.trim(), url: pinUrl });
  await store.set("pins", pins);
  form.reset();
  renderPins();
});

document.getElementById("dev-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const port = Number(form.elements.port.value);
  const ports = await store.get("ports");
  if (ports.some((entry) => entry.port === port)) return;
  ports.push({ port, label: form.elements.label.value.trim() });
  await store.set("ports", ports);
  form.reset();
  renderDev();
});

const searchForm = document.getElementById("search");

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = searchForm.elements.q.value.trim();
  if (!text) return;
  if (hasExtensionApis && chrome.search) {
    chrome.search.query({ text, disposition: "CURRENT_TAB" });
  } else {
    location.href = `https://search.brave.com/search?q=${encodeURIComponent(text)}`;
  }
});

function isTyping(target) {
  return target.closest("input, textarea, [contenteditable]");
}

document.addEventListener("keydown", async (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
  if (event.key === "/") {
    event.preventDefault();
    searchForm.elements.q.focus();
    return;
  }
  if (/^[1-5]$/.test(event.key)) {
    const pin = (await store.get("pins"))[Number(event.key) - 1];
    if (pin) location.href = pin.url;
  }
});

renderBackground();
renderPins();
renderRecent();
renderDev();

setInterval(() => {
  if (document.visibilityState === "visible") refreshDevStatus();
}, PING_INTERVAL_MS);
