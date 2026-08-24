"use strict";

/* ==========================================================================
   科研协作 · 多 Agent 工作台
   视图：聊天 / 智能体 / 知识库
   ========================================================================== */

async function parseResponse(response) {
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.user) showAuthGate();
    throw new Error(data.error || ("请求失败：" + response.status));
  }
  return data;
}

const api = {
  get: (p) => fetch(p).then(parseResponse),
  post: (p, body) => fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then(parseResponse),
  patch: (p, body) => fetch(p, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then(parseResponse),
  del: (p) => fetch(p, { method: "DELETE" }).then(parseResponse),
};

const state = {
  user: null,
  theme: "station",
  view: "chat",
  agents: [], convs: [], currentConv: null, kbs: [], friends: [],
  streaming: {}, evtSource: null, globalEvtSource: null, conversationRefreshTimer: null,
  lastSpeakerName: null,
  memberStatus: {}, stick: true,
  reconnectTries: 0, reconnectTimer: null, maxReconnectTries: 10,
  convQuery: "", convKind: "all", convDeleting: null,
  agentQuery: "", agentCat: "全部",
  kbQuery: "", kbDeleting: null, currentKb: null, rag: null,
  wizard: { step: 0, title: "", memberIds: [], memberUserIds: [] },
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function copyText(value) {
  const text = String(value || "");
  if (!text) throw new Error("没有可复制的内容");
  if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch (_error) {}
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (!document.execCommand || !document.execCommand("copy")) throw new Error("浏览器拒绝复制");
  } finally { textarea.remove(); }
}
const DEFAULT_AVATAR = "/assets/avatars/preset-01.png";
const AVATAR_PRESETS = [
  "/assets/avatars/preset-01.png", "/assets/avatars/preset-02.png", "/assets/avatars/preset-03.png",
  "/assets/avatars/preset-04.png", "/assets/avatars/preset-05.png", "/assets/avatars/preset-06.png",
  "/assets/avatars/preset-07.png", "/assets/avatars/preset-08.png", "/assets/avatars/preset-09.png",
  "/assets/avatars/preset-10.png", "/assets/avatars/preset-11.png",
];
const isAvatarImage = (value) => /^\/uploads\/avatars\/avatar_[a-zA-Z0-9_-]+\.(png|jpe?g|webp|gif)$/.test(value)
  || /^\/assets\/avatars\/(preset-\d{2}\.png|research-assistant\.(png|jpe?g)|brand\/logo\.(png|jpe?g))$/.test(value)
  || /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/.test(value);
// 老文字/Emoji 头像按 seed 稳定地从预设图片池里选一张，保证同一员工头像始终一致
const presetFor = (seed) => {
  const s = String(seed || "");
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_PRESETS[hash % AVATAR_PRESETS.length];
};
const avatarMarkup = (avatar, fallback = DEFAULT_AVATAR) => {
  const value = String(avatar || fallback);
  return isAvatarImage(value) ? '<img src="' + value + '" alt="" />' : '<img src="' + presetFor(value) + '" alt="" />';
};
const GROUP_STEPS = 2;
const ONBOARDING_KEY = "unisci-ai-onboarding-v1";
const THEME_STORAGE_PREFIX = "unisci-ai-theme";
const THEME_OPTIONS = {
  station: "换乘站",
  authority: "授权档案",
  editorial: "内容印刷",
  archive: "知识档案馆",
  lab: "工程接线台",
  subagents: "Subagent 漫画",
  ledger: "协作账本",
  theatre: "群聊剧场",
  tactics: "团队战术板",
};
let onboardingStep = 0;

function themeStorageKey() {
  return THEME_STORAGE_PREFIX + "." + (state.user && state.user.id ? state.user.id : "guest");
}

function applyTheme(theme, persist = false) {
  const selected = Object.hasOwn(THEME_OPTIONS, theme) ? theme : "station";
  state.theme = selected;
  document.body.dataset.theme = selected;
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    const active = button.dataset.themeChoice === selected;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const name = THEME_OPTIONS[selected];
  const current = $("settingsThemeName");
  if (current) current.textContent = name;
  const description = $("themeCurrentDescription");
  if (description) description.textContent = "当前使用：" + name;
  if (persist) {
    try { localStorage.setItem(themeStorageKey(), selected); } catch (_error) {}
  }
}

function restoreTheme() {
  let saved = "station";
  try { saved = localStorage.getItem(themeStorageKey()) || "station"; } catch (_error) {}
  applyTheme(saved, false);
}

function onboardingCompleted() {
  try { return localStorage.getItem(ONBOARDING_KEY) === "complete"; }
  catch (_error) { return false; }
}

function setOnboardingStep(step) {
  onboardingStep = Math.max(0, Math.min(1, step));
  document.querySelectorAll("[data-onboarding-page]").forEach((page) => {
    const active = Number(page.dataset.onboardingPage) === onboardingStep;
    page.classList.toggle("active", active);
    page.setAttribute("aria-hidden", String(!active));
  });
  document.querySelectorAll("[data-onboarding-dot]").forEach((dot) => {
    dot.classList.toggle("active", Number(dot.dataset.onboardingDot) === onboardingStep);
  });
  $("onboardingStepText").textContent = (onboardingStep + 1) + " / 2";
  $("onboardingBack").classList.toggle("hidden", onboardingStep === 0);
  $("onboardingNext").innerHTML = onboardingStep === 0
    ? '下一步：专业知识库<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
    : '进入 UniSci AI<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  requestAnimationFrame(() => $("onboardingNext").focus());
}

function showOnboarding(step = 0) {
  const onboarding = $("onboarding");
  $("authGate").setAttribute("aria-hidden", "true");
  document.body.classList.remove("auth-open");
  onboarding.removeAttribute("aria-hidden");
  document.body.classList.add("onboarding-open");
  $("app").setAttribute("aria-hidden", "true");
  $("app").inert = true;
  setOnboardingStep(step);
}

function closeOnboarding(remember = true) {
  if (remember) {
    try { localStorage.setItem(ONBOARDING_KEY, "complete"); } catch (_error) {}
  }
  $("onboarding").setAttribute("aria-hidden", "true");
  document.body.classList.remove("onboarding-open");
  if (!state.user) return showAuthGate();
  $("app").removeAttribute("aria-hidden");
  $("app").inert = false;
  setTimeout(() => $("newChatBtn").focus(), 80);
}

function setupOnboarding() {
  $("onboardingNext").onclick = () => onboardingStep === 0 ? setOnboardingStep(1) : closeOnboarding(true);
  $("onboardingBack").onclick = () => setOnboardingStep(0);
  $("onboardingSkip").onclick = () => closeOnboarding(true);
  $("onboardingReplay").onclick = () => showOnboarding(0);
  document.addEventListener("keydown", (event) => {
    if ($("onboarding").getAttribute("aria-hidden") === "true") return;
    if (event.key === "ArrowRight" && onboardingStep === 0) { event.preventDefault(); setOnboardingStep(1); }
    if (event.key === "ArrowLeft" && onboardingStep === 1) { event.preventDefault(); setOnboardingStep(0); }
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeOnboarding(true); }
  });
}

function md(text) {
  let t = esc(text);
  t = t.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => '<pre class="code-block"><code>' + code.replace(/^\n/, "") + "</code></pre>");
  t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
  t = t.replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>");
  t = t.replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>");
  t = t.replace(/[@＠]([a-zA-Z0-9_-]+)/g, '<span class="mention">@$1</span>');
  t = t.replace(/\[NEEDS_APPROVAL:[^\]]*\]/g, "");
  t = t.replace(/\n/g, "<br>");
  return t;
}

const fmtTime = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
};

function fmtConvTime(ts) {
  if (!ts) return "";
  const d = new Date(ts), now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDays = Math.floor((startOfToday - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  if (diffDays === 0) return fmtTime(ts);
  if (diffDays === 1) return "昨天";
  if (diffDays < 7) return "周" + "日一二三四五六"[d.getDay()];
  return (d.getMonth() + 1) + "/" + d.getDate();
}

/* ===== 模态焦点管理 ===== */
let lastFocus = null;
function openModal(el) { lastFocus = document.activeElement; el.classList.remove("hidden"); }
function closeModal(el) {
  el.classList.add("hidden");
  if (lastFocus && lastFocus.focus) { setTimeout(() => { try { lastFocus.focus(); } catch (e) {} }, 40); }
}

/* ===== 统一头像裁剪 ===== */
const MAX_AVATAR_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_AVATAR_OUTPUT_BYTES = 2 * 1024 * 1024;
const AVATAR_EXPORT_SIZE = 512;
let avatarCropState = null;

function validateAvatarFile(file) {
  if (!file || !/^image\/(png|jpeg|webp|gif)$/i.test(file.type)) return "请选择 PNG、JPG、WebP 或 GIF 图片";
  if (file.size > MAX_AVATAR_SOURCE_BYTES) return "图片不能超过 10MB，请压缩后重试";
  return "";
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取图片失败，请重试"));
    reader.readAsDataURL(file);
  });
}

function imageFromSource(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片无法解析，请选择其他文件"));
    image.src = src;
  });
}

function cropCanvasSize() {
  const canvas = $("avatarCropCanvas");
  const stage = $("avatarCropStage");
  return Math.max(1, Math.min(stage.clientWidth || 360, stage.clientHeight || 360, 360, canvas.width || 360));
}

function constrainAvatarCrop() {
  const crop = avatarCropState;
  if (!crop) return;
  const box = cropCanvasSize();
  const scale = crop.baseScale * crop.zoom;
  crop.offsetX = Math.max(-(crop.image.width * scale - box) / 2, Math.min((crop.image.width * scale - box) / 2, crop.offsetX));
  crop.offsetY = Math.max(-(crop.image.height * scale - box) / 2, Math.min((crop.image.height * scale - box) / 2, crop.offsetY));
}

function renderAvatarCrop() {
  const crop = avatarCropState;
  if (!crop) return;
  const canvas = $("avatarCropCanvas");
  const stage = $("avatarCropStage");
  const box = Math.max(1, Math.min(stage.clientWidth || 360, 360));
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(box * ratio);
  canvas.height = Math.round(box * ratio);
  canvas.style.width = box + "px";
  canvas.style.height = box + "px";
  constrainAvatarCrop();
  const scale = crop.baseScale * crop.zoom;
  const width = crop.image.width * scale;
  const height = crop.image.height * scale;
  const x = (box - width) / 2 + crop.offsetX;
  const y = (box - height) / 2 + crop.offsetY;
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, box, box);
  context.fillStyle = "#eef1ef";
  context.fillRect(0, 0, box, box);
  context.drawImage(crop.image, x, y, width, height);
  $("avatarCropZoom").value = String(crop.zoom);
  $("avatarCropZoomValue").textContent = Math.round(crop.zoom * 100) + "%";
}

function resetAvatarCrop() {
  avatarCropState = null;
  $("avatarCropError").classList.add("hidden");
  $("avatarCropConfirm").disabled = false;
  $("avatarCropConfirm").textContent = "确认头像";
}

function finishAvatarCrop(result) {
  const crop = avatarCropState;
  if (!crop) return;
  const resolve = crop.resolve;
  closeModal($("avatarCropModal"));
  resetAvatarCrop();
  resolve(result);
}

async function exportAvatarCrop() {
  const crop = avatarCropState;
  if (!crop) return null;
  const box = cropCanvasSize();
  const scale = crop.baseScale * crop.zoom;
  const sourceX = Math.max(0, ((crop.image.width * scale - box) / 2 - crop.offsetX) / scale);
  const sourceY = Math.max(0, ((crop.image.height * scale - box) / 2 - crop.offsetY) / scale);
  const sourceSize = Math.min(box / scale, crop.image.width - sourceX, crop.image.height - sourceY);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_EXPORT_SIZE;
  canvas.height = AVATAR_EXPORT_SIZE;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(crop.image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.92, 0.84, 0.76]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= MAX_AVATAR_OUTPUT_BYTES) return new File([blob], "avatar.jpg", { type: "image/jpeg" });
  }
  throw new Error("裁剪后的头像仍超过 2MB，请选择尺寸更小的图片");
}

async function openAvatarCropper(file) {
  const validationError = validateAvatarFile(file);
  if (validationError) throw new Error(validationError);
  const dataUrl = await fileAsDataUrl(file);
  const image = await imageFromSource(dataUrl);
  if (!image.width || !image.height) throw new Error("图片尺寸无效，请选择其他文件");
  return new Promise((resolve) => {
    avatarCropState = {
      image,
      baseScale: Math.max(360 / image.width, 360 / image.height),
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
      dragging: false,
      resolve,
    };
    $("avatarCropError").classList.add("hidden");
    openModal($("avatarCropModal"));
    requestAnimationFrame(renderAvatarCrop);
  });
}

function setupAvatarCropper() {
  const canvas = $("avatarCropCanvas");
  const stage = $("avatarCropStage");
  $("avatarCropZoom").oninput = (event) => {
    if (!avatarCropState) return;
    avatarCropState.zoom = Number(event.target.value);
    renderAvatarCrop();
  };
  const stopDragging = () => {
    if (!avatarCropState) return;
    avatarCropState.dragging = false;
    canvas.releasePointerCapture && canvas.hasPointerCapture && canvas.hasPointerCapture(avatarCropState.pointerId) && canvas.releasePointerCapture(avatarCropState.pointerId);
  };
  canvas.onpointerdown = (event) => {
    if (!avatarCropState) return;
    avatarCropState.dragging = true;
    avatarCropState.pointerId = event.pointerId;
    avatarCropState.startX = event.clientX;
    avatarCropState.startY = event.clientY;
    avatarCropState.startOffsetX = avatarCropState.offsetX;
    avatarCropState.startOffsetY = avatarCropState.offsetY;
    canvas.setPointerCapture(event.pointerId);
  };
  canvas.onpointermove = (event) => {
    if (!avatarCropState || !avatarCropState.dragging || event.pointerId !== avatarCropState.pointerId) return;
    avatarCropState.offsetX = avatarCropState.startOffsetX + event.clientX - avatarCropState.startX;
    avatarCropState.offsetY = avatarCropState.startOffsetY + event.clientY - avatarCropState.startY;
    renderAvatarCrop();
  };
  canvas.onpointerup = stopDragging;
  canvas.onpointercancel = stopDragging;
  stage.onwheel = (event) => {
    if (!avatarCropState) return;
    event.preventDefault();
    avatarCropState.zoom = Math.max(1, Math.min(3, avatarCropState.zoom + (event.deltaY < 0 ? 0.08 : -0.08)));
    renderAvatarCrop();
  };
  const cancel = () => finishAvatarCrop(null);
  $("avatarCropCancel").onclick = cancel;
  $("avatarCropClose").onclick = cancel;
  $("avatarCropModal").addEventListener("click", (event) => { if (event.target === $("avatarCropModal")) cancel(); });
  $("avatarCropConfirm").onclick = async () => {
    const button = $("avatarCropConfirm");
    const error = $("avatarCropError");
    button.disabled = true;
    button.textContent = "正在处理…";
    error.classList.add("hidden");
    try { finishAvatarCrop(await exportAvatarCrop()); }
    catch (cause) {
      button.disabled = false;
      button.textContent = "确认头像";
      error.textContent = cause.message || "裁剪失败，请重试";
      error.classList.remove("hidden");
    }
  };
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !avatarCropState || $("avatarCropModal").classList.contains("hidden")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancel();
  });
  window.addEventListener("resize", () => { if (avatarCropState) renderAvatarCrop(); });
}

function openContactModal() { openModal($("contactModal")); }
function closeContactModal() { closeModal($("contactModal")); }

/* ===== Toast ===== */
function toast(msg, kind) {
  const stack = $("toastStack");
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 220);
  }, 2600);
}

/* ==========================================================================
   初始化
   ========================================================================== */
let authMode = "login";
let appBound = false;

function showAuthGate() {
  disconnectGlobalSSE();
  state.user = null;
  $("onboarding").setAttribute("aria-hidden", "true");
  document.body.classList.remove("onboarding-open");
  $("authGate").removeAttribute("aria-hidden");
  document.body.classList.add("auth-open");
  $("app").setAttribute("aria-hidden", "true");
  $("app").inert = true;
}
function hideAuthGate() {
  $("authGate").setAttribute("aria-hidden", "true");
  document.body.classList.remove("auth-open");
  $("app").removeAttribute("aria-hidden");
  $("app").inert = false;
}
function renderAuthMode() {
  const registering = authMode === "register";
  $("authTitle").textContent = registering ? "注册" : "登录";
  $("authSubmit").textContent = registering ? "注册并进入" : "登录";
  $("authSwitch").textContent = registering ? "已有账户？登录" : "没有账户？注册";
  $("authPassword").autocomplete = registering ? "new-password" : "current-password";
  $("authError").classList.add("hidden");
}
function setupAuth() {
  $("authSwitch").onclick = () => { authMode = authMode === "login" ? "register" : "login"; renderAuthMode(); };
  $("authForm").onsubmit = async (event) => {
    event.preventDefault();
    const login = $("authLogin").value.trim(); const password = $("authPassword").value;
    const error = $("authError"); error.classList.add("hidden");
    try {
      const endpoint = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
      const r = await api.post(endpoint, { login, password });
      state.user = r.user; restoreTheme(); hideAuthGate(); await bootWorkspace();
    } catch (e) { error.textContent = e.message || "操作失败，请重试"; error.classList.remove("hidden"); }
  };
  const renderAccountAvatar = (avatarEl, user) => {
    if (!avatarEl) return;
    avatarEl.innerHTML = "";
    if (user && user.avatarUrl) {
      const img = document.createElement("img"); img.src = user.avatarUrl; img.alt = ""; avatarEl.appendChild(img);
      return;
    }
    avatarEl.textContent = (user && (user.displayName || user.login) ? (user.displayName || user.login).slice(0, 1).toUpperCase() : "—");
  };
  const renderSettingsAccount = () => {
    const user = state.user; if (!user) return;
    $("settingsLogin").textContent = user.login;
    $("settingsName").textContent = user.displayName || user.login;
    $("settingsUserId").textContent = user.id;
    renderAccountAvatar($("settingsAvatar"), user);
  };
  const setSettingsView = (name) => {
    const card = document.querySelector("#settingsModal .settings-card"); if (!card) return;
    card.dataset.view = name;
    card.querySelectorAll("[data-settings-view]").forEach((pane) => { pane.hidden = pane.dataset.settingsView !== name; });
    $("settingsBackBtn").hidden = name === "main";
  };
  const forceCloseSettings = () => {
    setSettingsView("main");
    const back = $("settingsBackBtn"); if (back) back.hidden = true;
  };
  const resetSettingsToMain = () => {
    $("passwordForm").reset();
    $("profileForm").reset();
    $("profileAvatarUpload").value = "";
    delete $("profileAvatarPreview").dataset.uploaded;
    delete $("profileAvatarPreview").dataset.reset;
    $("passwordError").classList.add("hidden");
    $("profileError").classList.add("hidden");
    setSettingsView("main");
  };
  $("settingsBtn").onclick = () => {
    if (!state.user) return;
    renderSettingsAccount();
    resetSettingsToMain();
    openModal($("settingsModal"));
  };
  $("settingsClose").onclick = () => { forceCloseSettings(); closeModal($("settingsModal")); };
  $("settingsBackBtn").onclick = () => resetSettingsToMain();
  $("copyUserIdBtn").onclick = async () => {
    try { await copyText(state.user && state.user.id); toast("用户 ID 已复制", "ok"); }
    catch (error) { console.warn("复制用户 ID 失败：", error); toast("复制失败，请手动复制", "err"); }
  };
  $("openFriendsBtn").onclick = () => { closeModal($("settingsModal")); switchView("friends"); };
  $("openAppearanceBtn").onclick = () => {
    applyTheme(state.theme, false);
    setSettingsView("appearance");
  };
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.onclick = () => {
      const theme = button.dataset.themeChoice;
      applyTheme(theme, true);
      toast("界面主题已切换为「" + THEME_OPTIONS[theme] + "」", "ok");
    };
  });

  $("profileEditBtn").onclick = () => {
    const user = state.user; if (!user) return;
    $("profileName").value = user.displayName || "";
    $("profileError").classList.add("hidden");
    $("profileAvatarUpload").value = "";
    delete $("profileAvatarPreview").dataset.uploaded;
    renderAccountAvatar($("profileAvatarPreview"), user);
    setSettingsView("profile");
  };
  $("profileCancel").onclick = () => resetSettingsToMain();
  $("profileAvatarUpload").onchange = async () => {
    const input = $("profileAvatarUpload");
    const file = input.files && input.files[0];
    if (!file) return;
    const error = $("profileError");
    error.classList.add("hidden");
    try {
      const cropped = await openAvatarCropper(file);
      if (!cropped) return;
      const dataUrl = await fileAsDataUrl(cropped);
      const preview = $("profileAvatarPreview");
      preview.innerHTML = "";
      const image = document.createElement("img"); image.src = dataUrl; image.alt = ""; preview.appendChild(image);
      preview.dataset.uploaded = dataUrl;
      delete preview.dataset.reset;
    } catch (cause) {
      error.textContent = cause.message || "头像处理失败，请重试";
      error.classList.remove("hidden");
    } finally {
      input.value = "";
    }
  };
  $("profileAvatarReset").onclick = () => {
    $("profileAvatarUpload").value = "";
    const preview = $("profileAvatarPreview");
    delete preview.dataset.uploaded;
    preview.dataset.reset = "1";
    renderAccountAvatar(preview, { login: $("profileName").value });
  };
  $("profileForm").onsubmit = async (event) => {
    event.preventDefault();
    const displayName = $("profileName").value.trim();
    const error = $("profileError");
    error.classList.add("hidden");
    if (!displayName) { error.textContent = "用户名不能为空"; error.classList.remove("hidden"); return; }
    const preview = $("profileAvatarPreview");
    const uploaded = preview.dataset.uploaded;
    const reset = preview.dataset.reset === "1";
    const avatarUrl = uploaded || (reset ? "" : (state.user && state.user.avatarUrl) || "");
    if (reset) delete preview.dataset.reset;
    try {
      const r = await api.post("/api/auth/profile", { displayName, avatarUrl });
      state.user = r.user;
      renderSettingsAccount();
      refreshAvatarViews();
      resetSettingsToMain();
      toast("资料已更新");
    } catch (e) { error.textContent = e.message || "资料更新失败，请重试"; error.classList.remove("hidden"); }
  };

  $("openPasswordBtn").onclick = () => {
    $("passwordForm").reset();
    $("passwordError").classList.add("hidden");
    setSettingsView("password");
  };
  $("passwordCancel").onclick = () => resetSettingsToMain();
  $("passwordForm").onsubmit = async (event) => {
    event.preventDefault();
    const currentPassword = $("currentPassword").value;
    const newPassword = $("newPassword").value;
    const confirmPassword = $("confirmPassword").value;
    const error = $("passwordError");
    error.classList.add("hidden");
    if (newPassword !== confirmPassword) { error.textContent = "两次输入的新密码不一致"; error.classList.remove("hidden"); return; }
    try {
      await api.post("/api/auth/password", { currentPassword, newPassword });
      $("passwordForm").reset();
      resetSettingsToMain();
      toast("密码已更新");
    } catch (e) { error.textContent = e.message || "密码更新失败，请重试"; error.classList.remove("hidden"); }
  };
  $("logoutBtn").onclick = async () => { await api.post("/api/auth/logout"); forceCloseSettings(); closeModal($("settingsModal")); showAuthGate(); };
  renderAuthMode();
}
async function bootWorkspace() {
  try { const h = await api.get("/api/health"); state.rag = h.rag || null; } catch (_) {}
  try { const f = await api.get("/api/friends"); state.friends = f.friends || []; } catch (_) { state.friends = []; }
  const [a] = await Promise.all([api.get("/api/agents"), loadKbs(), loadConvs()]);
  state.agents = a.agents;
  renderAgentCats(); renderAgentGrid(); await seedDefaultConversation(); renderChat();
  if (!appBound) { bindEvents(); appBound = true; }
  connectGlobalSSE();
  updateSendBtn();
}
async function init() {
  setupAvatarCropper();
  setupAuth();
  setupOnboarding();
  const forceOnboarding = new URLSearchParams(location.search).get("onboarding") === "1";
  try {
    const r = await api.get("/api/auth/me");
    state.user = r.user || null;
  } catch (_) { state.user = null; }
  restoreTheme();

  // 首次访问先完成「了解我们」两页；之后再进入注册/登录，已登录用户则直接进入工作区。
  if (forceOnboarding || !onboardingCompleted()) return showOnboarding(0);
  if (!state.user) return showAuthGate();
  hideAuthGate();
  await bootWorkspace();
}

// 保证每个用户都有一个「科研小助理」初始单聊：不存在则创建，存在则纠正标题并默认打开
async function seedDefaultConversation() {
  try {
    const assistant = state.agents.find((x) => x.id === "research_assistant" || x.mention === "assistant");
    if (!assistant) return;

    const existing = state.convs.find((c) =>
      c.kind === "direct" &&
      Array.isArray(c.memberAgentIds) &&
      c.memberAgentIds.length === 1 &&
      c.memberAgentIds[0] === assistant.id);

    if (existing) {
      if (existing.title !== "科研小助理") {
        await api.patch("/api/conversations/" + existing.id, { title: "科研小助理" });
        await loadConvs();
      }
      if (!state.currentConv) await openConv(existing.id);
      return;
    }

    // 不存在：创建并打开
    const r = await api.post("/api/conversations", {
      title: "科研小助理",
      memberAgentIds: [assistant.id],
      kind: "direct",
      autoRoute: true,
    });
    await loadConvs();
    if (r && r.conversation) await openConv(r.conversation.id);
  } catch (_) { /* 种子失败不阻塞 */ }
}

/* ==========================================================================
   视图切换
   ========================================================================== */
function switchView(v) {
  if (state.view === "agents" && v !== "agents" && !$("agentConfigView").classList.contains("hidden") && !closeAgentConfig()) return;
  state.view = v;
  document.querySelectorAll(".rail-item").forEach((r) => r.classList.toggle("active", r.dataset.view === v));
  $("viewChat").classList.toggle("hidden", v !== "chat");
  $("viewAgents").classList.toggle("hidden", v !== "agents");
  $("viewKb").classList.toggle("hidden", v !== "kb");
  $("viewFriends").classList.toggle("hidden", v !== "friends");
  if (v === "friends") openFriendsView();
  if (v === "chat" && state.currentConv) setTimeout(() => $("input").focus(), 40);
  if (v === "agents" && $("agentConfigView").classList.contains("hidden")) setTimeout(() => $("agentSearch").focus(), 40);
  if (v === "kb") setTimeout(() => $("kbSearch").focus(), 40);
}

/* ==========================================================================
   智能体视图
   ========================================================================== */
function renderAgentCats() {
  const cats = ["全部"].concat(Array.from(new Set(state.agents.map((a) => a.category || "通用"))));
  const el = $("agentCats");
  el.innerHTML = cats.map((c) =>
    '<button class="cat-chip' + (c === state.agentCat ? " active" : "") + '" data-cat="' + esc(c) + '">' + esc(c) + "</button>"
  ).join("");
  el.querySelectorAll("[data-cat]").forEach((b) => {
    b.onclick = () => { state.agentCat = b.dataset.cat; renderAgentCats(); renderAgentGrid(); };
  });
  const list = $("aCategoryList");
  if (list) {
    list.innerHTML = Array.from(new Set(state.agents.map((a) => a.category).filter(Boolean)))
      .map((c) => '<option value="' + esc(c) + '"></option>').join("");
  }
}

function visibleAgents() {
  const q = state.agentQuery.trim().toLowerCase();
  return state.agents.filter((a) => {
    if (state.agentCat !== "全部" && (a.category || "通用") !== state.agentCat) return false;
    if (!q) return true;
    const kbNames = (a.kbIds || []).map((id) => (state.kbs.find((kb) => kb.id === id) || {}).name).join(" ");
    return [a.name, a.mention, a.role, a.description, a.category, (a.skills || []).join(" "), (a.tools || []).join(" "), kbNames]
      .some((field) => String(field || "").toLowerCase().includes(q));
  });
}

function renderAgentGrid() {
  const el = $("agentGrid");
  const list = visibleAgents();
  if (!list.length) {
    el.innerHTML =
      '<div class="page-empty">' +
        '<div class="pe-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M8 3h8"/></svg></div>' +
        '<div class="pe-title">没有匹配的智能体</div>' +
        '<div class="pe-hint">调整搜索或筛选条件，也可以新建一个智能体。</div>' +
      "</div>";
    return;
  }
  el.innerHTML = list.map((a) => {
    const color = a.color || "#999999";
    return '<article class="a-card" data-aid="' + a.id + '">' +
      '<div class="ac-top"><div class="ac-avatar" style="background:' + color + "1f;color:" + color + '">' + avatarMarkup(a.avatar) + "</div>" +
      '<div class="ac-body"><div class="ac-name"><span class="ac-name-text">' + esc(a.name) + "</span></div>" +
      '<div class="ac-handle">@' + esc(a.mention || a.name) + " · " + esc(a.category || "通用") + "</div></div></div>" +
      '<div class="ac-desc">' + esc(a.description || a.role || "尚未填写职责简介") + "</div>" +
      (((a.skills && a.skills.length) || (a.kbIds && a.kbIds.length))
        ? '<div class="ac-skills">' +
          (a.skills || []).slice(0, 3).map((skill) => '<span class="chip">' + esc(skill) + "</span>").join("") +
          ((a.kbIds && a.kbIds.length) ? '<span class="chip kb-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>' + a.kbIds.length + " 个知识库</span>" : "") +
          "</div>" : "") +
      '<div class="ac-actions"><button class="chat-cta" data-chat="' + a.id + '">发起对话</button>' +
      '<button class="ac-edit" data-edit="' + a.id + '">配置</button></div>' +
    "</article>";
  }).join("");

  el.querySelectorAll("[data-chat]").forEach((button) => {
    button.onclick = () => startDirectChat(button.dataset.chat);
  });
  el.querySelectorAll("[data-edit]").forEach((button) => {
    button.onclick = () => openAgentDetail(button.dataset.edit);
  });
}

/* ==========================================================================
   知识库视图
   ========================================================================== */
async function loadKbs() { const r = await api.get("/api/kbs"); state.kbs = r.kbs || []; renderKbGrid(); }

function visibleKbs() {
  const q = state.kbQuery.trim().toLowerCase();
  if (!q) return state.kbs;
  return state.kbs.filter((k) => (k.name + " " + (k.description || "")).toLowerCase().includes(q));
}

function renderKbGrid() {
  const el = $("kbGrid");
  const list = visibleKbs();
  if (!list.length) {
    el.innerHTML =
      '<div class="page-empty">' +
        '<div class="pe-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></div>' +
        '<div class="pe-title">' + (state.kbQuery ? "没有匹配的知识库" : "还没有知识库") + "</div>" +
        '<div class="pe-hint">' + (state.kbQuery ? "换个关键词试试" : "创建知识库并上传文档，智能体就能检索引用其中内容") + "</div>" +
      "</div>";
    return;
  }
  el.innerHTML = list.map((kb) => {
    const isDel = state.kbDeleting === kb.id;
    return '<div class="k-card" data-kbid="' + kb.id + '" tabindex="0" role="button" aria-label="' + esc(kb.name) + " · " + kb.docCount + " 篇文档" + '">' +
      '<div class="kc-top">' +
        '<div class="kc-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></div>' +
        '<div style="min-width:0;flex:1">' +
          '<div class="kc-name">' + esc(kb.name) + "</div>" +
          '<div class="kc-meta">' + kb.docCount + "篇文档 · " + kb.chunkCount + " 个片段</div>" +
          '<div class="kc-index-state ' + (kb.embeddingStatus || "disabled") + '">' +
            (kb.embeddingStatus === "ready" ? "语义索引 " + kb.semanticChunkCount + "/" + kb.chunkCount :
              kb.embeddingStatus === "fallback" ? "语义服务异常 · 词法回退" :
              kb.embeddingStatus === "empty" ? "等待文档入库" : "词法检索 · 未配置向量服务") +
          "</div>" +
        "</div>" +
      "</div>" +
      (kb.description ? '<div class="kc-desc">' + esc(kb.description) + "</div>" : "") +
      '<div class="kc-foot"><button class="kc-del' + (isDel ? " confirm" : "") + '" data-del="' + kb.id + '">' + (isDel ? "确认删除" : "删除") + "</button></div>" +
    "</div>";
  }).join("");

  el.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const id = b.dataset.del;
      if (state.kbDeleting === id) {
        await api.del("/api/kbs/" + id);
        state.kbDeleting = null;
        toast("知识库已删除", "ok");
        await loadKbs();
      } else { state.kbDeleting = id; renderKbGrid(); }
    };
  });
  el.querySelectorAll(".k-card").forEach((c) => {
    c.onclick = () => {
      const kb = state.kbs.find((k) => k.id === c.dataset.kbid);
      if (kb) openKbDrawer(kb);
    };
    c.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); c.click(); } };
  });
}

function openKbDrawer(kb) {
  state.currentKb = kb;
  $("dwTitle").textContent = kb.name;
  const indexLabel = kb.embeddingStatus === "ready"
    ? "语义索引 " + kb.semanticChunkCount + "/" + kb.chunkCount
    : (kb.embeddingStatus === "fallback" ? "语义异常，词法回退" : (kb.embeddingStatus === "empty" ? "等待入库" : "词法检索"));
  $("dwSub").textContent = kb.docCount + " 篇文档 · " + kb.chunkCount + " 个片段 · " + indexLabel + (kb.description ? " · " + kb.description : "");
  const docs = kb.docs || [];
  let html = "";
  if (docs.length) {
    html += '<div class="dw-sec-title">文档（' + docs.length + "）</div>";
    html += docs.map((d) => '<button class="kb-doc-item" data-docid="' + d.id + '" aria-label="查看文档 ' + esc(d.name) + '">' +
      '<span><b>' + esc(d.name) + '</b><i>' + (d.charCount || 0).toLocaleString("zh-CN") + ' 字符</i></span>' +
      '<span class="kd-chunks">' + (d.semanticStatus === "ready" ? d.semanticChunks + "/" + d.chunks + " 语义" : d.chunks + " Chunks") +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></span></button>').join("");
  } else {
    html += '<div class="dw-sec-title">文档</div><div class="dw-empty-note">还没有文档，上传一个开始。</div>';
  }
  html += '<div class="dw-sec-title" style="margin-top:20px">添加内容</div>';
  html += '<div class="kb-upload-zone" id="kbUploadZone" tabindex="0" role="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/></svg><span>点击上传文档，或拖拽文件到这里（MD / TXT / PDF / Word / 图片）</span></div>';
  html += '<input type="file" id="kbFileInput" class="hidden" accept=".txt,.md,.json,.csv,.py,.js,.ts,.html,.css,.xml,.yaml,.yml,.pdf,.docx,.png,.jpg,.jpeg,.webp,.bmp,.gif" />';
  html += '<div class="kb-paste-area"><textarea id="kbPasteText" rows="3" placeholder="或直接粘贴文本内容…"></textarea>' +
          '<div class="kb-paste-actions"><button class="primary-btn sm" id="kbPasteBtn">提交入库</button></div></div>';
  html += '<div class="kb-search-preview"><div class="dw-sec-title">检索效果预览</div>' +
    '<div class="kb-search-row"><input id="kbSearchQuery" type="text" placeholder="输入问题，验证语义检索结果" />' +
    '<button class="primary-btn sm" id="kbSearchRun" ' + (kb.chunkCount ? "" : "disabled") + '>检索</button></div><div class="kb-search-results" id="kbSearchResults">' +
    (kb.chunkCount ? "" : '<div class="dw-empty-note">先添加文档，再验证检索效果。</div>') + "</div></div>";
  $("dwBody").innerHTML = html;
  $("kbDrawerMask").classList.remove("hidden");
  $("dwBody").querySelectorAll("[data-docid]").forEach((button) => {
    button.onclick = () => openKbDocument(kb, button.dataset.docid);
  });

  const refresh = async () => {
    await loadKbs();
    const updated = state.kbs.find((k) => k.id === kb.id);
    if (updated) openKbDrawer(updated);
  };
  const upload = async (file) => {
    const form = new FormData();
    form.append("file", file);
    const zone = $("kbUploadZone");
    zone.querySelector("span").textContent = "正在解析并建立索引…";
    try {
      const result = await fetch("/api/kbs/" + kb.id + "/upload", { method: "POST", body: form }).then(parseResponse);
      const item = (result.saved || []).find((entry) => entry.name === file.name) || (result.saved || [])[0];
      if (!item || item.error || !item.id) {
        throw new Error((item && item.error) || "服务未生成文档记录，请检查文件内容和解析配置");
      }
      toast("已上传并完成索引「" + file.name + "」", "ok");
      await refresh();
    } catch (e) {
      zone.querySelector("span").textContent = "点击上传文档，或拖拽文件到这里";
      toast("上传失败，未生成文档记录：" + e.message, "err");
    }
  };

  const zone = $("kbUploadZone");
  zone.onclick = () => $("kbFileInput").click();
  zone.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); zone.click(); } };
  $("kbFileInput").onchange = () => { const f = $("kbFileInput").files[0]; if (f) upload(f); };
  zone.ondragover = (e) => { e.preventDefault(); zone.classList.add("drag"); };
  zone.ondragleave = () => zone.classList.remove("drag");
  zone.ondrop = (e) => {
    e.preventDefault(); zone.classList.remove("drag");
    const f = e.dataTransfer.files[0];
    if (f) upload(f);
  };
  $("kbPasteBtn").onclick = async () => {
    const text = $("kbPasteText").value.trim();
    if (!text) { $("kbPasteText").focus(); return; }
    const button = $("kbPasteBtn");
    button.disabled = true;
    button.textContent = "正在索引…";
    try {
      await api.post("/api/kbs/" + kb.id + "/upload", { text, name: "粘贴文本 " + new Date().toLocaleString("zh-CN") });
      toast("文本已入库并完成索引", "ok");
      await refresh();
    } catch (e) {
      button.disabled = false;
      button.textContent = "提交入库";
      toast("提交失败：" + e.message, "err");
    }
  };

  const runSearch = async () => {
    const query = $("kbSearchQuery").value.trim();
    if (!query) { $("kbSearchQuery").focus(); return; }
    const results = $("kbSearchResults");
    const button = $("kbSearchRun");
    button.disabled = true;
    button.textContent = "检索中…";
    results.innerHTML = '<div class="dw-empty-note">正在计算相关度…</div>';
    try {
      const response = await api.post("/api/kbs/" + kb.id + "/search", { query });
      state.rag = response.rag || state.rag;
      if (!response.hits.length) {
        results.innerHTML = '<div class="dw-empty-note">没有找到相关片段，请换一种问法。</div>';
      } else {
        const typeName = { hybrid: "混合", semantic: "语义", lexical: "词法" };
        results.innerHTML = response.hits.map((hit) => '<div class="kb-hit"><div class="kb-hit-head"><strong>' + esc(hit.source) +
          '</strong><span class="kb-hit-type">' + (typeName[hit.matchType] || "检索") + '</span><span class="kb-hit-score">' +
          Math.round(hit.score * 100) + '%</span></div><div class="kb-hit-text">' + esc(hit.text) + "</div></div>").join("");
      }
    } catch (e) {
      results.innerHTML = '<div class="dw-empty-note">检索失败：' + esc(e.message) + "</div>";
    } finally {
      button.disabled = false;
      button.textContent = "检索";
    }
  };
  $("kbSearchRun").onclick = runSearch;
  $("kbSearchQuery").onkeydown = (e) => { if (e.key === "Enter") runSearch(); };
}

async function openKbDocument(kb, docId) {
  $("dwTitle").textContent = "正在载入文档…";
  $("dwSub").textContent = kb.name;
  $("dwBody").innerHTML = '<div class="doc-loading">正在读取全文与分块…</div>';
  try {
    const response = await api.get("/api/kbs/" + encodeURIComponent(kb.id) + "/docs/" + encodeURIComponent(docId));
    renderKbDocument(kb, response.document);
  } catch (error) {
    $("dwBody").innerHTML = '<div class="doc-loading error">读取失败：' + esc(error.message) + "</div>";
  }
}

function renderKbDocument(kb, doc) {
  $("dwTitle").textContent = doc.name;
  $("dwSub").textContent = kb.name + " · " + doc.charCount.toLocaleString("zh-CN") + " 字符 · " + doc.chunkCount + " 个 Chunks";
  const semanticLabel = doc.semanticStatus === "ready"
    ? "语义索引完成 · " + esc(doc.semanticModel || "")
    : (doc.semanticStatus === "fallback" ? "语义索引失败 · 当前使用词法检索" : "未启用语义索引");
  $("dwBody").innerHTML =
    '<button class="doc-back" id="docBack"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>返回知识库</button>' +
    '<div class="doc-view-head"><div class="doc-tabs" role="tablist">' +
      '<button class="doc-tab active" data-doc-tab="full" role="tab" aria-selected="true">全文</button>' +
      '<button class="doc-tab" data-doc-tab="chunks" role="tab" aria-selected="false">Chunks <span>' + doc.chunkCount + "</span></button></div>" +
      '<button class="ghost-btn sm" id="docCopy">复制全文</button></div>' +
    '<div class="doc-index-note ' + (doc.semanticStatus || "disabled") + '"><span></span>' + semanticLabel + "</div>" +
    '<section class="doc-panel" data-doc-panel="full"><pre class="doc-fulltext">' + esc(doc.fullText || "（空文档）") + "</pre></section>" +
    '<section class="doc-panel hidden" data-doc-panel="chunks"><div class="doc-chunk-list">' +
      doc.chunks.map((chunk) => '<article class="doc-chunk"><header><span class="doc-chunk-no">Chunk ' + (chunk.index + 1) +
        '</span><span>' + chunk.charCount + ' 字符</span><span class="doc-vector-state ' + (chunk.semanticReady ? "ready" : "") + '">' +
        (chunk.semanticReady ? "已向量化" : "词法索引") + '</span><button data-copy-chunk="' + chunk.index + '">复制</button></header>' +
        '<pre>' + esc(chunk.text) + "</pre></article>").join("") + "</div></section>";

  $("docBack").onclick = () => openKbDrawer(kb);
  $("docCopy").onclick = async () => {
    const chunksMode = $("dwBody").querySelector('[data-doc-tab="chunks"]').classList.contains("active");
    const text = chunksMode ? doc.chunks.map((chunk, index) => "--- Chunk " + (index + 1) + " ---\n" + chunk.text).join("\n\n") : (doc.fullText || "");
    try { await navigator.clipboard.writeText(text); toast(chunksMode ? "全部 Chunks 已复制" : "全文已复制", "ok"); }
    catch (_error) { toast("复制失败，请手动选择文本", "err"); }
  };
  $("dwBody").querySelectorAll("[data-doc-tab]").forEach((tab) => {
    tab.onclick = () => {
      $("dwBody").querySelectorAll("[data-doc-tab]").forEach((item) => {
        const active = item === tab;
        item.classList.toggle("active", active);
        item.setAttribute("aria-selected", String(active));
      });
      $("dwBody").querySelectorAll("[data-doc-panel]").forEach((panel) => {
        panel.classList.toggle("hidden", panel.dataset.docPanel !== tab.dataset.docTab);
      });
      $("docCopy").textContent = tab.dataset.docTab === "full" ? "复制全文" : "复制全部 Chunks";
    };
  });
  $("dwBody").querySelectorAll("[data-copy-chunk]").forEach((button) => {
    button.onclick = async () => {
      const chunk = doc.chunks[Number(button.dataset.copyChunk)];
      try { await navigator.clipboard.writeText(chunk.text); toast("Chunk 已复制", "ok"); }
      catch (_error) { toast("复制失败，请手动选择文本", "err"); }
    };
  });
}

function closeKbDrawer() { $("kbDrawerMask").classList.add("hidden"); state.currentKb = null; }

/* ==========================================================================
   会话列表
   ========================================================================== */
async function loadConvs() {
  const r = await api.get("/api/conversations");
  state.convs = r.conversations || [];
  renderConvSwitch();
}

const agentOf = (id) => state.agents.find((a) => a.id === id) || null;
const userOf = (id) => {
  if (!id) return null;
  if (state.user && state.user.id === id) return state.user;
  const friend = state.friends.find((item) => item.user && item.user.id === id);
  return friend ? friend.user : null;
};
function humanMember(id) {
  const user = userOf(id);
  return user ? {
    id: user.id,
    name: user.displayName || user.login || user.id,
    avatar: user.avatarUrl || "",
    color: "#FF5A36",
    type: "human",
  } : {
    id,
    name: id,
    avatar: "",
    color: "#FF5A36",
    type: "human",
  };
}
function conversationAvatarMembers(conv) {
  if (!conv) return [];
  const agents = (conv.memberAgentIds || []).map((id) => agentOf(id)).filter(Boolean).map((agent) => Object.assign({ type: "agent" }, agent));
  const users = (conv.memberUserIds || []).filter((id) => !state.user || id !== state.user.id).map(humanMember);
  return agents.concat(users).slice(0, 4);
}

function visibleConvs() {
  const q = state.convQuery.trim().toLowerCase();
  const assistant = state.agents.find((x) => x.id === "research_assistant" || x.mention === "assistant");
  return state.convs
    .filter((c) => {
      if (state.convKind !== "all" && (c.kind || "group") !== state.convKind) return false;
      if (!q) return true;
      return (c.title || "").toLowerCase().includes(q);
    })
    .sort((a, b) => {
      // 科研小助理始终置顶
      const aTop = assistant && a.memberAgentIds && a.memberAgentIds.length === 1 && a.memberAgentIds[0] === assistant.id ? 0 : 1;
      const bTop = assistant && b.memberAgentIds && b.memberAgentIds.length === 1 && b.memberAgentIds[0] === assistant.id ? 0 : 1;
      return aTop - bTop;
    });
}

function avatarStackHTML(members, cls) {
  const items = (members || []).slice(0, 4);
  if (!items.length) return "";
  return items.map((member) =>
    '<span class="' + cls + '" style="background:' + (member.color || "#999") + "1f;color:" + (member.color || "#999") + '">' + avatarMarkup(member.avatar, presetFor(member.id || member.name)) + "</span>"
  ).join("");
}

function renderConvSwitch() {
  const el = $("convSwitch");
  const list = visibleConvs();
  el.innerHTML = "";
  if (!state.convs.length) return;
  if (!list.length) { el.innerHTML = '<div class="sb-empty">没有匹配的聊天</div>'; return; }

  for (const c of list) {
    const isActive = state.currentConv && c.id === state.currentConv.id;
    const isDeleting = state.convDeleting === c.id;
    const kind = c.kind || "group";
    const avatarMembers = conversationAvatarMembers(c);
    const n = avatarMembers.length;
    const unread = isActive ? 0 : Math.max(0, Number(c.unreadCount || 0));
    const unreadLabel = unread ? " · " + unread + " 条未读消息" : "";

    let preview;
    if (c.lastMessage) {
      const lm = c.lastMessage;
      const who = lm.authorType === "human"
        ? (lm.author && state.user && lm.author === state.user.id ? "我" : (lm.authorName || "我"))
        : (lm.authorName || "");
      preview = '<span class="cip-who">' + esc(who) + "：</span>" + esc(lm.content);
    } else {
      preview = kind === "direct" ? "还没有对话" : (c.memberAgentIds || []).length + " 位成员 · 还没有发言";
    }

    const d = document.createElement("div");
    d.className = "conv-item" + (isActive ? " active" : "");
    d.dataset.convId = c.id;
    d.tabIndex = 0;
    d.setAttribute("role", "button");
    d.setAttribute("aria-label", c.title + " · " + (kind === "group" ? "群聊" : "单聊") + unreadLabel);
    d.innerHTML =
      '<div class="ci-avatar n' + n + '">' + avatarStackHTML(avatarMembers, "cia") + "</div>" +
      '<div class="ci-body">' +
        '<div class="ci-row"><span class="ci-title">' +
          '<span class="ci-name">' + esc(convDisplayTitle(c)) + "</span>" +
          (kind === "group" ? '<span class="ci-kind">群</span>' : "") +
        '</span><span class="ci-meta"><span class="ci-time">' + fmtConvTime(c.updatedAt) + "</span>" +
          (unread ? '<span class="ci-unread" aria-label="' + unread + ' 条未读消息">' + (unread > 99 ? "99+" : unread) + "</span>" : "") +
        "</span></div>" +
        '<div class="ci-preview">' + (c.status === "running" ? '<span class="ci-live"></span>' : "") + preview + "</div>" +
      "</div>" +
      '<button class="ci-del' + (isDeleting ? " confirm" : "") + '" data-del="' + c.id + '" title="删除">' + (isDeleting ? "确认删除" : "×") + "</button>";
    d.onclick = (e) => { if (e.target.closest("[data-del]")) return; openConv(c.id); };
    d.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (!e.target.closest("[data-del]")) openConv(c.id); } };
    el.appendChild(d);
  }
  el.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const cid = btn.dataset.del;
      if (state.convDeleting === cid) await deleteConv(cid);
      else { state.convDeleting = cid; renderConvSwitch(); }
    };
  });
}

async function deleteConv(id) {
  try {
    await api.del("/api/conversations/" + id);
    if (state.currentConv && state.currentConv.id === id) {
      disconnectSSE();
      state.currentConv = null;
      state.streaming = {};
      state.lastSpeakerName = null;
      state.memberStatus = {};
      renderChat();
      updateSendBtn();
    }
    state.convDeleting = null;
    await loadConvs();
    toast("已删除", "ok");
  } catch (e) {
    toast("删除失败：" + e.message, "err");
    state.convDeleting = null;
    renderConvSwitch();
  }
}

/* ==========================================================================
   发起单聊 / 群聊
   ========================================================================== */
async function startDirectChat(agentId) {
  const a = agentOf(agentId);
  if (!a) return;
  // 已有同一Agent 的单聊则直接复用
  const existing = state.convs.find((c) => (c.kind || "") === "direct" && (c.memberAgentIds || []).length === 1 && c.memberAgentIds[0] === agentId);
  switchView("chat");
  if (existing) { await openConv(existing.id); return; }
  try {
    const r = await api.post("/api/conversations", {
      title: a.name,
      memberAgentIds: [agentId],
      kind: "direct",
      autoRoute: true,
    });
    await loadConvs();
    await openConv(r.conversation.id);
    toast("已和「" + a.name + "」建立单聊", "ok");
  } catch (e) { toast("创建失败：" + e.message, "err"); }
}

function pickerAgents() {
  return [...state.agents].sort((a, b) => Number(b.id === "coordinator") - Number(a.id === "coordinator"));
}
function acceptedFriends() { return state.friends.filter((friend) => friend.status === "accepted"); }
async function loadFriends() {
  const response = await api.get("/api/friends");
  state.friends = response.friends || [];
  return state.friends;
}
function friendLabel(friend) {
  const user = friend.user || {};
  return esc(user.displayName || user.login || user.id);
}
// 纯人类私聊的会话标题：对双方都显示「对方」的昵称，而非共享的创建标题。
function convDisplayTitle(c) {
  if (c && c.kind === "direct" && (!c.memberAgentIds || !c.memberAgentIds.length) &&
      (c.memberUserIds || []).length === 2 && state.user) {
    const otherId = (c.memberUserIds || []).find((id) => id !== state.user.id);
    if (otherId) {
      const friend = state.friends.find((f) => f.user && f.user.id === otherId);
      if (friend && friend.user) return friend.user.displayName || friend.user.login || friend.user.id;
    }
  }
  return c ? c.title : "";
}
function renderFriendsView() {
  const requests = state.friends.filter((friend) => friend.status === "pending" && friend.direction === "incoming");
  const friends = acceptedFriends();
  $("friendRequestsList").innerHTML = requests.length ? requests.map((friend) =>
    '<div class="friend-item"><span class="friend-avatar">' + avatarMarkup(friend.user.avatarUrl, presetFor(friend.user.id)) + '</span><div class="friend-item-main"><b>' + friendLabel(friend) + '</b><small>' + esc(friend.user.id) + '</small></div>' +
    '<button class="primary-btn sm" data-friend-respond="accept" data-user-id="' + esc(friend.user.id) + '">同意</button><button class="ghost-btn sm" data-friend-respond="reject" data-user-id="' + esc(friend.user.id) + '">拒绝</button></div>'
  ).join("") : '<div class="dw-empty-note">暂无待处理申请</div>';
  $("friendsList").innerHTML = friends.length ? friends.map((friend) =>
    '<div class="friend-item"><span class="friend-avatar">' + avatarMarkup(friend.user.avatarUrl, presetFor(friend.user.id)) + '</span><div class="friend-item-main"><b>' + friendLabel(friend) + '</b><small>' + esc(friend.user.id) + '</small></div></div>'
  ).join("") : '<div class="dw-empty-note">还没有好友</div>';
  document.querySelectorAll("[data-friend-respond]").forEach((button) => {
    button.onclick = async () => {
      try {
        const res = await api.post("/api/friends/respond", { userId: button.dataset.userId, accepted: button.dataset.friendRespond === "accept" });
        await loadFriends(); renderFriendsView();
        if (button.dataset.friendRespond === "accept" && res.friendship && res.friendship.status === "accepted") await loadConvs();
        toast(button.dataset.friendRespond === "accept" ? "已添加好友" : "已拒绝申请", "ok");
      } catch (error) { toast("处理失败：" + error.message, "err"); }
    };
  });
}
async function openFriendsView() {
  try { await loadFriends(); renderFriendsView(); }
  catch (error) { toast("读取好友失败：" + error.message, "err"); }
}

function openDirectPicker() {
  const el = $("directPickList");
  el.innerHTML = pickerAgents().map((a) =>
    '<div class="agent-option-card pick-item" data-aid="' + a.id + '" tabindex="0" role="button" aria-label="与' + esc(a.name) + '开始单聊">' +
      '<div class="agent-option-main"><div class="agent-option-name">' + esc(a.name) + '<span class="agent-option-handle">@' + esc(a.mention) + "</span></div>" +
      '<div class="agent-option-role">' + esc(a.role || "科研智能体") + '</div></div><span class="agent-option-action">开始</span></div>'
  ).join("");
  el.querySelectorAll(".pick-item").forEach((item) => {
    item.onclick = () => { closeModal($("directModal")); startDirectChat(item.dataset.aid); };
    item.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); item.click(); } };
  });
  openModal($("directModal"));
  setTimeout(() => { const first = el.querySelector(".pick-item"); if (first) first.focus(); }, 60);
}

function openGroupModal() {
  state.wizard = { step: 0, title: "", memberIds: ["coordinator"], memberUserIds: [] };
  renderGroupStep();
  openModal($("groupModal"));
}

function renderGroupStep() {
  const s = state.wizard.step;
  let dots = "";
  for (let i = 0; i < GROUP_STEPS; i++) dots += '<i class="' + (i === s ? "on" : i < s ? "done" : "") + '"></i>';
  $("wizardDots").innerHTML = dots;
  $("wizardTitle").textContent = ["群名称", "选择成员"][s];
  $("wizardSub").textContent = ["给这个群起个名字", "选择好友与智能体；科研协调员为必选智能体"][s];
  $("groupPrev").classList.toggle("hidden", s === 0);
  $("groupNext").textContent = s === GROUP_STEPS - 1 ? "创建群聊" : "下一步";

  const body = $("wizardBody");
  body.innerHTML = "";

  if (s === 0) {
    body.innerHTML = '<input type="text" id="wTitle" placeholder="如：自供电传感器方案讨论" value="' + esc(state.wizard.title) + '" />';
    const inp = $("wTitle");
    setTimeout(() => inp.focus(), 60);
    inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); groupNext(); } };
    return;
  }

  const agentChoices = pickerAgents().map((a) => {
    const required = a.id === "coordinator";
    return '<label class="agent-option-card member-pick' + (required ? " is-required" : "") + '"><input type="checkbox" data-aid="' + a.id + '" ' +
      (state.wizard.memberIds.includes(a.id) ? "checked " : "") + (required ? 'disabled aria-label="科研协调员，必选成员" ' : "") + "/>" +
      '<span class="agent-option-main"><span class="agent-option-name">' + esc(a.name) + '<span class="agent-option-handle">@' + esc(a.mention) + "</span></span>" +
      '<span class="agent-option-role">' + esc(a.role || "科研智能体") + "</span></span>" + (required ? '<span class="agent-option-required">必选</span>' : "") + "</label>";
  }).join("");
  const friendChoices = acceptedFriends().map((friend) => '<label class="agent-option-card member-pick"><input type="checkbox" data-user-id="' + esc(friend.user.id) + '" ' +
    (state.wizard.memberUserIds.includes(friend.user.id) ? "checked " : "") + '/><span class="agent-option-main"><span class="agent-option-name">' + friendLabel(friend) +
    '</span><span class="agent-option-role">好友 · ' + esc(friend.user.id) + '</span></span></label>').join("");
  body.innerHTML = '<div class="pick-section"><b>智能体</b><div class="check-grid">' + agentChoices + '</div></div>' +
    '<div class="pick-section"><b>好友</b><div class="check-grid">' + (friendChoices || '<div class="dw-empty-note">暂无好友，可先在账户设置中添加。</div>') + '</div></div>';
  body.querySelectorAll("input[data-aid]:not(:disabled)").forEach((cb) => { cb.onchange = () => {
    state.wizard.memberIds = cb.checked ? Array.from(new Set([...state.wizard.memberIds, cb.dataset.aid])) : state.wizard.memberIds.filter((id) => id !== cb.dataset.aid);
  }; });
  body.querySelectorAll("input[data-user-id]").forEach((cb) => { cb.onchange = () => {
    state.wizard.memberUserIds = cb.checked ? Array.from(new Set([...state.wizard.memberUserIds, cb.dataset.userId])) : state.wizard.memberUserIds.filter((id) => id !== cb.dataset.userId);
  }; });
}

async function groupNext() {
  const s = state.wizard.step;
  if (s === 0) {
    const t = $("wTitle").value.trim();
    if (!t) { $("wTitle").focus(); toast("请先填写群名称"); return; }
    state.wizard.title = t;
    state.wizard.step = 1;
    renderGroupStep();
    return;
  }

  if (!state.wizard.memberIds.includes("coordinator")) {
    state.wizard.memberIds.unshift("coordinator");
  }
  if (state.wizard.memberIds.length + state.wizard.memberUserIds.length < 2) {
    toast("请至少再选择一位好友或专业智能体");
    return;
  }

  try {
    const r = await api.post("/api/conversations", {
      title: state.wizard.title,
      memberAgentIds: state.wizard.memberIds,
      memberUserIds: state.wizard.memberUserIds,
      kind: "group",
      autoRoute: false,
    });
    closeModal($("groupModal"));
    switchView("chat");
    await loadConvs();
    await openConv(r.conversation.id);
    toast("群聊已创建", "ok");
  } catch (e) { toast("创建失败：" + e.message, "err"); }
}

/* ==========================================================================
   打开会话 / SSE
   ========================================================================== */
function hasActiveStreaming() { return Object.keys(state.streaming || {}).length > 0; }

function disconnectGlobalSSE() {
  if (state.globalEvtSource) { state.globalEvtSource.close(); state.globalEvtSource = null; }
  if (state.conversationRefreshTimer) { clearTimeout(state.conversationRefreshTimer); state.conversationRefreshTimer = null; }
}

function scheduleConversationRefresh() {
  if (!state.user || state.conversationRefreshTimer) return;
  state.conversationRefreshTimer = setTimeout(async () => {
    state.conversationRefreshTimer = null;
    try { await loadConvs(); } catch (error) { console.warn("[SSE] 会话列表刷新失败", error); }
  }, 80);
}

function onGlobalEvent(event) {
  if (!event || !state.user) return;
  if (event.type === "conversation_updated" || event.type === "conversation_deleted") { scheduleConversationRefresh(); return; }
  if (event.type === "profile_updated" && event.user && event.user.id) {
    if (event.user.id === state.user.id) state.user = event.user;
    const index = state.friends.findIndex((item) => item.user && item.user.id === event.user.id);
    if (index >= 0) state.friends[index] = Object.assign({}, state.friends[index], { user: event.user });
    refreshAvatarViews();
  }
}

function connectGlobalSSE() {
  if (!state.user || state.globalEvtSource) return;
  const es = new EventSource("/api/events");
  state.globalEvtSource = es;
  es.onmessage = (ev) => {
    try { onGlobalEvent(JSON.parse(ev.data)); }
    catch (error) { console.warn("[SSE] 全局事件解析失败", error); }
  };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED && state.globalEvtSource === es) state.globalEvtSource = null;
  };
}

function clearLocalUnread(convId) {
  const summary = state.convs.find((item) => item.id === convId);
  if (!summary || !summary.unreadCount) return;
  summary.unreadCount = 0;
  renderConvSwitch();
}

async function markCurrentConversationRead() {
  const conv = state.currentConv;
  if (!conv) return;
  clearLocalUnread(conv.id);
  try {
    const response = await api.post("/api/conversations/" + conv.id + "/read");
    const index = state.convs.findIndex((item) => item.id === conv.id);
    if (index >= 0 && response.conversation) {
      state.convs[index] = response.conversation;
      renderConvSwitch();
    }
  } catch (error) { console.warn("[read] 标记已读失败", error); }
}

function disconnectSSE() {
  if (state.evtSource) { state.evtSource.close(); state.evtSource = null; }
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  state.reconnectTries = 0;
  hideReconnectToast();
}

async function openConv(id) {
  if (state.currentConv && state.currentConv.id === id) return;
  if (hasActiveStreaming() && !confirm("当前有智能体正在发言，切换聊天将中断输出，是否继续？")) return;
  disconnectSSE();
  const r = await api.get("/api/conversations/" + id);
  try { await loadFriends(); } catch (error) { console.warn("[friends] 资料刷新失败", error); }
  state.currentConv = r.conversation;
  clearLocalUnread(id);
  state.streaming = {};
  state.lastSpeakerName = null;
  state.convDeleting = null;
  $("viewChat").classList.add("on-conv");
  renderConvSwitch();
  renderChat();
  updateSendBtn();
  connectSSE(id);
}

function connectSSE(convId) {
  const es = new EventSource("/api/conversations/" + convId + "/stream");
  state.evtSource = es;
  es.onmessage = (ev) => { try { onEvent(JSON.parse(ev.data)); } catch (e) { console.warn("[SSE] parse error", e); } };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) { state.evtSource = null; attemptReconnect(convId); }
  };
}

function attemptReconnect(convId) {
  if (state.reconnectTries >= state.maxReconnectTries) {
    toast("连接已断开，请刷新页面", "err");
    hideReconnectToast();
    return;
  }
  state.reconnectTries++;
  const delay = Math.min(1000 * Math.pow(2, state.reconnectTries), 30000);
  showReconnectToast(state.reconnectTries);
  state.reconnectTimer = setTimeout(() => {
    if (state.currentConv && state.currentConv.id === convId) connectSSE(convId);
  }, delay);
}

function showReconnectToast(tries) {
  $("reconnectText").textContent = "连接断开，正在重连…（第 " + tries + " 次）";
  $("reconnectToast").classList.remove("hidden");
}
function hideReconnectToast() { const el = $("reconnectToast"); if (el) el.classList.add("hidden"); }

function setStatus(s, ap) {
  const el = $("chatStatus");
  el.className = "chat-status" + (s === "running" ? " running" : ap ? " approval" : "");
  el.textContent = ap ? "等待你拍板" : (s === "running" ? "回复中" : "");
}

/* ==========================================================================
   聊天渲染
   ========================================================================== */
const feedEl = () => $("chatFeed");
let feedGroup = { author: null, ts: 0 };

function atBottom() {
  const b = feedEl();
  return b.scrollHeight - b.scrollTop - b.clientHeight < 140;
}
function scrollFeed(force) {
  const b = feedEl();
  const jl = $("jumpLatest");
  if (force || state.stick) { b.scrollTop = b.scrollHeight; state.stick = true; jl.classList.remove("show"); }
  else jl.classList.add("show");
}

function convMembers() {
  const conv = state.currentConv;
  if (!conv) return [];
  return (conv.memberAgentIds || []).map((id) => agentOf(id)).filter(Boolean);
}
const isGroup = () => state.currentConv && (state.currentConv.kind || "group") === "group";

function renderChat() {
  const box = feedEl();
  const conv = state.currentConv;
  box.innerHTML = "";
  feedGroup = { author: null, ts: 0 };
  state.memberStatus = {};
  state.streaming = {};
  state.stick = true;
  renderTypingStrip();
  renderChatHeader();
  renderQuickMentions();
  renderKbMount();
  $("approvalBar").classList.add("hidden");

  if (!conv) {
    box.innerHTML =
      '<div class="feed-empty">' +
        '<div class="es-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></div>' +
        '<div class="es-text">开始一段对话</div>' +
        '<div class="es-hint">和单个智能体一对一深聊，<br/>或者拉几位专家进群一起讨论</div>' +
        '<div class="es-btns"><button class="ghost-btn sm" id="feedDirect">发起单聊</button><button class="primary-btn sm" id="feedGroup">创建群聊</button></div>' +
      "</div>";
    const bd = $("feedDirect"), bg = $("feedGroup");
    if (bd) bd.onclick = openDirectPicker;
    if (bg) bg.onclick = openGroupModal;
    setStatus("idle");
    return;
  }
  const humanCount = (conv.memberUserIds || [state.user && state.user.id]).length;
  if (!convMembers().length && humanCount < 2) {
    box.innerHTML = '<div class="feed-empty"><div class="es-text">该聊天没有可用成员</div><div class="es-hint">相关成员可能已不可用</div></div>';
    return;
  }
  // 单聊不显示成员已加入等群聊系统提示
  if (isGroup()) appendSystemLine((convMembers().length + humanCount) + " 位成员已加入群聊");
  for (const m of (conv.messages || [])) routeMessage(m);
  setStatus(conv.status, conv.pendingApproval);
  if (conv.pendingApproval) showGlobalApproval(conv.pendingApproval);
  scrollFeed(true);
}

function renderChatHeader() {
  const conv = state.currentConv;
  const avEl = $("chatAvatar");
  const titleEl = $("chatTitle");
  const membersEl = $("chatMembers");
  membersEl.innerHTML = "";

  if (!conv) {
    avEl.className = "ch-avatar ch-avatar-empty";
    avEl.innerHTML = "";
    titleEl.textContent = "选择一个聊天";
    $("chatSub").textContent = "或从「科研市场」里挑一位开始单聊";
    return;
  }

  const members = convMembers();
  const avatarMembers = conversationAvatarMembers(conv);
  const n = avatarMembers.length;
  avEl.className = "ch-avatar n" + n;
  avEl.innerHTML = avatarStackHTML(avatarMembers, "cha") || '<span class="cha-fallback">§</span>';

  if (isGroup()) {
    titleEl.innerHTML = '<span class="ch-title-text">' + esc(conv.title) + "</span>";
    const humanCount = (conv.memberUserIds || [state.user && state.user.id]).length;
    $("chatSub").textContent = (members.length + humanCount) + " 位成员（" + humanCount + " 位用户 · " + members.length + " 个智能体） · " + (conv.messages ? conv.messages.length : 0) + " 条消息";
    for (const a of members) {
      const d = document.createElement("div");
      d.className = "cm-avatar";
      d.dataset.agentId = a.id;
      d.dataset.status = state.memberStatus[a.id] || "idle";
      d.title = a.name + " @" + a.mention + (a.role ? " · " + a.role : "") + "（点击 @ 他）";
      d.style.background = (a.color || "#999") + "1f";
      d.style.color = a.color || "#999";
      d.innerHTML = avatarMarkup(a.avatar, presetFor(a.id));
      d.onclick = () => insertMention(a);
      membersEl.appendChild(d);
    }
    for (const person of (conv.memberUserIds || []).filter((id) => !state.user || id !== state.user.id).map(humanMember)) {
      const d = document.createElement("div");
      d.className = "cm-avatar";
      d.title = person.name;
      d.style.background = person.color + "1f";
      d.style.color = person.color;
      d.innerHTML = avatarMarkup(person.avatar, presetFor(person.id));
      membersEl.appendChild(d);
    }
  } else {
    const a = members[0] || {};
    const isHumanDirect = !(conv.memberAgentIds || []).length;
    titleEl.innerHTML = '<span class="ch-title-text">' + esc(convDisplayTitle(conv)) + "</span>" + '<span class="ch-tag">单聊</span>';
    $("chatSub").textContent = isHumanDirect ? "好友私聊" : (a.role || "");
  }
  titleEl.title = conv.title;
}

function renderQuickMentions() {
  const el = $("quickMentions");
  el.innerHTML = "";
  if (!isGroup()) return; // 单聊不需要 @
  for (const a of convMembers()) {
    const b = document.createElement("button");
    b.className = "qm-chip";
    b.type = "button";
    b.title = "@ " + a.name;
    b.textContent = "@" + (a.mention || a.id);
    b.onclick = () => insertMention(a);
    el.appendChild(b);
  }
}

function currentConvKbIds() {
  const conv = state.currentConv;
  if (!conv || !conv.config) return [];
  return conv.config.kbIds || [];
}

function renderKbMount() {
  const btn = $("kbMountBtn");
  const wrap = $("kbMountWrap");
  const label = $("kbMountLabel");
  const count = $("kbMountCount");
  const conv = state.currentConv;
  if (!conv) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  const ids = currentConvKbIds();
  const n = ids.length;
  count.textContent = n;
  count.classList.toggle("hidden", n === 0);
  label.textContent = n ? "知识库" : "知识库";
  btn.classList.toggle("has-kb", n > 0);
}

function renderKbPop() {
  const list = $("kbPopList");
  const ids = new Set(currentConvKbIds());
  if (!state.kbs.length) {
    list.innerHTML = '<div class="kb-pop-empty">暂无知识库，请先到「知识库」页创建。</div>';
    return;
  }
  list.innerHTML = state.kbs.map((kb) =>
    '<label class="kb-pop-option"><input type="checkbox" data-kbid="' + kb.id + '" ' + (ids.has(kb.id) ? "checked" : "") + ' />' +
    '<span class="kb-pop-ic">📚</span><span class="kb-pop-body"><b>' + esc(kb.name) + '</b><i>' + kb.docCount + ' 篇文档 · ' + kb.chunkCount + ' 个片段</i></span></label>'
  ).join("");
  list.querySelectorAll("input[data-kbid]").forEach((input) => {
    input.onchange = async () => {
      const id = input.dataset.kbid;
      let next = currentConvKbIds().slice();
      if (input.checked && !next.includes(id)) next.push(id);
      else if (!input.checked) next = next.filter((x) => x !== id);
      const prev = currentConvKbIds();
      if (!state.currentConv) return;
      // 乐观更新
      state.currentConv.config.kbIds = next;
      renderKbMount();
      try {
        await api.patch("/api/conversations/" + state.currentConv.id, { kbIds: next });
        const fresh = state.convs.find((c) => c.id === state.currentConv.id);
        if (fresh) fresh.config = Object.assign({}, fresh.config, { kbIds: next });
        toast(next.length ? "已挂载 " + next.length + " 个知识库" : "已取消知识库挂载", "ok");
      } catch (error) {
        state.currentConv.config.kbIds = prev;
        renderKbMount();
        renderKbPop();
        toast("更新知识库失败：" + error.message, "err");
      }
    };
  });
}

function toggleKbPop() {
  const pop = $("kbPop");
  const willOpen = pop.classList.contains("hidden");
  if (willOpen) {
    renderKbPop();
    const btn = $("kbMountBtn");
    const rect = btn.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);
    pop.style.width = width + "px";
    pop.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + "px";
    pop.style.bottom = (window.innerHeight - rect.top + 8) + "px";
  }
  pop.classList.toggle("hidden", !willOpen);
}

function setMemberStatus(agentId, status) {
  state.memberStatus[agentId] = status;
  const av = document.querySelector('#chatMembers .cm-avatar[data-agent-id="' + agentId + '"]');
  if (av) av.dataset.status = status;
}

function renderTypingStrip() {
  const el = $("typingStrip");
  const ids = Object.keys(state.streaming || {});
  if (!ids.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  el.classList.remove("hidden");
  el.innerHTML = ids.map((id) => {
    const a = agentOf(id) || {};
    const s = state.streaming[id];
    return '<span class="ts-chip"><span class="ts-dot" style="background:' + (a.color || "#999") + '"></span>' +
      esc(a.name || id) + (s && s.text ? " 正在输出…" : " 正在思考…") + "</span>";
  }).join("");
}

function getHandoffSource(msg) {
  const conv = state.currentConv;
  if (!conv || !isGroup()) return null;
  const idx = conv.messages.indexOf(msg);
  if (idx < 1) return null;
  const agent = agentOf(msg.author);
  if (!agent) return null;
  const myMention = (agent.mention || agent.id).toLowerCase();
  for (let i = idx - 1; i >= 0; i--) {
    const prev = conv.messages[i];
    if (prev.authorType !== "agent") continue;
    if (prev.author === msg.author) continue;
    if ((prev.mentions || []).map((m) => m.toLowerCase()).includes(myMention)) return prev.authorName || prev.author;
    break;
  }
  return null;
}

function routeMessage(msg) {
  if (msg.authorType === "system") { appendSystemLine(msg.content); return; }
  if (msg.authorType === "human") { state.lastSpeakerName = null; appendHumanMsg(msg); return; }
  appendAgentMsg(msg, getHandoffSource(msg));
  state.lastSpeakerName = msg.authorName;
}

function msgShell(o) {
  const grouped = !o.noGroup && feedGroup.author === o.key && (o.ts || 0) - feedGroup.ts < 180000 && !o.handoff;
  const el = document.createElement("div");
  el.className = "msg" + (o.me ? " me" : "") + (grouped ? " grouped" : "");
  el.dataset.author = o.key;
  if (o.msgId) el.dataset.msgId = o.msgId;
  const color = o.color || "#999";
  // 我：使用当前账户的头像与用户名；其他：保持 emoji + 浅色背景
  const fallbackAvatar = presetFor(o.key || o.name);
  const avatar = o.me
    ? '<div class="msg-avatar" style="background:' + color + '22;color:' + color + '">' + (o.avatar ? avatarMarkup(o.avatar, fallbackAvatar) : esc((o.name || "我").slice(0, 1))) + "</div>"
    : '<div class="msg-avatar" style="background:' + color + "1f;color:" + color + '">' + avatarMarkup(o.avatar, fallbackAvatar) + "</div>";
  el.innerHTML =
    avatar +
    '<div class="msg-main">' +
      (o.handoff ? '<div class="msg-handoff">↩ ' + esc(o.handoff) + " 转交</div>" : "") +
      '<div class="msg-meta"><span class="msg-name">' + esc(o.name) + "</span>" +
        (o.handle ? '<span class="msg-handle">@' + esc(o.handle) + "</span>" : "") +
        '<span class="msg-time">' + esc(o.timeText || fmtTime(o.ts)) + "</span></div>" +
      '<div class="msg-slot"></div>' +
    "</div>";
  feedEl().appendChild(el);
  feedGroup = { author: o.key, ts: o.ts || Date.now() };
  return el;
}

function bubbleHTML(msg) {
  let html = "";
  if (msg.reasoning) html += '<details class="reasoning"><summary>思考过程</summary><div class="reasoning-body">' + esc(msg.reasoning) + "</div></details>";
  html += '<div class="bubble">' + md(msg.content) + "</div>";
  if (msg.meta && msg.meta.kbHits && msg.meta.kbHits.length) {
    html += '<div class="msg-foot"><span class="kb-ref">📎 引用 ' + msg.meta.kbHits.length + " 条知识库</span></div>";
  }
  return html;
}

function attachApproval(slot, msg) {
  const active = state.currentConv && state.currentConv.pendingApproval;
  if (!msg.pendingApproval || !active) return;
  if (active.messageId !== msg.id || active.id !== msg.pendingApproval.id) return;
  const card = document.createElement("div");
  card.className = "approval-card";
  card.innerHTML =
    '<div class="ac-title">⚠ 需要你拍板</div>' +
    '<div class="ac-prompt">' + esc(msg.pendingApproval.prompt || "") + "</div>" +
    '<div class="ac-note-row"><input type="text" class="ac-note" placeholder="备注（可空）" /></div>' +
    '<div class="ac-actions"><button class="approve-btn">批准</button><button class="reject-btn">驳回</button></div>';
  slot.appendChild(card);
  const decide = (ok) => {
    $("gaNote").value = card.querySelector(".ac-note").value.trim();
    decideApproval(ok, active.id);
  };
  card.querySelector(".approve-btn").onclick = () => decide(true);
  card.querySelector(".reject-btn").onclick = () => decide(false);
}

function appendAgentMsg(msg, handoffFrom) {
  const a = agentOf(msg.author) || {};
  const el = msgShell({
    key: msg.author,
    name: msg.authorName || a.name || msg.author,
    handle: isGroup() ? (a.mention || a.id) : "",
    avatar: msg.avatar || a.avatar,
    color: msg.color || a.color,
    ts: msg.ts, msgId: msg.id, handoff: handoffFrom,
  });
  const slot = el.querySelector(".msg-slot");
  slot.innerHTML = bubbleHTML(msg);
  attachApproval(slot, msg);
  scrollFeed();
  return el;
}

function appendHumanMsg(msg) {
  const currentUser = state.user || {};
  const isMe = msg.author === currentUser.id || msg.author === "human";
  const liveUser = isMe ? currentUser : userOf(msg.author);
  const name = (liveUser && (liveUser.displayName || liveUser.login)) || msg.authorName || "用户";
  const avatar = (liveUser && liveUser.avatarUrl) || msg.authorAvatar || "";
  const el = msgShell({ key: msg.author || "human", name, avatar, color: "#FF5A36", ts: msg.ts, msgId: msg.id, me: isMe });
  el.querySelector(".msg-slot").innerHTML = '<div class="bubble">' + md(msg.content) + "</div>";
  scrollFeed(true);
  return el;
}
function refreshAvatarViews() {
  renderConvSwitch();
  if (state.view === "friends") renderFriendsView();
  const conv = state.currentConv;
  if (!conv) return;
  if (conv.status === "running" || Object.keys(state.streaming).length) { renderChatHeader(); return; }
  renderChat();
}

function appendSystemLine(text) {
  const d = document.createElement("div");
  d.className = "sys-line";
  d.innerHTML = "<span>" + md(text) + "</span>";
  feedEl().appendChild(d);
  feedGroup = { author: null, ts: 0 };
  scrollFeed();
}

/* ==========================================================================
   SSE 事件
   ========================================================================== */
function onEvent(j) {
  const conv = state.currentConv;
  if (!conv) return;
  state.reconnectTries = 0;
  hideReconnectToast();
  switch (j.type) {
    case "profile_updated": {
      const updated = j.user;
      if (!updated || !updated.id) break;
      if (state.user && updated.id === state.user.id) state.user = updated;
      const index = state.friends.findIndex((item) => item.user && item.user.id === updated.id);
      if (index >= 0) state.friends[index] = Object.assign({}, state.friends[index], { user: updated });
      refreshAvatarViews();
      break;
    }
    case "snapshot": setStatus(j.status, j.pendingApproval); break;
    case "status":
      conv.status = j.status;
      if (j.status === "idle") conv.pendingApproval = null;
      setStatus(j.status, conv.pendingApproval);
      if (j.status === "idle") loadConvs();
      break;
    case "message":
      if (conv.messages.find((m) => m.id === j.message.id)) break;
      conv.messages.push(j.message);
      routeMessage(j.message);
      markCurrentConversationRead();
      break;
    case "agent_start": startAgentStream(j); setStatus("running"); break;
    case "agent_token": appendAgentToken(j.agentId, j.token); break;
    case "agent_reasoning": appendAgentReasoning(j.agentId, j.token); break;
    case "agent_end": endAgentStream(j); break;
    case "approval_request":
      conv.pendingApproval = j.approval;
      setStatus("awaiting_approval", true);
      showGlobalApproval(j.approval);
      break;
    case "approval_resolved": {
      const source = conv.messages.find((m) => m.id === j.messageId);
      if (source) source.pendingApproval = null;
      conv.pendingApproval = null;
      document.querySelectorAll('[data-msg-id="' + j.messageId + '"] .approval-card').forEach((c) => c.remove());
      $("approvalBar").classList.add("hidden");
      $("gaNote").value = "";
      break;
    }
    case "message_queued": toast("消息已排队，前方还有 " + j.queueLength + " 条"); break;
    case "error": toast("错误：" + j.message, "err"); break;
  }
}

function startAgentStream(j) {
  const a = agentOf(j.agentId) || {};
  const handoff = isGroup() && state.lastSpeakerName && state.lastSpeakerName !== (j.agentName || a.name) ? state.lastSpeakerName : null;
  const el = msgShell({
    key: j.agentId,
    name: j.agentName || a.name || j.agentId,
    handle: isGroup() ? (a.mention || j.agentId) : "",
    avatar: j.avatar || a.avatar,
    color: j.color || a.color,
    ts: Date.now(), timeText: "正在发言…", handoff, noGroup: true,
  });
  el.classList.add("streaming");
  el.querySelector(".msg-slot").innerHTML =
    '<div class="bubble"><span class="typing"><i></i><i></i><i></i></span><span class="stream-text"></span></div>';
  state.streaming[j.agentId] = {
    text: "", reasoning: "", el,
    bubble: el.querySelector(".bubble"),
    textEl: el.querySelector(".stream-text"),
    reasonEl: null,
  };
  setMemberStatus(j.agentId, "thinking");
  renderTypingStrip();
  scrollFeed();
}

function appendAgentToken(agentId, token) {
  const s = state.streaming[agentId];
  if (!s) return;
  if (s.text === "") {
    const dots = s.bubble.querySelector(".typing");
    if (dots) dots.remove();
    setMemberStatus(agentId, "speaking");
    renderTypingStrip();
  }
  s.text += token;
  s.textEl.innerHTML = md(s.text);
  scrollFeed();
}

function appendAgentReasoning(agentId, token) {
  const s = state.streaming[agentId];
  if (!s) return;
  s.reasoning += token;
  if (!s.reasonEl) {
    const det = document.createElement("details");
    det.className = "reasoning streaming-reasoning";
    det.open = true;
    det.innerHTML = '<summary>思考中…</summary><div class="reasoning-body"></div>';
    s.bubble.parentElement.insertBefore(det, s.bubble);
    s.reasonEl = det.querySelector(".reasoning-body");
  }
  s.reasonEl.textContent = s.reasoning;
  s.reasonEl.scrollTop = s.reasonEl.scrollHeight;
  scrollFeed();
}

function endAgentStream(j) {
  const s = state.streaming[j.agentId];
  delete state.streaming[j.agentId];
  setMemberStatus(j.agentId, "done");
  renderTypingStrip();
  const msg = j.message;
  if (!msg) { if (s && s.el) s.el.remove(); return; }
  const conv = state.currentConv;
  if (conv && !conv.messages.find((m) => m.id === msg.id)) conv.messages.push(msg);
  const handoffFrom = getHandoffSource(msg);
  if (s && s.el && s.el.parentElement) {
    s.el.classList.remove("streaming");
    s.el.dataset.msgId = msg.id;
    const timeEl = s.el.querySelector(".msg-time");
    if (timeEl) timeEl.textContent = fmtTime(msg.ts);
    if (handoffFrom && !s.el.querySelector(".msg-handoff")) {
      const hf = document.createElement("div");
      hf.className = "msg-handoff";
      hf.textContent = "↩ " + handoffFrom + " 转交";
      s.el.querySelector(".msg-main").prepend(hf);
    }
    const slot = s.el.querySelector(".msg-slot");
    slot.innerHTML = bubbleHTML(msg);
    attachApproval(slot, msg);
  } else {
    feedGroup = { author: null, ts: 0 };
    appendAgentMsg(msg, handoffFrom);
  }
  state.lastSpeakerName = msg.authorName;
  scrollFeed();
}

/* ==========================================================================
   审批
   ========================================================================== */
function showGlobalApproval(approval) {
  const bar = $("approvalBar");
  $("gaText").innerHTML = "需要你拍板：<strong>" + esc(approval.prompt || "") + "</strong>";
  $("gaText").title = approval.prompt || "";
  $("gaNote").value = "";
  bar.classList.remove("hidden");
  bar.dataset.approvalId = approval.id;
}

async function decideApproval(approved, approvalId) {
  if (!state.currentConv || !approvalId) return;
  try {
    await api.post("/api/conversations/" + state.currentConv.id + "/approval", {
      approvalId, approved, note: $("gaNote").value.trim(),
    });
  } catch (e) { toast("审批失败：" + e.message, "err"); }
}

/* ==========================================================================
   Agent 编辑
   ========================================================================== */
let editingAgent = null;
let agentInitialSnapshot = "";
let agentSaving = false;
const DEFAULT_AVATARS = AVATAR_PRESETS;
const AGENT_FIELD_IDS = ["aName", "aMention", "aPrompt", "aAvatar", "aCategory", "aSkills"];

function parseSkills(raw) {
  return String(raw || "").split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean)
    .filter((s, i, arr) => arr.indexOf(s) === i);
}

function selectedAgentKbIds() {
  return Array.from($("aKbPicker").querySelectorAll("input[data-kbid]:checked")).map((input) => input.dataset.kbid);
}

function agentDraft() {
  const name = $("aName").value.trim();
  return {
    id: editingAgent ? editingAgent.id : undefined,
    name,
    mention: $("aMention").value.trim().replace(/^@+/, "") || name,
    category: $("aCategory").value.trim() || (editingAgent ? (editingAgent.category || "通用") : "通用"),
    role: editingAgent ? (editingAgent.role || name) : name,
    description: editingAgent ? (editingAgent.description || "") : "",
    avatar: $("aAvatar").value.trim() || DEFAULT_AVATAR,
    color: editingAgent ? (editingAgent.color || "#FF5A36") : "#FF5A36",
    systemPrompt: $("aPrompt").value.trim(),
    skills: parseSkills($("aSkills").value),
    tools: editingAgent ? (editingAgent.tools || []) : [],
    kbIds: selectedAgentKbIds().sort(),
    mcp: editingAgent ? (editingAgent.mcp || []) : [],
    permissions: editingAgent ? (editingAgent.permissions || {}) : {},
  };
}

function currentAgentSnapshot() {
  return JSON.stringify(agentDraft());
}

function agentHasChanges() {
  return currentAgentSnapshot() !== agentInitialSnapshot;
}

function updateAgentKbCount() {
  const count = selectedAgentKbIds().length;
  $("aKbCount").textContent = count ? count + " 个已选择" : "继承会话";
}

function renderAvatarOptions() {
  const raw = $("aAvatar").value.trim() || DEFAULT_AVATAR;
  // 文字/Emoji 头像统一映射到预设图片，保证列表数量稳定、选中态一致
  const selected = isAvatarImage(raw) ? raw : presetFor(raw);
  const values = DEFAULT_AVATARS.includes(selected) ? DEFAULT_AVATARS : [selected].concat(DEFAULT_AVATARS);
  $("aAvatarOptions").innerHTML = values.map((avatar) =>
    '<button type="button" class="avatar-option' + (avatar === selected ? " selected" : "") + '" data-avatar="' + esc(avatar) + '" aria-label="选择头像 ' + esc(avatar) + '" aria-pressed="' + String(avatar === selected) + '">' + avatarMarkup(avatar) + '</button>'
  ).join("");
  $("aAvatarOptions").querySelectorAll("[data-avatar]").forEach((button) => {
    button.onclick = () => {
      $("aAvatar").value = button.dataset.avatar;
      $("aAvatarUploadStatus").textContent = "已选择";
      renderAvatarOptions();
      refreshAgentConfigState();
    };
  });
}

function updateAgentConfigSummary() {
  const name = $("aName").value.trim();
  $("aPromptCount").textContent = $("aPrompt").value.trim().length.toLocaleString("zh-CN") + " 字";
  $("agentConfigTitle").textContent = editingAgent ? "配置 " + (name || editingAgent.name) : "新建智能体";
}

function refreshAgentConfigState() {
  updateAgentKbCount();
  updateAgentConfigSummary();
  const dirty = agentHasChanges();
  const stateEl = $("aDirtyState");
  stateEl.classList.toggle("dirty", dirty && !agentSaving);
  stateEl.classList.toggle("saving", agentSaving);
  const cleanLabel = !editingAgent ? "填写配置后创建" : "所有更改已保存";
  stateEl.textContent = agentSaving ? "正在保存…" : (dirty ? "有未保存的更改" : cleanLabel);
  const hasName = Boolean($("aName").value.trim());
  $("aCancel").textContent = dirty ? "放弃更改" : "返回列表";
  $("aSave").disabled = agentSaving || !hasName;
}

function renderAgentKbPicker(selectedIds) {
  const selected = new Set(selectedIds || []);
  const picker = $("aKbPicker");
  if (!state.kbs.length) {
    picker.innerHTML = '<div class="agent-kb-empty">暂无知识库。请先前往知识库页面创建并上传资料。</div>';
    updateAgentKbCount();
    return;
  }
  picker.innerHTML = state.kbs.map((kb) => '<label class="agent-kb-option"><input type="checkbox" data-kbid="' + kb.id + '" ' +
    (selected.has(kb.id) ? "checked" : "") + ' /><span><b>' + esc(kb.name) + '</b><i>' + kb.docCount + " 篇文档 · " + kb.chunkCount +
    " 个片段</i></span></label>").join("");
  picker.querySelectorAll("input[data-kbid]").forEach((input) => { input.onchange = refreshAgentConfigState; });
  updateAgentKbCount();
}

function showAgentConfig() {
  $("agentCatalog").classList.add("hidden");
  $("agentConfigView").classList.remove("hidden");
  $("agentConfigView").querySelector(".agent-config-scroll").scrollTop = 0;
}

function prepareAgentConfig(agent) {
  $("aConfigKicker").textContent = agent ? "智能体配置" : "创建配置";
  $("aSave").textContent = agent ? "保存" : "创建智能体";
  $("aCancel").textContent = "放弃更改";
  $("aDelete").classList.toggle("hidden", !agent || agent.builtin);
  $("aName").classList.remove("invalid");
  showAgentConfig();
}

function openAgentDetail(id) {
  const agent = agentOf(id);
  if (!agent) return;
  editingAgent = agent;
  $("aName").value = agent.name;
  $("aMention").value = agent.mention || "";
  $("aAvatar").value = agent.avatar || DEFAULT_AVATAR;
  $("aAvatarUploadStatus").textContent = /^\/uploads\/avatars\//.test(agent.avatar || "") ? "已上传" : "未上传";
  $("aCategory").value = agent.category || "";
  $("aSkills").value = (agent.skills || []).join(", ");
  $("aPrompt").value = agent.systemPrompt || "";
  renderAvatarOptions();
  renderAgentKbPicker(agent.kbIds || []);
  prepareAgentConfig(agent);
  agentInitialSnapshot = currentAgentSnapshot();
  refreshAgentConfigState();
}

function openNewAgent() {
  editingAgent = null;
  ["aName", "aMention", "aPrompt", "aCategory", "aSkills"].forEach((id) => { $(id).value = ""; });
  $("aAvatar").value = DEFAULT_AVATAR;
  $("aAvatarUpload").value = "";
  $("aAvatarUploadStatus").textContent = "未上传";
  renderAvatarOptions();
  renderAgentKbPicker([]);
  prepareAgentConfig(null);
  agentInitialSnapshot = currentAgentSnapshot();
  refreshAgentConfigState();
  setTimeout(() => $("aName").focus(), 60);
}

function closeAgentConfig(force = false) {
  if (!force && agentHasChanges() && !confirm("当前配置尚未保存，确定放弃这些更改吗？")) return false;
  $("agentConfigView").classList.add("hidden");
  $("agentCatalog").classList.remove("hidden");
  editingAgent = null;
  agentInitialSnapshot = "";
  setTimeout(() => $("agentSearch").focus(), 40);
  return true;
}

async function saveAgent() {
  const body = agentDraft();
  if (!body.name) {
    $("aName").classList.add("invalid");
    $("aName").focus();
    toast("请先填写智能体名称", "err");
    return;
  }
  $("aName").classList.remove("invalid");
  agentSaving = true;
  refreshAgentConfigState();
  try {
    const body = agentDraft();
    await api.post("/api/agents", body);
    const response = await api.get("/api/agents");
    state.agents = response.agents;
    if (!state.agents.some((agent) => (agent.category || "通用") === state.agentCat)) state.agentCat = "全部";
    renderAgentCats(); renderAgentGrid(); renderChatHeader(); renderQuickMentions(); renderConvSwitch();
    closeAgentConfig(true);
    toast(body.id && editingAgent && editingAgent.builtin ? "已更新我的智能体" : "智能体配置已保存", "ok");
  } catch (error) {
    toast("保存失败：" + error.message, "err");
  } finally {
    agentSaving = false;
    if (!$("agentConfigView").classList.contains("hidden")) refreshAgentConfigState();
  }
}

async function deleteAgent() {
  if (!editingAgent || editingAgent.builtin) return;
  if (!confirm("删除智能体「" + editingAgent.name + "」？此操作无法撤销。")) return;
  try {
    await api.del("/api/agents/" + editingAgent.id);
    const response = await api.get("/api/agents");
    state.agents = response.agents;
    if (!state.agents.some((agent) => (agent.category || "通用") === state.agentCat)) state.agentCat = "全部";
    renderAgentCats(); renderAgentGrid(); renderConvSwitch();
    closeAgentConfig(true);
    toast("智能体已删除", "ok");
  } catch (error) {
    toast("删除失败：" + error.message, "err");
  }
}

/* ==========================================================================
   输入 / @ 补全
   ========================================================================== */
async function sendMessage() {
  const inp = $("input");
  const text = inp.value.trim();
  if (!text) return;
  if (!state.currentConv) { toast("请先选择一个聊天"); return; }
  inp.value = "";
  autosize();
  updateSendBtn();
  state.stick = true;
  try {
    const r = await api.post("/api/conversations/" + state.currentConv.id + "/messages", { text });
    // 与 SSE 广播去重：无论响应和广播谁先到，同一条消息只渲染一次
    if (r.message && !state.currentConv.messages.find((m) => m.id === r.message.id)) {
      state.currentConv.messages.push(r.message);
      routeMessage(r.message);
    }
  } catch (e) {
    toast("发送失败：" + e.message, "err");
    inp.value = text;
    autosize(); updateSendBtn();
  }
}

function insertMention(a) {
  if (!a) return;
  const inp = $("input");
  const need = /\s$|^$/.test(inp.value) ? "" : " ";
  inp.value += need + "@" + a.mention + " ";
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
  autosize();
  updateSendBtn();
}

function updateSendBtn() {
  const btn = $("sendBtn");
  btn.disabled = !$("input").value.trim() || !state.currentConv;
}

function autosize() {
  const inp = $("input");
  inp.style.height = "auto";
  inp.style.height = Math.min(168, inp.scrollHeight) + "px";
}

let mentionState = { active: false, sel: 0, items: [], start: 0 };

function updateMentionHint() {
  const inp = $("input");
  const hint = $("mentionHint");
  if (!isGroup()) { mentionState.active = false; hint.classList.add("hidden"); return; }
  const left = inp.value.slice(0, inp.selectionStart);
  const m = left.match(/[@＠]([a-zA-Z0-9_\u4e00-\u9fa5-]*)$/);
  if (!m) { mentionState.active = false; hint.classList.add("hidden"); return; }
  const q = m[1].toLowerCase();
  const items = convMembers().filter((a) => a.mention.toLowerCase().startsWith(q) || a.name.toLowerCase().includes(q));
  if (!items.length) { mentionState.active = false; hint.classList.add("hidden"); return; }
  mentionState = { active: true, sel: 0, items, start: inp.selectionStart - m[0].length };
  hint.classList.remove("hidden");
  hint.innerHTML = items.map((a, i) =>
    '<div class="mh-item' + (i === 0 ? " sel" : "") + '" data-idx="' + i + '" tabindex="0" role="option" aria-label="@' + esc(a.mention) + " " + esc(a.name) + '">' +
      '<span class="mh-av" style="background:' + (a.color || "#999") + "1f;color:" + (a.color || "#999") + '">' + avatarMarkup(a.avatar) + "</span>" +
      '<span><span class="mh-name">' + esc(a.name) + '</span> <span class="mh-role">' + esc(a.role || "") + "</span></span>" +
      '<span class="mh-handle">@' + esc(a.mention) + "</span>" +
    "</div>"
  ).join("");
  hint.querySelectorAll(".mh-item").forEach((it) => {
    it.onclick = () => pickMention(Number(it.dataset.idx));
    it.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); pickMention(Number(it.dataset.idx)); } };
  });
}

function pickMention(i) {
  const a = mentionState.items[i];
  if (!a) return;
  const inp = $("input");
  const before = inp.value.slice(0, mentionState.start);
  const after = inp.value.slice(inp.selectionStart);
  inp.value = before + "@" + a.mention + " " + after;
  const pos = (before + "@" + a.mention + " ").length;
  inp.focus();
  inp.setSelectionRange(pos, pos);
  $("mentionHint").classList.add("hidden");
  mentionState.active = false;
  autosize();
  updateSendBtn();
}

function mentionNav(e) {
  if (!mentionState.active) return false;
  const n = mentionState.items.length;
  if (e.key === "ArrowDown") { mentionState.sel = (mentionState.sel + 1) % n; renderSel(); e.preventDefault(); return true; }
  if (e.key === "ArrowUp") { mentionState.sel = (mentionState.sel - 1 + n) % n; renderSel(); e.preventDefault(); return true; }
  if (e.key === "Enter" || e.key === "Tab") { pickMention(mentionState.sel); e.preventDefault(); return true; }
  if (e.key === "Escape") { $("mentionHint").classList.add("hidden"); mentionState.active = false; return true; }
  return false;
}

function renderSel() {
  document.querySelectorAll(".mention-hint .mh-item").forEach((it, i) => it.classList.toggle("sel", i === mentionState.sel));
}

/* ==========================================================================
   事件绑定
   ========================================================================== */
function bindEvents() {
  document.querySelectorAll(".rail-item").forEach((r) => { r.onclick = () => switchView(r.dataset.view); });
  $("friendsNavBtn").onclick = () => {
    if (!state.user) { toast("请先登录", "err"); return; }
    switchView("friends");
  };

  // 发起聊天菜单
  const menu = $("newChatMenu");
  $("newChatBtn").onclick = (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); };
  menu.querySelectorAll("[data-act]").forEach((b) => {
    b.onclick = () => {
      menu.classList.add("hidden");
      if (b.dataset.act === "direct") openDirectPicker(); else openGroupModal();
    };
  });

  // 会话搜索 / 过滤
  $("convSearch").addEventListener("input", (e) => { state.convQuery = e.target.value; renderConvSwitch(); });
  $("convSearch").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.target.value = ""; state.convQuery = ""; renderConvSwitch(); e.target.blur(); }
  });
  $("convFilter").querySelectorAll(".sf-chip").forEach((b) => {
    b.onclick = () => {
      state.convKind = b.dataset.kind;
      $("convFilter").querySelectorAll(".sf-chip").forEach((x) => x.classList.toggle("active", x === b));
      renderConvSwitch();
    };
  });

  // 智能体视图
  $("agentSearch").addEventListener("input", (e) => { state.agentQuery = e.target.value; renderAgentGrid(); });
  $("newAgentBtn").onclick = openNewAgent;
  $("aSave").onclick = saveAgent;
  $("aBack").onclick = () => closeAgentConfig();
  $("aCancel").onclick = () => closeAgentConfig();
  $("aDelete").onclick = deleteAgent;
  AGENT_FIELD_IDS.forEach((id) => {
    $(id).addEventListener("input", () => {
      if (id === "aName") $("aName").classList.remove("invalid");
      refreshAgentConfigState();
    });
  });
  $("aAvatarUpload").addEventListener("change", async (event) => {
    const input = event.target;
    const file = input.files && input.files[0];
    if (!file) return;
    $("aAvatarUploadStatus").textContent = "调整头像…";
    try {
      const cropped = await openAvatarCropper(file);
      if (!cropped) {
        $("aAvatarUploadStatus").textContent = /^\/uploads\/avatars\//.test($("aAvatar").value) ? "已上传" : "未上传";
        return;
      }
      $("aAvatarUploadStatus").textContent = "正在上传…";
      const form = new FormData();
      form.append("avatar", cropped);
      const response = await fetch("/api/agents/avatar", { method: "POST", body: form });
      const data = await parseResponse(response);
      $("aAvatar").value = data.url;
      $("aAvatarUploadStatus").textContent = "已上传";
      renderAvatarOptions();
      refreshAgentConfigState();
    } catch (error) {
      $("aAvatarUploadStatus").textContent = "上传失败，请重试";
      toast("头像上传失败：" + error.message, "err");
    } finally {
      input.value = "";
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (!$("agentConfigView").classList.contains("hidden") && agentHasChanges()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  // 知识库视图
  $("kbSearch").addEventListener("input", (e) => { state.kbQuery = e.target.value; renderKbGrid(); });
  $("newKbBtn").onclick = () => {
    $("kbName").value = ""; $("kbDesc").value = "";
    openModal($("kbModal"));
    setTimeout(() => $("kbName").focus(), 60);
  };
  $("kbCancel").onclick = () => closeModal($("kbModal"));
  $("kbCreate").onclick = async () => {
    const name = $("kbName").value.trim();
    if (!name) { $("kbName").focus(); toast("请填写名称"); return; }
    try {
      await api.post("/api/kbs", { name, description: $("kbDesc").value.trim() });
      closeModal($("kbModal"));
      await loadKbs();
      toast("知识库已创建", "ok");
    } catch (e) { toast("创建失败：" + e.message, "err"); }
  };
  $("kbName").onkeydown = (e) => { if (e.key === "Enter") $("kbCreate").click(); };
  $("dwClose").onclick = closeKbDrawer;
  $("kbDrawerMask").addEventListener("click", (e) => { if (e.target === $("kbDrawerMask")) closeKbDrawer(); });

  // 单聊 / 群聊模态
  $("directCancel").onclick = () => $("directModal").classList.add("hidden");
  $("friendAddBtn").onclick = async () => {
    const input = $("friendUserId");
    const userId = input.value.trim();
    if (!userId) { input.focus(); return; }
    try {
      const res = await api.post("/api/friends/request", { userId });
      input.value = ""; await loadFriends(); renderFriendsView();
      if (res.friendship && res.friendship.status === "accepted") { await loadConvs(); toast("已添加好友", "ok"); }
      else toast("好友请求已发送", "ok");
    } catch (error) { toast("添加失败：" + error.message, "err"); }
  };
  $("friendUserId").onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); $("friendAddBtn").click(); } };
  $("groupNext").onclick = groupNext;
  $("groupPrev").onclick = () => { if (state.wizard.step > 0) { state.wizard.step--; renderGroupStep(); } };
  $("groupCancel").onclick = () => closeModal($("groupModal"));

  // 审批
  $("gaApprove").onclick = () => decideApproval(true, $("approvalBar").dataset.approvalId);
  $("gaReject").onclick = () => decideApproval(false, $("approvalBar").dataset.approvalId);
  $("gaNote").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); $("gaApprove").click(); } };

  // 输入框
  const inp = $("input");
  inp.addEventListener("input", () => { autosize(); updateMentionHint(); updateSendBtn(); });
  inp.addEventListener("keydown", (e) => {
    if (mentionNav(e)) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $("sendBtn").onclick = sendMessage;
  $("kbMountBtn").onclick = toggleKbPop;

  // 联系作者
  $("contactAuthor").onclick = openContactModal;
  $("contactClose").onclick = closeContactModal;
  $("contactModal").addEventListener("click", (e) => { if (e.target === $("contactModal")) closeContactModal(); });

  // 滚动
  const box = $("chatFeed");
  let raf = null;
  box.addEventListener("scroll", () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      state.stick = atBottom();
      $("jumpLatest").classList.toggle("show", !state.stick);
    });
  });
  $("jumpLatest").onclick = () => { state.stick = true; scrollFeed(true); };

  // 全局点击收起浮层
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".composer-card")) $("mentionHint").classList.add("hidden");
    if (!e.target.closest(".sb-add-wrap")) menu.classList.add("hidden");
    if (!e.target.closest(".kb-mount-wrap")) $("kbPop").classList.add("hidden");
    if (state.convDeleting && !e.target.closest("[data-del]")) { state.convDeleting = null; renderConvSwitch(); }
    if (state.kbDeleting && !e.target.closest("[data-del]")) { state.kbDeleting = null; renderKbGrid(); }
  });

  // 点遮罩关模态
  document.querySelectorAll(".modal").forEach((m) => {
    m.addEventListener("click", (e) => { if (e.target === m) closeModal(m); });
  });

  // 快捷键
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const open = document.querySelector(".modal:not(.hidden)");
      if (open) { closeModal(open); return; }
      if (!$("kbDrawerMask").classList.contains("hidden")) { closeKbDrawer(); return; }
      if (!$("agentConfigView").classList.contains("hidden")) { closeAgentConfig(); return; }
      if (!$("kbPop").classList.contains("hidden")) { $("kbPop").classList.add("hidden"); return; }
      if (!$("contactModal").classList.contains("hidden")) { closeContactModal(); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      if (state.view === "agents" && !$("agentConfigView").classList.contains("hidden")) return;
      e.preventDefault();
      const box = state.view === "agents" ? $("agentSearch") : state.view === "kb" ? $("kbSearch") : $("convSearch");
      box.focus(); box.select();
    }
  });

  $("rtClose").onclick = hideReconnectToast;
}

window.addEventListener("DOMContentLoaded", init);
