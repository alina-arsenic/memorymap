const API_BASE = ""; // тот же origin (http://localhost:8000)
const LS_TOKEN = "mm_token";

let accessToken = null;
let currentUser = null;  // объект из /v1/me
let currentMarkers = []; // ссылки на Marker, чтобы их удалять
let markersByPlaceId = {}; // {place_id: Marker} — для открытия попапа из панели модерации
let pendingPopupPlaceId = null; // placeId для открытия попапа после refresh
let pendingPopupGroupId = null; // groupId для включения в feed-запрос
let pendingCommentId = null; // commentId для автооткрытия комментариев из уведомления

let tempMarker = null; // временный желтый маркер
let tempCoords = null; // { lng, lat } последнего ПКМ

// Friends UI state
let outgoingPendingIds = new Set();

// Layers UI state
let selectedGroupLayerIds = new Set(); // group_id for personal/shared layers (not public=1)
let personalGroupId = null;

async function apiFetch(path, { method = "GET", headers = {}, body = null } = {}) {
  const h = { ...headers };
  if (accessToken) h["Authorization"] = "Bearer " + accessToken;

  const resp = await fetch(`${API_BASE}${path}`, { method, headers: h, body });

  // если токен протух/невалидный - сразу разлогиниваемся
  if (resp.status === 401) {
    accessToken = null;
    currentUser = null;
    localStorage.removeItem(LS_TOKEN);

    // UI гость
    const userTitle = document.getElementById("user-title");
    if (userTitle) userTitle.innerText = "Пользователь";
    applyAuthUI(false);

    // на всякий: убираем временный маркер
    if (tempMarker) { tempMarker.remove(); tempMarker = null; }
    tempCoords = null;
  }

  return resp;
}

function createPin(isMine, overrideColor) {
const color = overrideColor || (isMine ? "#10b981" : "#3b82f6"); // зеленый свои, синий чужие

const svg = `
    <svg width="20" height="35" viewBox="0 0 26 40" xmlns="http://www.w3.org/2000/svg">
    <path d="M13 0C6 0 0.5 5.5 0.5 12.5C0.5 23 13 40 13 40C13 40 25.5 23 25.5 12.5C25.5 5.5 20 0 13 0Z"
            fill="${color}" stroke="white" stroke-width="2" />
    <circle cx="13" cy="12" r="5" fill="white" />
    </svg>
`;

const wrapper = document.createElement("div");
wrapper.innerHTML = svg.trim();
return wrapper.firstChild; // сам <svg>
}

/** Скрыть все гостевые формы */
function _hideAllGuestForms() {
  const ids = ["login-form", "register-form", "verify-form", "forgot-email-form", "forgot-reset-form"];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  }
}

/** Переключиться на форму входа */
function showLoginForm() {
  _hideAllGuestForms();
  const login = document.getElementById("login-form");
  if (login) login.style.display = "";
}

/** Переключиться на форму регистрации */
function showRegisterForm() {
  _hideAllGuestForms();
  const reg = document.getElementById("register-form");
  if (reg) reg.style.display = "";
}

/** Переключиться на форму «Забыли пароль?» */
function showForgotPasswordForm() {
  _hideAllGuestForms();
  const form = document.getElementById("forgot-email-form");
  if (form) form.style.display = "";
  const status = document.getElementById("forgot-email-status");
  if (status) status.innerText = "";
}

function applyAuthUI(isAuthed) {
  const logoutBtn = document.getElementById("logout-btn");
  const authedOnly = document.getElementById("authed-only");

  if (isAuthed) {
    _hideAllGuestForms();
  } else {
    showLoginForm();
  }
  const accountActions = document.getElementById("account-actions");
  if (logoutBtn) logoutBtn.style.display = isAuthed ? "" : "none";
  if (accountActions) accountActions.style.display = isAuthed ? "" : "none";
  if (authedOnly) authedOnly.style.display = isAuthed ? "" : "none";

  const notifBtn = document.getElementById("notif-btn");
  const notifBadge = document.getElementById("notif-badge");
  if (notifBtn) notifBtn.style.display = isAuthed ? "" : "none";
  if (!isAuthed) {
    if (notifBadge) { notifBadge.innerText = "0"; notifBadge.style.display = "none"; }
    closeFriendRequestsModal(true);

    // закрываем модал настроек при logout
    const settingsOverlay = document.getElementById("account-settings-overlay");
    if (settingsOverlay) settingsOverlay.style.display = "none";
  }

  const tgStatus = document.getElementById("tg-status");
  if (!isAuthed) {
    if (tgStatus) tgStatus.innerText = "";
  }
}

let _mmModalResolve = null;

function mmOpenModal({ title, mode, initial }) {
  const modal = document.getElementById("mm-edit-modal");
  const t = document.getElementById("mm-modal-title");
  const inp = document.getElementById("mm-modal-input");
  const ta = document.getElementById("mm-modal-textarea");

  t.innerText = title;

  if (mode === "title") {
    inp.style.display = "";
    ta.style.display = "none";
    inp.value = initial || "";
    setTimeout(() => inp.focus(), 0);
  } else {
    inp.style.display = "none";
    ta.style.display = "";
    ta.value = initial || "";
    setTimeout(() => ta.focus(), 0);
  }

  modal.style.display = "";

  return new Promise((resolve) => {
    _mmModalResolve = resolve;
  });
}

function mmModalCancel() {
  const modal = document.getElementById("mm-edit-modal");
  modal.style.display = "none";
  if (_mmModalResolve) _mmModalResolve(null);
  _mmModalResolve = null;
}

function mmModalSave() {
  const modal = document.getElementById("mm-edit-modal");
  const inp = document.getElementById("mm-modal-input");
  const ta = document.getElementById("mm-modal-textarea");

  const val = inp.style.display !== "none" ? inp.value : ta.value;

  modal.style.display = "none";
  if (_mmModalResolve) _mmModalResolve(val);
  _mmModalResolve = null;
}

async function initAuthFromStorage() {
  applyAuthUI(false);

  const saved = localStorage.getItem(LS_TOKEN);
  if (!saved) return;

  accessToken = saved;
  await loadMe();
}

async function loadMe() {
  const userTitle = document.getElementById("user-title");
  const tgBtn = document.getElementById("tg-link-btn");
  const tgHint = document.getElementById("tg-hint");
  const tgStatus = document.getElementById("tg-status");
  const tgCode = document.getElementById("tg-link-code");

  // если токена нет - сразу UI в гостя
  if (!accessToken) {
    currentUser = null;
    if (userTitle) userTitle.innerText = "Пользователь";
    applyAuthUI(false);

    if (tgStatus) tgStatus.innerText = "";
    if (tgHint) tgHint.style.display = "none";
    if (tgBtn) tgBtn.style.display = "none";
    if (tgCode) { tgCode.innerText = ""; tgCode.style.display = "none"; }
    return;
  }

  const resp = await apiFetch("/v1/me");

  // токен протух / невалиден
  if (!resp.ok) {
    accessToken = null;
    currentUser = null;
    localStorage.removeItem(LS_TOKEN);

    if (userTitle) userTitle.innerText = "Пользователь";
    applyAuthUI(false);

    if (tgStatus) tgStatus.innerText = "";
    if (tgHint) tgHint.style.display = "none";
    if (tgBtn) tgBtn.style.display = "none";
    if (tgCode) { tgCode.innerText = ""; tgCode.style.display = "none"; }
    return;
  }

  // успех
  currentUser = await resp.json();
  const nick = currentUser.login || ("user#" + currentUser.id);

  // показываем роль для admin и moderator
  const roleBadge = currentUser.role === "admin" ? " (Админ)"
    : currentUser.role === "moderator" ? " (Модератор)" : "";
  if (userTitle) userTitle.innerText = `Привет, ${nick}!${roleBadge}`;
  applyAuthUI(true);

  // Telegram UI
  if (currentUser.tg_id) {
    if (tgStatus) tgStatus.innerText = `Привязан Telegram ID: ${currentUser.tg_id}`;
    if (tgBtn) tgBtn.style.display = "none";
    if (tgHint) tgHint.style.display = "none";
    if (tgCode) { tgCode.innerText = ""; tgCode.style.display = "none"; }
  } else {
    if (tgStatus) tgStatus.innerText = "Telegram не привязан.";
    if (tgBtn) tgBtn.style.display = "";
    if (tgHint) tgHint.style.display = "";
  }

  // Панель модерации — показываем только admin и moderator
  const modPanel = document.getElementById("moderation-panel");
  if (modPanel) {
    const isModerator = currentUser.role === "admin" || currentUser.role === "moderator";
    modPanel.style.display = isModerator ? "" : "none";
    if (isModerator) loadModerationQueue();
  }

  // Панель администратора — показываем только admin
  const adminPanel = document.getElementById("admin-panel");
  if (adminPanel) {
    const isAdmin = currentUser.role === "admin";
    adminPanel.style.display = isAdmin ? "" : "none";
    if (isAdmin) loadAdminUsers();
  }

  // Друзья/уведомления
  refreshFriendsUI();
  updateNotifBadge();

  // Слои
  renderGroupLayersUI();
  populateAddGroupSelect();

  // pre-load pending outgoing requests so the search button can show "Ждём ответ"
  await loadFriendRequestsListsSafe();
}

async function uiLogin() {
  const btn = document.querySelector("#login-form .btn-primary");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const login = (document.getElementById("login-input").value || "").trim();
    const password = document.getElementById("login-password-input").value || "";
    if (!login || !password) { alert("Введите логин и пароль."); return; }

    const resp = await fetch(`${API_BASE}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, password }),
    });
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      if (resp.status === 403 && errData.detail === "email_not_verified") {
        _pendingVerifyEmail = errData.email || null;
        if (_pendingVerifyEmail) {
          document.getElementById("login-form").style.display = "none";
          document.getElementById("verify-form").style.display = "";
          document.getElementById("verify-email-display").innerText = _pendingVerifyEmail;
          document.getElementById("verify-status").innerText =
            errData.email_sent === false
              ? "Не удалось отправить код. Нажмите «Отправить повторно»."
              : "Код подтверждения отправлен на вашу почту.";
        } else {
          alert("Email не подтверждён. Попробуйте войти ещё раз.");
        }
      } else if (resp.status === 400 && errData.detail === "password_too_long") {
        alert("Пароль слишком длинный (макс. 128 символов).");
      } else {
        alert("Неверный логин или пароль.");
      }
      return;
    }
    const data = await resp.json();
    accessToken = data.access_token;
    localStorage.setItem(LS_TOKEN, accessToken);
    await loadMe();
    refresh();
  } catch (e) {
    alert("Ошибка сети. Попробуйте ещё раз.");
  } finally {
    btn.disabled = false;
  }
}

// email, на который отправлен код (запоминаем для verify/resend)
let _pendingVerifyEmail = null;
// email для формы сброса пароля
let _pendingResetEmail = null;
// email для формы смены email
let _pendingNewEmail = null;

async function uiRegister() {
  const btn = document.querySelector("#register-form .btn-primary");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const login = (document.getElementById("reg-login-input").value || "").trim();
    const email = (document.getElementById("reg-email-input").value || "").trim();
    const password = document.getElementById("reg-password-input").value || "";
    if (!login || !password || !email) { alert("Заполните логин, email и пароль."); return; }
    if (login.length < 3 || login.length > 64) { alert("Логин должен быть от 3 до 64 символов."); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(login)) { alert("Логин может содержать только латиницу, цифры, _ и -"); return; }
    if (password.length < 8) { alert("Пароль должен быть не короче 8 символов."); return; }
    if (password.length > 128) { alert("Пароль не должен превышать 128 символов."); return; }

    const resp = await fetch(`${API_BASE}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, password, email }),
    });
    if (resp.status === 409) {
      const data = await resp.json().catch(() => ({}));
      if (data.detail === "email_taken") alert("Этот email уже зарегистрирован.");
      else alert("Логин занят.");
      return;
    }
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      if (data.detail === "invalid_email") alert("Некорректный формат email.");
      else if (data.detail === "login_invalid_length") alert("Логин должен быть от 3 до 64 символов.");
      else if (data.detail === "login_invalid_chars") alert("Логин может содержать только латиницу, цифры, _ и -");
      else if (data.detail === "password_too_short") alert("Пароль должен быть не короче 8 символов.");
      else if (data.detail === "password_too_long") alert("Пароль не должен превышать 128 символов.");
      else alert("Ошибка регистрации.");
      return;
    }
    const regData = await resp.json();
    _pendingVerifyEmail = email;
    document.getElementById("register-form").style.display = "none";
    document.getElementById("verify-form").style.display = "";
    document.getElementById("verify-email-display").innerText = email;
    document.getElementById("verify-status").innerText =
      regData.email_sent === false
        ? "Не удалось отправить письмо. Нажмите «Отправить повторно»."
        : "";
  } catch (e) {
    alert("Ошибка сети. Попробуйте ещё раз.");
  } finally {
    btn.disabled = false;
  }
}

async function uiVerifyEmail() {
  const btn = document.querySelector("#verify-form .btn-primary");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const code = (document.getElementById("verify-code-input").value || "").trim();
    const statusEl = document.getElementById("verify-status");
    if (!code || !_pendingVerifyEmail) { statusEl.innerText = "Введите код из письма."; return; }

    const resp = await fetch(`${API_BASE}/v1/auth/verify-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: _pendingVerifyEmail, code }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (data.detail === "wrong_code") statusEl.innerText = "Неверный код.";
      else if (data.detail === "code_expired") statusEl.innerText = "Код истёк. Нажмите «Отправить повторно».";
      else statusEl.innerText = "Ошибка подтверждения.";
      return;
    }
    _pendingVerifyEmail = null;
    document.getElementById("verify-form").style.display = "none";
    document.getElementById("login-form").style.display = "";
    document.getElementById("verify-code-input").value = "";
    alert("Email подтверждён! Теперь войдите в аккаунт.");
  } catch (e) {
    document.getElementById("verify-status").innerText = "Ошибка сети. Попробуйте ещё раз.";
  } finally {
    btn.disabled = false;
  }
}

async function uiResendCode() {
  const btn = document.querySelector("#verify-form .btn:not(.btn-primary)");
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;
  try {
    const statusEl = document.getElementById("verify-status");
    if (!_pendingVerifyEmail) { statusEl.innerText = "Нет email."; return; }
    const resp = await fetch(`${API_BASE}/v1/auth/resend-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: _pendingVerifyEmail }),
    });
    if (resp.ok) {
      statusEl.innerText = "Новый код отправлен.";
    } else {
      const data = await resp.json().catch(() => ({}));
      if (data.detail === "email_send_failed") statusEl.innerText = "Не удалось отправить письмо. Попробуйте позже.";
      else statusEl.innerText = "Не удалось отправить код.";
    }
  } catch (e) {
    document.getElementById("verify-status").innerText = "Ошибка сети. Попробуйте ещё раз.";
  } finally {
    if (btn) btn.disabled = false;
  }
}

// --- F2: Забыл пароль ---

async function uiForgotPassword() {
  const btn = document.querySelector("#forgot-email-form .btn-primary");
  if (btn.disabled) return;
  btn.disabled = true;
  const statusEl = document.getElementById("forgot-email-status");
  try {
    const email = (document.getElementById("forgot-email-input").value || "").trim();
    if (!email) { statusEl.innerText = "Введите email."; return; }

    const resp = await fetch(`${API_BASE}/v1/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      if (data.detail === "invalid_email") statusEl.innerText = "Некорректный формат email.";
      else statusEl.innerText = "Ошибка. Попробуйте ещё раз.";
      return;
    }
    // переключаемся на форму ввода кода
    _pendingResetEmail = email;
    _hideAllGuestForms();
    const resetForm = document.getElementById("forgot-reset-form");
    if (resetForm) resetForm.style.display = "";
    document.getElementById("forgot-reset-email-display").innerText = email;
    document.getElementById("forgot-reset-status").innerText = "";
  } catch (e) {
    statusEl.innerText = "Ошибка сети. Попробуйте ещё раз.";
  } finally {
    btn.disabled = false;
  }
}

async function uiResetPassword() {
  const btn = document.querySelector("#forgot-reset-form .btn-primary");
  if (btn.disabled) return;
  btn.disabled = true;
  const statusEl = document.getElementById("forgot-reset-status");
  try {
    const code = (document.getElementById("forgot-reset-code-input").value || "").trim();
    const newPassword = document.getElementById("forgot-reset-password-input").value || "";
    if (!code) { statusEl.innerText = "Введите код из письма."; return; }
    if (!newPassword) { statusEl.innerText = "Введите новый пароль."; return; }
    if (newPassword.length < 8) { statusEl.innerText = "Пароль должен быть не короче 8 символов."; return; }
    if (newPassword.length > 128) { statusEl.innerText = "Пароль не должен превышать 128 символов."; return; }

    const resp = await fetch(`${API_BASE}/v1/auth/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: _pendingResetEmail, code, new_password: newPassword }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      if (data.detail === "wrong_code") statusEl.innerText = "Неверный код.";
      else if (data.detail === "code_expired") statusEl.innerText = "Код истёк. Запросите новый.";
      else if (data.detail === "no_active_code") statusEl.innerText = "Нет активного кода. Запросите новый.";
      else if (data.detail === "password_too_short") statusEl.innerText = "Пароль должен быть не короче 8 символов.";
      else if (data.detail === "password_too_long") statusEl.innerText = "Пароль не должен превышать 128 символов.";
      else statusEl.innerText = "Ошибка. Попробуйте ещё раз.";
      return;
    }
    // успех — переключаемся на логин
    _pendingResetEmail = null;
    document.getElementById("forgot-reset-code-input").value = "";
    document.getElementById("forgot-reset-password-input").value = "";
    showLoginForm();
    alert("Пароль успешно сброшен! Войдите с новым паролем.");
  } catch (e) {
    statusEl.innerText = "Ошибка сети. Попробуйте ещё раз.";
  } finally {
    btn.disabled = false;
  }
}

// --- Настройки аккаунта (модал) ---

function openAccountSettingsModal() {
  const overlay = document.getElementById("account-settings-overlay");
  if (!overlay) return;
  overlay.style.display = "flex";

  // заполняем текущие данные
  const loginEl = document.getElementById("settings-current-login");
  const emailEl = document.getElementById("settings-current-email");
  if (loginEl) loginEl.innerText = (currentUser && currentUser.login) || "—";
  if (emailEl) emailEl.innerText = (currentUser && currentUser.email) || "не указан";

  // сбрасываем все секции
  for (const name of ["login", "email", "password"]) {
    const body = document.getElementById("settings-body-" + name);
    const toggle = document.getElementById("settings-toggle-" + name);
    if (body) body.style.display = "none";
    if (toggle) toggle.innerText = "▸";
  }
  // сбрасываем поля
  const fields = ["settings-new-login", "settings-new-email", "settings-email-code",
    "settings-old-password", "settings-new-password"];
  for (const id of fields) {
    const el = document.getElementById(id);
    if (el) el.value = "";
  }
  const statuses = ["settings-login-status", "settings-email-status", "settings-password-status"];
  for (const id of statuses) {
    const el = document.getElementById(id);
    if (el) el.innerText = "";
  }
  // сбрасываем шаг email
  const step1 = document.getElementById("settings-email-step1");
  const step2 = document.getElementById("settings-email-step2");
  if (step1) step1.style.display = "";
  if (step2) step2.style.display = "none";
  _pendingNewEmail = null;
}

function closeAccountSettingsModal() {
  const overlay = document.getElementById("account-settings-overlay");
  if (overlay) overlay.style.display = "none";
}

function closeAccountSettingsModalOnOverlay(e) {
  if (e.target === e.currentTarget) closeAccountSettingsModal();
}

function toggleSettingsSection(name) {
  const body = document.getElementById("settings-body-" + name);
  const toggle = document.getElementById("settings-toggle-" + name);
  if (!body) return;
  const isOpen = body.style.display !== "none";
  // сворачиваем все
  for (const n of ["login", "email", "password"]) {
    const b = document.getElementById("settings-body-" + n);
    const t = document.getElementById("settings-toggle-" + n);
    if (b) b.style.display = "none";
    if (t) t.innerText = "▸";
  }
  // если была закрыта — открываем
  if (!isOpen) {
    body.style.display = "";
    if (toggle) toggle.innerText = "▾";
  }
}

// --- F4: Сменить логин ---

async function uiChangeLogin() {
  const btn = document.querySelector("#settings-body-login .btn-primary");
  if (btn.disabled) return;
  btn.disabled = true;
  const statusEl = document.getElementById("settings-login-status");
  try {
    const newLogin = (document.getElementById("settings-new-login").value || "").trim();
    if (!newLogin) { statusEl.innerText = "Введите новый логин."; return; }
    if (newLogin.length < 3 || newLogin.length > 64) { statusEl.innerText = "Логин должен быть от 3 до 64 символов."; return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(newLogin)) { statusEl.innerText = "Логин может содержать только латиницу, цифры, _ и -"; return; }

    const resp = await apiFetch("/v1/me/change-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_login: newLogin }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      if (data.detail === "login_same") statusEl.innerText = "Это ваш текущий логин.";
      else if (data.detail === "login_taken") statusEl.innerText = "Этот логин уже занят.";
      else if (data.detail === "login_invalid_length") statusEl.innerText = "Логин должен быть от 3 до 64 символов.";
      else if (data.detail === "login_invalid_chars") statusEl.innerText = "Логин может содержать только латиницу, цифры, _ и -";
      else statusEl.innerText = "Ошибка. Попробуйте ещё раз.";
      return;
    }
    // обновляем UI без перезагрузки
    currentUser.login = newLogin;
    const userTitle = document.getElementById("user-title");
    const roleBadge = currentUser.role === "admin" ? " (Админ)"
      : currentUser.role === "moderator" ? " (Модератор)" : "";
    if (userTitle) userTitle.innerText = `Привет, ${newLogin}!${roleBadge}`;
    document.getElementById("settings-current-login").innerText = newLogin;
    document.getElementById("settings-new-login").value = "";
    statusEl.innerText = "Логин изменён.";
  } catch (e) {
    statusEl.innerText = "Ошибка сети. Попробуйте ещё раз.";
  } finally {
    btn.disabled = false;
  }
}

// --- F3: Сменить пароль ---

async function uiChangePassword() {
  const btn = document.querySelector("#settings-body-password .btn-primary");
  if (btn.disabled) return;
  btn.disabled = true;
  const statusEl = document.getElementById("settings-password-status");
  try {
    const oldPw = document.getElementById("settings-old-password").value || "";
    const newPw = document.getElementById("settings-new-password").value || "";
    if (!oldPw) { statusEl.innerText = "Введите текущий пароль."; return; }
    if (!newPw) { statusEl.innerText = "Введите новый пароль."; return; }
    if (newPw.length < 8) { statusEl.innerText = "Пароль должен быть не короче 8 символов."; return; }
    if (newPw.length > 128) { statusEl.innerText = "Пароль не должен превышать 128 символов."; return; }

    const resp = await apiFetch("/v1/me/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      if (data.detail === "wrong_password") statusEl.innerText = "Неверный текущий пароль.";
      else if (data.detail === "no_password_set") statusEl.innerText = "Пароль не установлен (аккаунт через Telegram).";
      else if (data.detail === "password_too_short") statusEl.innerText = "Пароль должен быть не короче 8 символов.";
      else if (data.detail === "password_too_long") statusEl.innerText = "Пароль не должен превышать 128 символов.";
      else statusEl.innerText = "Ошибка. Попробуйте ещё раз.";
      return;
    }
    // сохраняем новый токен (старые сессии инвалидированы, текущая — продолжает работать)
    const data = await resp.json();
    if (data.access_token) {
      accessToken = data.access_token;
      localStorage.setItem(LS_TOKEN, accessToken);
    }
    closeAccountSettingsModal();
    alert("Пароль изменён.");
  } catch (e) {
    statusEl.innerText = "Ошибка сети. Попробуйте ещё раз.";
  } finally {
    btn.disabled = false;
  }
}

// --- F5: Сменить email ---

async function uiChangeEmailStart() {
  const btn = document.querySelector("#settings-email-step1 .btn-primary");
  if (btn.disabled) return;
  btn.disabled = true;
  const statusEl = document.getElementById("settings-email-status");
  try {
    const newEmail = (document.getElementById("settings-new-email").value || "").trim();
    if (!newEmail) { statusEl.innerText = "Введите новый email."; return; }

    const resp = await apiFetch("/v1/me/change-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_email: newEmail }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      if (data.detail === "email_same") statusEl.innerText = "Это ваш текущий email.";
      else if (data.detail === "email_taken") statusEl.innerText = "Этот email уже занят.";
      else if (data.detail === "invalid_email") statusEl.innerText = "Некорректный формат email.";
      else if (data.detail === "email_send_failed") statusEl.innerText = "Не удалось отправить письмо.";
      else statusEl.innerText = "Ошибка. Попробуйте ещё раз.";
      return;
    }
    // переключаемся на шаг 2
    _pendingNewEmail = newEmail;
    document.getElementById("settings-email-step1").style.display = "none";
    document.getElementById("settings-email-step2").style.display = "";
    document.getElementById("settings-email-target").innerText = newEmail;
    statusEl.innerText = "";
  } catch (e) {
    statusEl.innerText = "Ошибка сети. Попробуйте ещё раз.";
  } finally {
    btn.disabled = false;
  }
}

async function uiChangeEmailConfirm() {
  const btn = document.querySelector("#settings-email-step2 .btn-primary");
  if (btn.disabled) return;
  btn.disabled = true;
  const statusEl = document.getElementById("settings-email-status");
  try {
    const code = (document.getElementById("settings-email-code").value || "").trim();
    if (!code) { statusEl.innerText = "Введите код из письма."; return; }

    const resp = await apiFetch("/v1/me/confirm-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_email: _pendingNewEmail, code }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      if (data.detail === "wrong_code") statusEl.innerText = "Неверный код.";
      else if (data.detail === "code_expired") statusEl.innerText = "Код истёк. Запросите новый.";
      else if (data.detail === "no_active_code") statusEl.innerText = "Нет активного кода. Запросите новый.";
      else if (data.detail === "email_taken") statusEl.innerText = "Этот email уже занят.";
      else statusEl.innerText = "Ошибка. Попробуйте ещё раз.";
      return;
    }
    // сохраняем новый токен (старые сессии инвалидированы, текущая — продолжает работать)
    const data = await resp.json();
    if (data.access_token) {
      accessToken = data.access_token;
      localStorage.setItem(LS_TOKEN, accessToken);
    }
    // обновляем email в UI
    if (_pendingNewEmail && currentUser) currentUser.email = _pendingNewEmail;
    _pendingNewEmail = null;
    closeAccountSettingsModal();
    alert("Email изменён.");
  } catch (e) {
    statusEl.innerText = "Ошибка сети. Попробуйте ещё раз.";
  } finally {
    btn.disabled = false;
  }
}

function uiLogout() {
  accessToken = null;
  currentUser = null;
  localStorage.removeItem(LS_TOKEN);

  // вернуть верхнюю надпись
  const userTitle = document.getElementById("user-title");
  if (userTitle) userTitle.innerText = "Пользователь";

  // UI гость
  applyAuthUI(false);

  // tg блоки прячем
  const tgBtn = document.getElementById("tg-link-btn");
  const tgHint = document.getElementById("tg-hint");
  const tgStatus = document.getElementById("tg-status");
  const tgCode = document.getElementById("tg-link-code");
  if (tgBtn) tgBtn.style.display = "none";
  if (tgHint) tgHint.style.display = "none";
  if (tgStatus) tgStatus.innerText = "";
  if (tgCode) tgCode.innerText = "";

  // очищаем поля логина и регистрации
  const loginInput = document.getElementById("login-input");
  const loginPass = document.getElementById("login-password-input");
  if (loginInput) loginInput.value = "";
  if (loginPass) loginPass.value = "";

  const regLogin = document.getElementById("reg-login-input");
  const regEmail = document.getElementById("reg-email-input");
  const regPass = document.getElementById("reg-password-input");
  if (regLogin) regLogin.value = "";
  if (regEmail) regEmail.value = "";
  if (regPass) regPass.value = "";

  // убрать временный маркер и сбросить координаты
  if (tempMarker) {
    tempMarker.remove();
    tempMarker = null;
  }
  tempCoords = null;

  const coordsEl = document.getElementById("web-coords");
  if (coordsEl) coordsEl.textContent = "ПКМ по карте, чтобы выбрать точку.";

  const statusEl = document.getElementById("web-add-status");
  if (statusEl) statusEl.innerText = "Сначала войдите, чтобы добавлять точки.";

  refresh();
}

// --- Удаление аккаунта ---

function openDeleteAccountModal() {
  document.getElementById("delete-account-overlay").style.display = "flex";
}

function closeDeleteAccountModal() {
  document.getElementById("delete-account-overlay").style.display = "none";
}

function closeDeleteAccountModalOnOverlay(e) {
  if (e.target === e.currentTarget) closeDeleteAccountModal();
}

async function confirmDeleteAccount() {
  const resp = await fetch(`${API_BASE}/v1/me`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    alert("Не удалось удалить аккаунт.");
    return;
  }

  closeDeleteAccountModal();
  uiLogout();
  alert("Аккаунт успешно удалён.");
}

async function startTelegramLink() {
  if (!accessToken) {
    alert("Сначала войдите.");
    return;
  }

  const tgCode = document.getElementById("tg-link-code");
  if (tgCode) {
    tgCode.style.display = "";
    tgCode.innerText = "Генерирую код...";
  }

  try {
    const resp = await apiFetch("/v1/me/telegram-link/start", { method: "POST" });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      if (tgCode) tgCode.innerText = `Ошибка генерации кода (${resp.status}). ${txt}`;
      return;
    }

    const data = await resp.json();

    // deep link — кликабельная кнопка-ссылка на бота
    if (tgCode) {
      if (data.bot_link) {
        tgCode.innerHTML =
          `<a href="${data.bot_link}" target="_blank" class="btn btn-primary" ` +
          `style="display:inline-block;text-decoration:none;margin-top:4px;">` +
          `Открыть бота и привязать</a>` +
          `<div class="hint" style="margin-top:4px;">Или отправьте боту: /link ${data.code}</div>`;
      } else {
        tgCode.innerText = `Отправьте боту:\n/link ${data.code}`;
      }
    }

    // ждем привязку
    let attempts = 30;
    const timer = setInterval(async () => {
      attempts--;
      await loadMe();
      if (currentUser?.tg_id || attempts <= 0) clearInterval(timer);
    }, 2000);

  } catch (e) {
    console.error(e);
    if (tgCode) tgCode.innerText = "Ошибка сети при генерации кода.";
  }
}


// -------------------- FRIENDS UI --------------------

function updateNotifBadge() {
  const badge = document.getElementById("notif-badge");
  if (!badge) return;

  const fr = (currentUser && typeof currentUser.friend_requests_inbox_count === "number")
    ? currentUser.friend_requests_inbox_count : 0;
  const gi = (currentUser && typeof currentUser.group_invites_inbox_count === "number")
    ? currentUser.group_invites_inbox_count : 0;
  const nc = (currentUser && typeof currentUser.notifications_count === "number")
    ? currentUser.notifications_count : 0;
  const n = fr + gi + nc;

  badge.innerText = String(n);
  badge.style.display = n > 0 ? "" : "none";
}

function refreshFriendsUI() {
  const listEl = document.getElementById("friends-list");
  if (!listEl) return;

  const friends = (currentUser && Array.isArray(currentUser.friends)) ? currentUser.friends : [];
  if (friends.length === 0) {
    listEl.innerHTML = `<div class="hint">Пока друзей нет.</div>`;
    // Не return — ниже обновляем секцию заблокированных
    refreshBlockedListUI();
    return;
  }

  listEl.innerHTML = friends.map(u => {
    const title = escapeHtml(u.login || u.username || `user#${u.id}`);
    const sub = escapeHtml(
      [
        u.username ? `@${u.username}` : null,
        u.tg_id ? `tg:${u.tg_id}` : null,
      ].filter(Boolean).join(" • ")
    );

    const displayName = u.login || u.username || `user#${u.id}`;
    const escapedName = escapeHtml(displayName);
    return `
      <div class="list-item">
        <div class="meta">
          <div class="title">${title}</div>
          <div class="sub">${sub || ""}</div>
        </div>
        <div class="actions">
          <div class="mm-popup-menu">
            <button class="mm-popup-menu-btn" onclick="toggleFriendMenu(this, event)" title="Действия">⋮</button>
            <div class="mm-popup-dropdown">
              <button class="mm-popup-dropdown-item" onclick="confirmRemoveFriend(${u.id}, '${escapedName}')">Удалить из друзей</button>
              <button class="mm-popup-dropdown-item" onclick="confirmBlockUser(${u.id}, '${escapedName}')">Заблокировать</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join("");

  // Обновляем секцию заблокированных
  refreshBlockedListUI();
}

function renderGroupLayersUI() {
  const listEl = document.getElementById("group-layers-list");
  if (!listEl) return;

  const groups = (currentUser && Array.isArray(currentUser.groups)) ? currentUser.groups : [];
  const meId = currentUser?.id;

  // detect personal group (preferred: is_personal flag; fallback: legacy name)
  personalGroupId = null;
  for (const g of groups) {
    if (!g || !g.id) continue;
    if (g.is_personal === true) { personalGroupId = g.id; break; }
  }
  if (!personalGroupId) {
    for (const g of groups) {
      if (g && g.visibility === "private" && typeof g.name === "string" && meId != null) {
        if (g.name === `Личная карта ${meId}` || g.name === `Личная карта`) {
          personalGroupId = g.id;
          break;
        }
      }
    }
  }

  const layerGroups = groups
    .filter(g => g && g.id && g.visibility !== "public" && g.id !== 1 && (!personalGroupId || g.id !== personalGroupId))
    .sort((a,b) => (a.id||0) - (b.id||0));

  const parts = [];

  if (personalGroupId) {
    const checked = selectedGroupLayerIds.has(personalGroupId) ? "checked" : "";
    parts.push(
      `<div class="layer-row">
        <div class="left">
          <input type="checkbox" ${checked} onchange="toggleGroupLayer(${personalGroupId}, this.checked)">
          <div>
            <div class="name">Личная карта</div>
            <div class="meta">только вы</div>
          </div>
        </div>
        <div class="actions">
          <button class="btn btn-ghost btn-icon" title="Открыть" onclick="openEditLayerModal(${personalGroupId})">⚙</button>
        </div>
      </div>`
    );
  } else {
    parts.push(`<div class="hint"></div>`);
  }

  for (const g of layerGroups) {
    const checked = selectedGroupLayerIds.has(g.id) ? "checked" : "";
    const name = escapeHtml(g.name || `Слой ${g.id}`);
    const visibility = g.visibility === "friends" ? "друзья" : "приватный";
    const role = g.my_role ? String(g.my_role) : "";
    const canEdit = role === "owner";
    parts.push(
      `<div class="layer-row">
        <div class="left">
          <input type="checkbox" ${checked} onchange="toggleGroupLayer(${g.id}, this.checked)">
          <div style="min-width:0;">
            <div class="name">${name}</div>
            <div class="meta">${escapeHtml(visibility)}${role ? ` • ${escapeHtml(role)}` : ""}</div>
          </div>
        </div>
        <div class="actions">
          ${`<button class="btn btn-ghost btn-icon" title="Открыть" onclick="openEditLayerModal(${g.id})">⚙</button>`}
        </div>
      </div>`
    );
  }

  listEl.innerHTML = parts.join("");
}

function toggleGroupLayer(groupId, isChecked) {
  if (isChecked) selectedGroupLayerIds.add(groupId);
  else selectedGroupLayerIds.delete(groupId);
  refresh();
}

function populateAddGroupSelect() {
  const sel = document.getElementById("web-group");
  if (!sel) return;

  const groups = (currentUser && Array.isArray(currentUser.groups)) ? currentUser.groups : [];
  // Only show groups where user can write: public, or private where role owner/editor.
  const opts = [];
  opts.push({ id: 1, label: "Публичные точки" });
  if (personalGroupId) opts.push({ id: personalGroupId, label: "Личная карта" });

  for (const g of groups) {
    if (!g || !g.id) continue;
    if (g.id === 1) continue;
    if (g.visibility === "public") continue;
    const role = g.my_role;
    if (role === "owner" || role === "editor") {
      if (personalGroupId && g.id === personalGroupId) continue;
      opts.push({ id: g.id, label: g.name || `Слой ${g.id}` });
    }
  }

  const current = Number(sel.value || 1);
  sel.innerHTML = opts.map(o => `<option value="${o.id}">${escapeHtml(o.label)}</option>`).join("");
  // keep selection if possible
  const still = opts.find(o => o.id === current);
  sel.value = String(still ? current : 1);
}

// -------------------- LAYERS MODAL (groups UI) --------------------

function closeLayersModalOnOverlay(event) {
  if (event && event.target && event.target.id === "layers-modal-overlay") {
    closeLayersModal();
  }
}

function closeLayersModal() {
  const overlay = document.getElementById("layers-modal-overlay");
  if (!overlay) return;
  overlay.style.display = "none";
  const content = document.getElementById("layers-modal-content");
  if (content) content.innerHTML = "";
}

function openLayersModal(title, html) {
  const overlay = document.getElementById("layers-modal-overlay");
  const t = document.getElementById("layers-modal-title");
  const content = document.getElementById("layers-modal-content");
  if (!overlay || !content || !t) return;
  t.innerText = title || "Слой";
  content.innerHTML = html;
  overlay.style.display = "";
}

function openCreateLayerModal() {
  if (!accessToken) { alert("Сначала войдите."); return; }
  const friends = (currentUser && Array.isArray(currentUser.friends)) ? currentUser.friends : [];
  const friendsHtml = friends.length === 0
    ? `<div class="hint">Добавлять редакторов можно только из друзей. Пока друзей нет.</div>`
    : friends.map(f => {
        const label = escapeHtml(f.login || f.username || `user#${f.id}`);
        return `
          <label style="display:flex;align-items:center;gap:8px;margin:6px 0;">
            <input type="checkbox" class="layer-friend-checkbox" value="${f.id}">
            <span>${label}</span>
          </label>
        `;
      }).join("");

  openLayersModal("Новый слой", `
    <div class="field-label">Название слоя</div>
    <input id="layer-create-name" class="input" placeholder="Например: Поездки" />

    <div class="field-label" style="margin-top:10px;">Добавить редакторов (друзья)</div>
    <div style="max-height:220px;overflow:auto;border:1px solid #e5e7eb;border-radius:14px;padding:8px;">
      ${friendsHtml}
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
      <button class="btn" onclick="closeLayersModal()">Отмена</button>
      <button class="btn btn-primary" onclick="submitCreateLayer()">Создать</button>
    </div>
    <div id="layer-create-status" class="hint" style="margin-top:8px;"></div>
  `);
}

async function submitCreateLayer() {
  const statusEl = document.getElementById("layer-create-status");
  const nameEl = document.getElementById("layer-create-name");
  const name = (nameEl ? nameEl.value : "").trim();
  if (!name) { if (statusEl) statusEl.innerText = "Введите название."; return; }

  const checked = Array.from(document.querySelectorAll(".layer-friend-checkbox"))
    .filter(x => x.checked)
    .map(x => Number(x.value))
    .filter(Boolean);

  try {
    if (statusEl) statusEl.innerText = "Создаю слой…";
    const resp = await apiFetch("/v1/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, visibility: "private", add_friends: false }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (statusEl) statusEl.innerText = "Ошибка: " + (data.detail || resp.status);
      return;
    }
    const gid = data.id;

    // отправить инвайты выбранным друзьям
    for (const uid of checked) {
      await apiFetch(`/v1/groups/${gid}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: uid, role: "editor" }),
      });
    }

    await refreshUserSnapshot();
    renderGroupLayersUI();
    populateAddGroupSelect();
    closeLayersModal();
    alert("Слой создан.");
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.innerText = "Ошибка сети.";
  }
}

async function openEditLayerModal(groupId) {
  if (!accessToken) { alert("Сначала войдите."); return; }

  // determine my role from current snapshot
  const g = ((currentUser && currentUser.groups) || []).find(x => x.id === groupId);
  const myRole = g ? g.my_role : null;
  const isOwner = myRole === "owner" || currentUser?.role === "admin";
  const isPersonal = personalGroupId && groupId === personalGroupId;

  try {
    const resp = await apiFetch(`/v1/groups/${groupId}`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert("Не удалось открыть слой: " + (data.detail || resp.status));
      return;
    }

    const title = escapeHtml(data.name || `Слой ${groupId}`);
    const members = Array.isArray(data.members) ? data.members : [];
    const friends = (currentUser && Array.isArray(currentUser.friends)) ? currentUser.friends : [];
    const memberIds = new Set(members.map(m => m.id));
    // pendingInviteUserIds заполняется ниже, но для фильтрации addable нужно загрузить инвайты заранее
    let pendingInviteUserIds = new Set();
    let pendingInvitesForGroup = [];
    if (isOwner && !isPersonal) {
      try {
        const invResp = await apiFetch(`/v1/groups/invites?outbox=1&status=pending`);
        const invData = await invResp.json().catch(() => ({}));
        if (invResp.ok) {
          pendingInvitesForGroup = (Array.isArray(invData.items) ? invData.items : [])
            .filter(inv => inv.group && inv.group.id === groupId);
          pendingInviteUserIds = new Set(pendingInvitesForGroup.map(inv => inv.to_user?.id).filter(Boolean));
        }
      } catch (_) {}
    }
    const addable = friends.filter(f => !memberIds.has(f.id) && !pendingInviteUserIds.has(f.id));

    const membersHtml = members.map(m => {
      const label = escapeHtml(m.login || m.username || `user#${m.id}`);
      const role = m.role || "viewer";
      const isSelf = currentUser && m.id === currentUser.id;
      const isOwnerMember = role === "owner";

      const roleControl = (!isOwner || isOwnerMember || isSelf)
        ? `<span class="hint">${escapeHtml(role)}</span>`
        : `
            <select class="input" style="padding:4px 8px;" onchange="changeLayerMemberRole(${groupId}, ${m.id}, this.value)">
              <option value="editor" ${role === "editor" ? "selected" : ""}>editor</option>
              <option value="viewer" ${role === "viewer" ? "selected" : ""}>viewer</option>
            </select>
          `;

      const removeBtn = (!isOwner || isOwnerMember || isSelf)
        ? ``
        : `<button class="btn btn-ghost btn-icon" title="Удалить" onclick="removeLayerMember(${groupId}, ${m.id}, '${label}')">✕</button>`;

      return `
        <div class="list-item" style="align-items:center;">
          <div class="meta">
            <div class="title">${label}</div>
            <div class="sub">role: ${escapeHtml(role)}</div>
          </div>
          <div class="actions" style="display:flex;gap:6px;align-items:center;">
            ${roleControl}
            ${removeBtn}
          </div>
        </div>
      `;
    }).join("");

    const addFriendOptions = addable.map(f => {
      const label = escapeHtml(f.login || f.username || `user#${f.id}`);
      return `<option value="${f.id}">${label}</option>`;
    }).join("");

    // Pending-инвайты для этой группы (данные загружены выше)
    let pendingInvitesHtml = "";
    if (isOwner && !isPersonal && pendingInvitesForGroup.length > 0) {
      pendingInvitesHtml = `
        <div class="field-label" style="margin-top:10px;">Ожидающие приглашения</div>
        <div class="list" style="margin-top:6px;">
          ${pendingInvitesForGroup.map(inv => {
            const to = inv.to_user || {};
            const toName = escapeHtml(to.login || to.username || `user#${to.id || "?"}`);
            const roleLabel = inv.role === "editor" ? "редактор" : "наблюдатель";
            return `
              <div class="list-item" style="align-items:center;">
                <div class="meta">
                  <div class="title">${toName}</div>
                  <div class="sub">${escapeHtml(roleLabel)} • ожидает</div>
                </div>
                <div class="actions">
                  <button class="btn btn-ghost btn-icon" title="Отменить" onclick="cancelGroupInvite(${inv.id}, ${groupId})">✕</button>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      `;
    }

    const addSection = (isOwner && !isPersonal) ? `
      <div class="divider" style="margin:12px 0;"></div>
      <div class="field-label">Пригласить друга</div>
      <div style="display:flex;gap:8px;align-items:center;">
        <select id="layer-add-user" class="input" style="flex:1;">
          ${addFriendOptions || ""}
        </select>
        <select id="layer-add-role" class="input" style="width:140px;">
          <option value="editor">editor</option>
          <option value="viewer">viewer</option>
        </select>
        <button class="btn btn-primary" onclick="sendLayerInvite(${groupId})" ${addable.length ? "" : "disabled"}>Пригласить</button>
      </div>
      <div class="hint" style="margin-top:6px;">Приглашать можно только друзей.</div>
      ${pendingInvitesHtml}
    ` : `
      <div class="hint" style="margin-top:10px;">Управлять участниками может только владелец слоя.</div>
    `;

    const renameSection = isOwner ? `
      <div class="field-label">Переименовать</div>
      <div style="display:flex;gap:8px;align-items:center;">
        <input id="layer-rename" class="input" value="${title}" style="flex:1;" />
        <button class="btn" onclick="renameLayer(${groupId})">Сохранить</button>
      </div>
    ` : ``;

    openLayersModal(`Слой: ${title}`, `
      ${renameSection}
      <div class="field-label" style="margin-top:10px;">Участники</div>
      <div class="list" style="margin-top:8px;">${membersHtml || `<div class="hint">Нет участников.</div>`}</div>
      ${isPersonal ? `<div class="hint" style="margin-top:10px;">Личный слой не поддерживает совместное редактирование.</div>` : addSection}
      <div id="layer-edit-status" class="hint" style="margin-top:10px;"></div>
      <div class="divider" style="margin:12px 0;"></div>
      <div style="display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap;">
        ${(!isPersonal && !isOwner) ? `<button class="btn" onclick="leaveLayer(${groupId})">Выйти из слоя</button>` : ``}
        <div style="display:flex;gap:8px;margin-left:auto;">
          ${(!isPersonal && isOwner) ? `<button class="btn btn-danger" onclick="deleteLayer(${groupId})">Удалить слой</button>` : ``}
        </div>
      </div>

    `);

  } catch (e) {
    console.error(e);
    alert("Ошибка сети.");
  }
}

async function renameLayer(groupId) {
  const statusEl = document.getElementById("layer-edit-status");
  const inp = document.getElementById("layer-rename");
  const name = (inp ? inp.value : "").trim();
  if (!name) { if (statusEl) statusEl.innerText = "Название не может быть пустым."; return; }
  try {
    const resp = await apiFetch(`/v1/groups/${groupId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (statusEl) statusEl.innerText = "Ошибка: " + (data.detail || resp.status);
      return;
    }
    await refreshUserSnapshot();
    renderGroupLayersUI();
    populateAddGroupSelect();
    if (statusEl) statusEl.innerText = "Сохранено.";
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.innerText = "Ошибка сети.";
  }
}

async function addLayerMember(groupId) {
  // legacy: прямое добавление (используется ботом, оставляем для обратной совместимости)
  const statusEl = document.getElementById("layer-edit-status");
  const userSel = document.getElementById("layer-add-user");
  const roleSel = document.getElementById("layer-add-role");
  const uid = userSel ? Number(userSel.value) : null;
  const role = roleSel ? roleSel.value : "editor";
  if (!uid) return;
  try {
    const resp = await apiFetch(`/v1/groups/${groupId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: uid, role }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (statusEl) statusEl.innerText = "Ошибка: " + (data.detail || resp.status);
      return;
    }
    await refreshUserSnapshot();
    renderGroupLayersUI();
    populateAddGroupSelect();
    openEditLayerModal(groupId);
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.innerText = "Ошибка сети.";
  }
}

async function sendLayerInvite(groupId) {
  const statusEl = document.getElementById("layer-edit-status");
  const userSel = document.getElementById("layer-add-user");
  const roleSel = document.getElementById("layer-add-role");
  const uid = userSel ? Number(userSel.value) : null;
  const role = roleSel ? roleSel.value : "editor";
  if (!uid) return;
  try {
    const resp = await apiFetch(`/v1/groups/${groupId}/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: uid, role }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (statusEl) statusEl.innerText = "Ошибка: " + (data.detail || resp.status);
      return;
    }
    if (data.status === "already_pending") {
      if (statusEl) statusEl.innerText = "Приглашение уже отправлено.";
      return;
    }
    if (statusEl) statusEl.innerText = "Приглашение отправлено.";
    // Обновляем модалку чтобы показать pending-инвайт
    openEditLayerModal(groupId);
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.innerText = "Ошибка сети.";
  }
}

async function cancelGroupInvite(inviteId, groupId) {
  const statusEl = document.getElementById("layer-edit-status");
  try {
    const resp = await apiFetch(`/v1/groups/invites/${inviteId}`, { method: "DELETE" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (statusEl) statusEl.innerText = "Ошибка: " + (data.detail || resp.status);
      return;
    }
    openEditLayerModal(groupId);
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.innerText = "Ошибка сети.";
  }
}

async function removeLayerMember(groupId, userId, displayName) {
  const ok = confirm(`Удалить пользователя ${displayName} из слоя?`);
  if (!ok) return;
  const statusEl = document.getElementById("layer-edit-status");
  try {
    const resp = await apiFetch(`/v1/groups/${groupId}/members/${userId}`, { method: "DELETE" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (statusEl) statusEl.innerText = "Ошибка: " + (data.detail || resp.status);
      return;
    }
    await refreshUserSnapshot();
    renderGroupLayersUI();
    populateAddGroupSelect();
    openEditLayerModal(groupId);
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.innerText = "Ошибка сети.";
  }
}

async function changeLayerMemberRole(groupId, userId, role) {
  const statusEl = document.getElementById("layer-edit-status");
  try {
    const resp = await apiFetch(`/v1/groups/${groupId}/members/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (statusEl) statusEl.innerText = "Ошибка: " + (data.detail || resp.status);
      return;
    }
    await refreshUserSnapshot();
    openEditLayerModal(groupId);
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.innerText = "Ошибка сети.";
  }
}

function toggleFriendMenu(btn, event) {
  event.stopPropagation();
  const dd = btn.nextElementSibling;
  // Закрываем все остальные открытые меню
  document.querySelectorAll(".mm-popup-dropdown.open").forEach(el => {
    if (el !== dd) el.classList.remove("open");
  });
  dd.classList.toggle("open");
}

// Закрытие comment-dropdown при ресайзе окна
window.addEventListener("resize", () => {
  document.querySelectorAll(".comment-actions .mm-popup-dropdown.open").forEach(el => el.classList.remove("open"));
});

// Закрытие popup-меню, редактирования и модалки комментариев по Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    // Приоритет 1: закрываем dropdown-меню
    const openDropdowns = document.querySelectorAll(".comment-actions .mm-popup-dropdown.open");
    if (openDropdowns.length) {
      openDropdowns.forEach(el => el.classList.remove("open"));
      return;
    }
    // Приоритет 2: закрываем inline-редактирование
    const editDivs = document.querySelectorAll("[id^='comment-edit-']");
    if (editDivs.length) {
      editDivs.forEach(editDiv => {
        const cId = editDiv.id.replace("comment-edit-", "");
        const textEl = document.getElementById(`comment-text-${cId}`);
        if (textEl) textEl.style.display = "";
        const actionsEl = editDiv.parentElement?.querySelector(".comment-actions");
        if (actionsEl) actionsEl.style.display = "";
        editDiv.remove();
      });
      return;
    }
    // Приоритет 3: закрываем модалку комментариев
    const commOverlay = document.getElementById("comments-overlay");
    if (commOverlay && commOverlay.style.display !== "none") {
      closeCommentsModal();
    }
  }
});

// Закрытие popup-меню при клике вне
document.addEventListener("click", (e) => {
  if (e.target.closest(".mm-popup-dropdown")) return;
  document.querySelectorAll(".mm-popup-dropdown.open").forEach(el => el.classList.remove("open"));

  // Делегированный обработчик «Ответить» (data-атрибуты вместо inline onclick — защита от XSS)
  const replyBtn = e.target.closest(".comment-reply-btn");
  if (replyBtn) {
    const commentId = +replyBtn.dataset.commentId;
    const author = replyBtn.dataset.author;
    if (commentId) startReplyComment(commentId, author);
  }

  // Клик по «↩ @автор» — прокрутка к родительскому комментарию
  const replyTo = e.target.closest(".comment-reply-to");
  if (replyTo) {
    const targetId = replyTo.dataset.targetId;
    if (targetId) scrollToComment(+targetId);
  }
});

async function confirmRemoveFriend(friendId, friendName) {
  if (!accessToken) { alert("Сначала войдите."); return; }
  const ok = confirm(`Точно хотите удалить из друзей ${friendName}?`);
  if (!ok) return;

  try {
    const resp = await apiFetch(`/v1/friends/${friendId}`, { method: "DELETE" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert("Не удалось удалить из друзей: " + (data.detail || resp.status));
      return;
    }
    await refreshUserSnapshot();
    refreshFriendsUI();
    // обновим поиск/инвайты тоже
    outgoingPendingIds.delete(friendId);
    updateNotifBadge();
  } catch (e) {
    console.error(e);
    alert("Ошибка сети при удалении из друзей.");
  }
}

// -------------------- BLOCK / UNBLOCK --------------------

async function confirmBlockUser(userId, displayName) {
  if (!accessToken) { alert("Сначала войдите."); return; }
  const ok = confirm(`Заблокировать ${displayName}? Дружба будет удалена, пользователь не сможет найти вас и отправить запрос.`);
  if (!ok) return;

  try {
    const resp = await apiFetch("/v1/blocks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert("Не удалось заблокировать: " + (data.detail || resp.status));
      return;
    }
    await refreshUserSnapshot();
    refreshFriendsUI();
    updateNotifBadge();
  } catch (e) {
    console.error(e);
    alert("Ошибка сети при блокировке.");
  }
}

async function declineAndBlockUser(requestId, userId, displayName) {
  if (!accessToken) { alert("Сначала войдите."); return; }
  const ok = confirm(`Отклонить запрос и заблокировать ${displayName}?`);
  if (!ok) return;

  try {
    // Сначала отклоняем запрос
    await apiFetch(`/v1/friends/requests/${requestId}/decline`, { method: "POST" });

    // Затем блокируем
    const resp = await apiFetch("/v1/blocks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert("Запрос отклонён, но не удалось заблокировать: " + (data.detail || resp.status));
    }
    await refreshUserSnapshot();
    await loadFriendRequestsLists();
    refreshFriendsUI();
    updateNotifBadge();
  } catch (e) {
    console.error(e);
    alert("Ошибка сети.");
  }
}

async function unblockUser(userId) {
  if (!accessToken) { alert("Сначала войдите."); return; }

  try {
    const resp = await apiFetch(`/v1/blocks/${userId}`, { method: "DELETE" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert("Не удалось разблокировать: " + (data.detail || resp.status));
      return;
    }
    await refreshUserSnapshot();
    refreshBlockedListUI();
  } catch (e) {
    console.error(e);
    alert("Ошибка сети при разблокировке.");
  }
}

function refreshBlockedListUI() {
  const section = document.getElementById("blocked-section");
  const listEl = document.getElementById("blocked-list");
  if (!section || !listEl) return;

  const blocked = (currentUser && Array.isArray(currentUser.blocked_users)) ? currentUser.blocked_users : [];
  if (blocked.length === 0) {
    section.style.display = "none";
    listEl.innerHTML = "";
    return;
  }

  section.style.display = "";
  listEl.innerHTML = blocked.map(u => {
    const title = escapeHtml(u.login || u.username || `user#${u.id}`);
    return `
      <div class="list-item">
        <div class="meta">
          <div class="title">${title}</div>
        </div>
        <div class="actions">
          <button class="btn" onclick="unblockUser(${u.id})">Разблокировать</button>
        </div>
      </div>
    `;
  }).join("");
}

async function uiSearchUsers() {
  if (!accessToken) { alert("Сначала войдите."); return; }

  const qEl = document.getElementById("friends-search-input");
  const statusEl = document.getElementById("friends-search-status");
  const resEl = document.getElementById("friends-search-results");
  if (!qEl || !resEl) return;

  const q = (qEl.value || "").trim();
  if (!q) {
    if (statusEl) statusEl.innerText = "Введите строку поиска.";
    resEl.innerHTML = "";
    return;
  }

  if (statusEl) statusEl.innerText = "Ищу…";
  resEl.innerHTML = "";

  try {
    const resp = await apiFetch(`/v1/users/search?q=${encodeURIComponent(q)}&limit=20`);
    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      if (statusEl) statusEl.innerText = "Ошибка: " + (data.detail || resp.status);
      return;
    }

    const items = Array.isArray(data.items) ? data.items : [];
    const myId = currentUser ? currentUser.id : null;
    const friendIds = new Set(((currentUser && currentUser.friends) || []).map(x => x.id));

    const filtered = items.filter(u => u && u.id && u.id !== myId);

    if (filtered.length === 0) {
      if (statusEl) statusEl.innerText = "Ничего не найдено.";
      return;
    }

    if (statusEl) statusEl.innerText = `Найдено: ${filtered.length}`;

    resEl.innerHTML = filtered.map(u => {
      const title = escapeHtml(u.login || u.username || `user#${u.id}`);
      const sub = escapeHtml(
        [
          u.username ? `@${u.username}` : null,
          u.tg_id ? `tg:${u.tg_id}` : null,
        ].filter(Boolean).join(" • ")
      );

      const alreadyFriend = friendIds.has(u.id);
      const pending = outgoingPendingIds.has(u.id);
      const btnId = `fr-add-btn-${u.id}`;
      return `
        <div class="list-item">
          <div class="meta">
            <div class="title">${title}</div>
            <div class="sub">${sub || ""}</div>
          </div>
          <div class="actions">
            ${
              alreadyFriend
                ? `<button id="${btnId}" class="btn btn-success" disabled>Друг</button>`
                : pending
                  ? `<button id="${btnId}" class="btn btn-secondary" disabled>Ждём ответ</button>`
                  : `<button id="${btnId}" class="btn btn-primary" onclick="sendFriendRequest(${u.id})">Добавить</button>`
            }
          </div>
        </div>
      `;
    }).join("");
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.innerText = "Ошибка сети.";
  }
}

async function sendFriendRequest(toUserId) {
  if (!accessToken) { alert("Сначала войдите."); return; }

  // Optimistic UI: disable the button right away
  const btn = document.getElementById(`fr-add-btn-${toUserId}`);
  if (btn) {
    btn.disabled = true;
    btn.classList.remove("btn-primary");
    btn.classList.add("btn-secondary");
    btn.innerText = "Ждём ответ";
  }
  outgoingPendingIds.add(toUserId);

  try {
    const resp = await apiFetch("/v1/friends/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_user_id: toUserId }),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      outgoingPendingIds.delete(toUserId);
      if (btn) {
        btn.disabled = false;
        btn.classList.remove("btn-secondary");
        btn.classList.add("btn-primary");
        btn.innerText = "Добавить";
      }
      alert("Не удалось отправить приглашение: " + (data.detail || resp.status));
      return;
    }

    // backend might auto-accept reverse request
    if (data.status === "accepted_by_reverse_request") {
      outgoingPendingIds.delete(toUserId);
      alert("Запрос был принят автоматически (встречное приглашение). Теперь вы друзья.");
    } else if (data.status === "already_friends") {
      outgoingPendingIds.delete(toUserId);
      alert("Вы уже друзья.");
    } else {
      alert("Приглашение отправлено.");
    }

    await refreshUserSnapshot();
    await loadFriendRequestsListsSafe();
    uiSearchUsers();
  } catch (e) {
    console.error(e);
    outgoingPendingIds.delete(toUserId);
    alert("Ошибка сети при отправке приглашения.");
  }
}

async function loadFriendRequestsListsSafe() {
  // helper: refresh outgoing pending set without requiring modal to be open
  if (!accessToken) return;
  try {
    const outResp = await apiFetch("/v1/friends/requests?outbox=1&status=pending");
    const outData = await outResp.json().catch(() => ({}));
    if (!outResp.ok) return;
    const items = Array.isArray(outData.items) ? outData.items : [];
    outgoingPendingIds = new Set(items.map(r => r.to_user?.id).filter(Boolean));
  } catch (_) {
    // ignore
  }
}

function closeModalOnOverlay(event) {
  // закрываем, если кликнули именно по оверлею
  if (event && event.target && event.target.id === "modal-overlay") {
    closeFriendRequestsModal();
  }
}

async function openFriendRequestsModal() {
  if (!accessToken) { alert("Сначала войдите."); return; }

  const overlay = document.getElementById("modal-overlay");
  if (!overlay) return;

  overlay.style.display = "";

  // загрузим списки
  await loadFriendRequestsLists();
}

function closeFriendRequestsModal(silent = false) {
  const overlay = document.getElementById("modal-overlay");
  if (!overlay) return;

  overlay.style.display = "none";

  // очистка списков
  const inbox = document.getElementById("inbox-requests");
  const outbox = document.getElementById("outbox-requests");
  const giBox = document.getElementById("group-invites-inbox");
  const notifList = document.getElementById("notifications-list");
  if (inbox) inbox.innerHTML = "";
  if (outbox) outbox.innerHTML = "";
  if (giBox) giBox.innerHTML = "";
  if (notifList) notifList.innerHTML = "";

  if (!silent) {
    // ничего
  }
}

async function loadFriendRequestsLists() {
  const inbox = document.getElementById("inbox-requests");
  const outbox = document.getElementById("outbox-requests");
  const giBox = document.getElementById("group-invites-inbox");
  if (!inbox || !outbox) return;

  inbox.innerHTML = `<div class="hint">Загрузка…</div>`;
  outbox.innerHTML = `<div class="hint">Загрузка…</div>`;
  if (giBox) giBox.innerHTML = `<div class="hint">Загрузка…</div>`;

  try {
    const fetches = [
      apiFetch("/v1/friends/requests?inbox=1&status=pending"),
      apiFetch("/v1/friends/requests?outbox=1&status=pending"),
      apiFetch("/v1/groups/invites?inbox=1&status=pending"),
    ];
    const [inResp, outResp, giResp] = await Promise.all(fetches);

    const inData = await inResp.json().catch(() => ({}));
    const outData = await outResp.json().catch(() => ({}));
    const giData = await giResp.json().catch(() => ({}));

    if (!inResp.ok) {
      inbox.innerHTML = `<div class="hint">Ошибка: ${escapeHtml(inData.detail || String(inResp.status))}</div>`;
    } else {
      const items = Array.isArray(inData.items) ? inData.items : [];
      if (items.length === 0) {
        inbox.innerHTML = `<div class="hint">Нет входящих приглашений.</div>`;
      } else {
        inbox.innerHTML = items.map(r => {
          const from = r.from_user || {};
          const title = escapeHtml(from.login || from.username || `user#${from.id || "?"}`);
          const sub = escapeHtml(
            [
              from.username ? `@${from.username}` : null,
              from.tg_id ? `tg:${from.tg_id}` : null,
            ].filter(Boolean).join(" • ")
          );

          const fromName = escapeHtml(from.login || from.username || `user#${from.id || "?"}`);
          return `
            <div class="list-item">
              <div class="meta">
                <div class="title">${title}</div>
                <div class="sub">${sub || ""}</div>
              </div>
              <div class="actions">
                <button class="btn btn-primary" onclick="acceptFriendRequest(${r.id})">Принять</button>
                <button class="btn" onclick="declineFriendRequest(${r.id})">Отклонить</button>
                <div class="mm-popup-menu">
                  <button class="mm-popup-menu-btn" onclick="toggleFriendMenu(this, event)" title="Ещё">⋮</button>
                  <div class="mm-popup-dropdown">
                    <button class="mm-popup-dropdown-item" onclick="declineAndBlockUser(${r.id}, ${from.id}, '${fromName}')">Заблокировать</button>
                  </div>
                </div>
              </div>
            </div>
          `;
        }).join("");
      }
    }

    if (!outResp.ok) {
      outbox.innerHTML = `<div class="hint">Ошибка: ${escapeHtml(outData.detail || String(outResp.status))}</div>`;
    } else {
      // refresh outgoing pending set
      const outItems = Array.isArray(outData.items) ? outData.items : [];
      outgoingPendingIds = new Set(outItems.map(r => r.to_user?.id).filter(Boolean));

      const items = Array.isArray(outData.items) ? outData.items : [];
      if (items.length === 0) {
        outbox.innerHTML = `<div class="hint">Нет исходящих приглашений.</div>`;
      } else {
        outbox.innerHTML = items.map(r => {
          const to = r.to_user || {};
          const title = escapeHtml(to.login || to.username || `user#${to.id || "?"}`);
          const sub = escapeHtml(
            [
              to.username ? `@${to.username}` : null,
              to.tg_id ? `tg:${to.tg_id}` : null,
            ].filter(Boolean).join(" • ")
          );

          return `
            <div class="list-item">
              <div class="meta">
                <div class="title">${title}</div>
                <div class="sub">${sub || ""}</div>
              </div>
              <div class="actions">
                <span class="hint">ожидает</span>
              </div>
            </div>
          `;
        }).join("");
      }
    }

    // Приглашения в слои (входящие)
    if (giBox) {
      if (!giResp.ok) {
        giBox.innerHTML = `<div class="hint">Ошибка: ${escapeHtml(giData.detail || String(giResp.status))}</div>`;
      } else {
        const items = Array.isArray(giData.items) ? giData.items : [];
        if (items.length === 0) {
          giBox.innerHTML = `<div class="hint">Нет приглашений в слои.</div>`;
        } else {
          giBox.innerHTML = items.map(r => {
            const from = r.from_user || {};
            const group = r.group || {};
            const fromName = escapeHtml(from.login || from.username || `user#${from.id || "?"}`);
            const groupName = escapeHtml(group.name || `слой #${group.id || "?"}`);
            const roleLabel = r.role === "editor" ? "редактор" : "наблюдатель";

            return `
              <div class="list-item">
                <div class="meta">
                  <div class="title">${groupName}</div>
                  <div class="sub">от ${fromName} • ${escapeHtml(roleLabel)}</div>
                </div>
                <div class="actions">
                  <button class="btn btn-primary" onclick="acceptGroupInvite(${r.id})">Принять</button>
                  <button class="btn" onclick="declineGroupInvite(${r.id})">Отклонить</button>
                </div>
              </div>
            `;
          }).join("");
        }
      }
    }

    // Загружаем уведомления
    await loadNotifications();

    // обновим счетчик (на случай если приняли с другого устройства)
    await refreshUserSnapshot();
    updateNotifBadge();
    refreshFriendsUI();
  } catch (e) {
    console.error(e);
    inbox.innerHTML = `<div class="hint">Ошибка сети.</div>`;
    outbox.innerHTML = `<div class="hint">Ошибка сети.</div>`;
    if (giBox) giBox.innerHTML = `<div class="hint">Ошибка сети.</div>`;
  }
}

async function acceptFriendRequest(requestId) {
  try {
    const resp = await apiFetch(`/v1/friends/requests/${requestId}/accept`, { method: "POST" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert("Не удалось принять: " + (data.detail || resp.status));
      return;
    }
    await refreshUserSnapshot();
    await loadFriendRequestsLists();
    refresh(); // чтобы новые точки от друзей (в будущем) могли появиться; сейчас просто безопасно
  } catch (e) {
    console.error(e);
    alert("Ошибка сети.");
  }
}

async function declineFriendRequest(requestId) {
  try {
    const resp = await apiFetch(`/v1/friends/requests/${requestId}/decline`, { method: "POST" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert("Не удалось отклонить: " + (data.detail || resp.status));
      return;
    }
    await refreshUserSnapshot();
    await loadFriendRequestsLists();
  } catch (e) {
    console.error(e);
    alert("Ошибка сети.");
  }
}

async function acceptGroupInvite(inviteId) {
  try {
    const resp = await apiFetch(`/v1/groups/invites/${inviteId}/accept`, { method: "POST" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert("Не удалось принять: " + (data.detail || resp.status));
      return;
    }
    await refreshUserSnapshot();
    renderGroupLayersUI();
    populateAddGroupSelect();
    await loadFriendRequestsLists();
    refresh();
  } catch (e) {
    console.error(e);
    alert("Ошибка сети.");
  }
}

async function declineGroupInvite(inviteId) {
  try {
    const resp = await apiFetch(`/v1/groups/invites/${inviteId}/decline`, { method: "POST" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert("Не удалось отклонить: " + (data.detail || resp.status));
      return;
    }
    await refreshUserSnapshot();
    await loadFriendRequestsLists();
  } catch (e) {
    console.error(e);
    alert("Ошибка сети.");
  }
}

// Лёгкое обновление currentUser (без трогания панелей модерации/админки)
async function refreshUserSnapshot() {
  if (!accessToken) return;
  const resp = await apiFetch("/v1/me");
  if (!resp.ok) return;
  currentUser = await resp.json().catch(() => currentUser);
}

// маленький HTML-эскейпер для вывода в innerHTML
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


async function addWebPoint() {
const statusEl = document.getElementById("web-add-status");

if (!tempCoords) {
    if (statusEl) {
    statusEl.innerText = "Сначала выберите точку: нажмите правой кнопкой мыши по карте.";
    statusEl.style.color = "#52525b";
    statusEl.style.fontWeight = "400";
    }
    return;
}

if (!accessToken) {
  statusEl.innerText = "Нужно войти.";
  return;
}

const titleInput = document.getElementById("web-title");
const noteInput = document.getElementById("web-note");
const photosInput = document.getElementById("web-photos");

const titleRaw = titleInput ? titleInput.value : "";
const note = noteInput ? noteInput.value.trim() : "";
const files = photosInput && photosInput.files ? Array.from(photosInput.files) : [];

let titleFinal = (titleRaw || "").trim();
if (!titleFinal) {
  titleFinal = `${tempCoords.lat.toFixed(5)}, ${tempCoords.lng.toFixed(5)}`;
}

if (files.length > 12) {
    if (statusEl) {
    statusEl.innerText = "Можно добавить не более 12 фотографий.";
    statusEl.style.color = "#b91c1c";
    statusEl.style.fontWeight = "600";
    }
    return;
}

let mediaKeys = [];
if (files.length > 0) {
    try {
    if (statusEl) {
        statusEl.innerText = "Загрузка фотографий...";
        statusEl.style.color = "#52525b";
        statusEl.style.fontWeight = "400";
    }
    mediaKeys = await uploadPhotos(files);
    } catch (e) {
    console.error(e);
    if (statusEl) {
        statusEl.innerText = "Ошибка при загрузке фотографий.";
        statusEl.style.color = "#b91c1c";
        statusEl.style.fontWeight = "600";
    }
    return;
    }
}

const groupSelect = document.getElementById("web-group");
const chosenGroupId = groupSelect ? Number(groupSelect.value || 1) : 1;

const body = {
  group_id: chosenGroupId,
  title: titleFinal,
  note: note,
  lat: tempCoords.lat,
  lon: tempCoords.lng,
  media_keys: mediaKeys,
};

try {
    const resp = await apiFetch("/v1/places", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
    if (statusEl) {
        statusEl.innerText = "Не удалось добавить точку (код " + resp.status + ").";
        statusEl.style.color = "#b91c1c";
        statusEl.style.fontWeight = "600";
    }
    return;
    }

    // успех
    if (statusEl) {
    statusEl.innerText = "Точка добавлена.";
    statusEl.style.color = "#16a34a";
    statusEl.style.fontWeight = "600";
    }

    // очищаем форму и временный пин
    if (titleInput) titleInput.value = "";
    if (noteInput) noteInput.value = "";
    if (photosInput) photosInput.value = "";
    const coordsEl = document.getElementById("web-coords");
    if (coordsEl) {
    coordsEl.textContent = "ПКМ по карте, чтобы выбрать точку.";
    }

    if (tempMarker) {
    tempMarker.remove();
    tempMarker = null;
    }
    tempCoords = null;

    // обновляем маркеры
    refresh();
} catch (err) {
    console.error(err);
    if (statusEl) {
    statusEl.innerText = "Ошибка соединения с API при добавлении точки.";
    }
}
}

async function uploadPhotos(files) {
const mediaKeys = [];

for (const file of files) {
    const ext = file.name.includes(".")
    ? file.name.split(".").pop()
    : "";
    const mime = file.type || "image/jpeg";

    // просим пресайн для загрузки
    const presignResp = await apiFetch("/v1/media/presign-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mime, ext }),
    });
    if (!presignResp.ok) {
    throw new Error("presign-upload failed: " + presignResp.status);
    }
    const u = await presignResp.json(); // { key, url, expires_in }

    // заливаем файл в MinIO
    const putResp = await fetch(u.url, {
      method: "PUT",
      headers: { "Content-Type": mime },
      body: file,
    });
    if (!putResp.ok) {
    throw new Error("PUT to S3 failed: " + putResp.status);
    }

    mediaKeys.push(u.key);
}

return mediaKeys;
}

function fakeLogout() {
currentUserId = null;
localStorage.removeItem(LS_KEY);
document.getElementById("user-id-input").value = "";
document.getElementById("user-info").innerText =
    "Не авторизованы";
refresh();
}

function onLayerChange() {
refresh();
}

const map = new maplibregl.Map({
container: "map",
style: {
    version: 8,
    sources: {
    "osm-tiles": {
        type: "raster",
        tiles: [
        "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png"
        ],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors"
    }
    },
    layers: [
    {
        id: "osm-tiles",
        type: "raster",
        source: "osm-tiles",
        minzoom: 0,
        maxzoom: 19
    }
    ]
},
center: [37.6176, 55.7558],
zoom: 10
});

map.addControl(new maplibregl.NavigationControl(), "top-right");

map.on("contextmenu", (e) => {
  if (e.originalEvent && e.originalEvent.preventDefault) {
    e.originalEvent.preventDefault();
  }

  // запрет до входа
  if (!currentUser) {
    const statusEl = document.getElementById("web-add-status");
    if (statusEl) statusEl.innerText = "Сначала войдите, чтобы добавлять точки.";
    return;
  }

  setTempMarker(e.lngLat);
});

function clearMarkers() {
currentMarkers.forEach(m => m.remove());
currentMarkers = [];
markersByPlaceId = {};
}

function updateCounter(n) {
document.getElementById("points-counter").innerText = "Точек: " + n;
}

function setStatus(text, isError) {
const el = document.getElementById("status-text");
el.innerText = text;
el.style.color = isError ? "#dc2626" : "#16a34a";
}

function setTempMarker(lngLat) {
tempCoords = { lng: lngLat.lng, lat: lngLat.lat };

// обновляем текст с координатами
const coordsEl = document.getElementById("web-coords");
if (coordsEl) {
    coordsEl.textContent =
    tempCoords.lat.toFixed(5) + ", " + tempCoords.lng.toFixed(5);
}

// убираем старый временный маркер, если был
if (tempMarker) {
    tempMarker.remove();
    tempMarker = null;
}

// желтый пин
const el = createPin(false, "#facc15");

tempMarker = new maplibregl.Marker({ element: el, anchor: "bottom" })
    .setLngLat([tempCoords.lng, tempCoords.lat])
    .addTo(map);

const status = document.getElementById("web-add-status");
if (status) {
  status.innerText = "Временная точка выбрана.";
  status.style.color = "#52525b";
  status.style.fontWeight = "400";
}
}

async function refresh() {
  const showPublic = document.getElementById("layer-public").checked;
  const showMy = document.getElementById("layer-my").checked;

  const extraSelected = Array.from(selectedGroupLayerIds);

  if (!showPublic && !showMy && extraSelected.length === 0 && !pendingPopupGroupId) {
    clearMarkers();
    updateCounter(0);
    return;
  }

  const bounds = map.getBounds();
  const bbox = [
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth()
  ].join(",");

  let allItems = [];
  try {
    const gids = [];
    if (showPublic || showMy) gids.push(1);
    for (const gid of extraSelected) gids.push(gid);
    // Гарантируем включение группы точки из панели модерации
    if (pendingPopupGroupId && !gids.includes(pendingPopupGroupId)) {
      gids.push(pendingPopupGroupId);
    }

    const q = `/v1/places/feed?bbox=${encodeURIComponent(bbox)}&scope=all&group_ids=${encodeURIComponent(gids.join(","))}`;
    const r = await apiFetch(q);
    if (!r.ok) {
      console.error("Bad status:", r.status);
      setStatus("Ошибка API: " + r.status, true);
      return;
    }
    const d = await r.json().catch(() => ({}));
    allItems = d.items || [];
  } catch (e) {
    console.error(e);
    setStatus("Ошибка соединения с API", true);
    return;
  }

  const myUserId = currentUser?.id != null ? String(currentUser.id) : null;
  const filtered = [];

  for (const p of allItems) {
      const ownerUserId = p.user_id != null ? String(p.user_id) : null;
      const isMine = myUserId && ownerUserId && ownerUserId === myUserId;

      // Точка из панели модерации — всегда показываем
      if (pendingPopupPlaceId !== null && p.id === pendingPopupPlaceId) {
        filtered.push({ ...p, isMine });
        continue;
      }

      // For public group (group_id=1), apply public/my filters.
      if (p.group_id === 1 || p.group_id === "1") {
        if (showPublic && showMy) {
          filtered.push({ ...p, isMine });
        } else if (showMy && !showPublic) {
          if (isMine) filtered.push({ ...p, isMine: true });
        } else if (showPublic && !showMy) {
          filtered.push({ ...p, isMine });
        }
      } else {
        // For private/group layers: show all points from selected layers
        filtered.push({ ...p, isMine });
      }
  }

  clearMarkers();

  filtered.forEach(p => {
      // серый пин для точек на модерации, зелёный для своих, синий для чужих
      const isPending = p.moderation_status === "pending";
      const pinColor = isPending ? "#9ca3af" : undefined;
      const el = createPin(p.isMine, pinColor);

      const who = p.isMine
          ? "Моя точка"
          : (p.user_login ? p.user_login : (p.username ? ("@" + p.username) : "Аноним"));

      const displayTitle =
      p.title && p.title.trim()
          ? p.title
          : `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;

      // плашка «На модерации» / «Поступила жалоба» для pending-точек
      let pendingBadge = "";
      if (isPending) {
        if (p.isMine && p.has_report) {
          pendingBadge = `<div class="mm-report-badge mm-report-badge--reported">Поступила жалоба</div>`;
        } else {
          pendingBadge = `<div class="mm-report-badge mm-report-badge--pending">На модерации</div>`;
        }
      }

      // Кнопка «⋯» → «Пожаловаться» на чужих approved-точках
      const canReport = !p.isMine && !isPending && currentUser;
      const reportMenuHtml = canReport
        ? `<div class="mm-popup-menu">
            <button class="mm-popup-menu-btn" onclick="var dd=this.nextElementSibling;dd.style.display=dd.style.display==='block'?'none':'block';event.stopPropagation();">⋯</button>
            <div class="mm-popup-dropdown" style="display:none">
              <button class="mm-popup-dropdown-item" onclick="openReportModal(${p.id})">Пожаловаться</button>
            </div>
          </div>`
        : "";

      // кнопки модерации в попапе (только для pending-точек, видны admin/moderator)
      const moderationBtns = isPending && currentUser && (currentUser.role === "admin" || currentUser.role === "moderator")
        ? `<div style="margin-top:6px;display:flex;gap:6px;">
            <button onclick="moderatePlace(${p.id},'approved')" style="font-size:12px;padding:4px 10px;border-radius:9999px;border:1px solid #16a34a;background:#dcfce7;color:#15803d;cursor:pointer;">Одобрить</button>
            <button onclick="moderatePlace(${p.id},'rejected')" style="font-size:12px;padding:4px 10px;border-radius:9999px;border:1px solid #dc2626;background:#fee2e2;color:#b91c1c;cursor:pointer;">Отклонить</button>
          </div>`
        : "";

      let deleteButtonHtml = "";
      if (p.isMine) {
      deleteButtonHtml = `<br><button class="mm-delete-btn" data-id="${p.id}" style="margin-top:4px;font-size:12px;padding:4px 8px;border-radius:9999px;border:1px solid #dc2626;background:#fee2e2;color:#b91c1c;cursor:pointer;">
          Удалить точку
      </button>`;
      }

      let photosHtml = "";
      if (p.media && p.media.length) {
      const thumbs = p.media.slice(0, 12).map(m => {
        const safeUrl = m.url;
        const del = p.isMine
          ? `<button class="mm-del-media-btn" data-media-id="${m.id}" title="Удалить"
              style="position:absolute;top:2px;right:2px;border:none;background:rgba(0,0,0,0.55);color:#fff;border-radius:9999px;width:18px;height:18px;cursor:pointer;">
              ×
            </button>`
          : "";

        return `
          <div style="position:relative;width:60px;height:60px;">
            <img src="${safeUrl}" data-full="${safeUrl}" class="mm-photo-thumb"
                style="width:60px;height:60px;object-fit:cover;border-radius:6px;cursor:pointer;" />
            ${del}
          </div>
        `;
      }).join("");

      photosHtml = `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;">${thumbs}</div>`;
      }

      const initialTitle = (p.title || "").trim()
        ? p.title
        : `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;

      const initialNote = p.note || "";

      // экранируем кавычки
      const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

      const titleBlock = p.isMine
        ? `<div class="mm-edit-row">
            <div class="mm-popup-title">${esc(initialTitle)}</div>
            <button class="mm-edit-btn" data-id="${p.id}" data-field="title" data-initial="${esc(initialTitle)}" title="Редактировать">✎</button>
          </div>`
        : `<div class="mm-popup-title">${esc(initialTitle)}</div>`;

      const noteBlock = p.isMine
        ? `<div class="mm-edit-row">
            <div class="mm-popup-note">${esc(initialNote)}</div>
            <button class="mm-edit-btn" data-id="${p.id}" data-field="note" data-initial="${esc(initialNote)}" title="Редактировать">✎</button>
          </div>`
        : `<div class="mm-popup-note">${esc(initialNote)}</div>`;

      const limit = 12;
      const have = (p.media || []).length;
      const canAdd = p.isMine && have < limit;
      const addBtnHtml = canAdd
        ? `<div style="margin-top:6px;">
            <button class="btn mm-add-photo-btn" data-id="${p.id}" data-have="${have}">
              Добавить фото
            </button>
          </div>`
        : "";

      // Кнопка «Комментарии (N)» — для не-личных точек
      const commentsCount = p.comments_count || 0;
      const showComments = !p.group_is_personal;
      const commentsBtnHtml = showComments
        ? `<button class="mm-comments-btn" onclick="openCommentsModal(${p.id}, ${p.user_id || 'null'})">Комментарии (${commentsCount})</button>`
        : "";

      const popupHtml = `
        <div class="mm-popup">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:4px;">
            <div style="flex:1;min-width:0;">${titleBlock}</div>
            ${reportMenuHtml}
          </div>
          ${noteBlock}
          <div style="margin-top:6px;font-size:11px;color:#6b7280;">${who}</div>
          ${pendingBadge}
          ${moderationBtns}
          ${addBtnHtml}
          ${photosHtml}
          ${commentsBtnHtml}
          ${deleteButtonHtml}
        </div>
      `;

      const marker = new maplibregl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([p.lon, p.lat])
      .setPopup(new maplibregl.Popup().setHTML(popupHtml))
      .addTo(map);

      currentMarkers.push(marker);
      markersByPlaceId[p.id] = marker;
  });

  // Открываем попап, если был запрос через "Показать на карте"
  if (pendingPopupPlaceId !== null) {
    const marker = markersByPlaceId[pendingPopupPlaceId];
    if (marker) {
      marker.togglePopup();
      // Автооткрытие комментариев из уведомления
      if (pendingCommentId !== null) {
        const pId = pendingPopupPlaceId;
        const place = filtered.find(p => p.id === pId);
        const placeUserId = place ? (place.user_id || null) : null;
        const cId = pendingCommentId;
        pendingCommentId = null;
        // Небольшая задержка — попап должен появиться в DOM
        setTimeout(() => openCommentsModal(pId, placeUserId, cId), 100);
      }
    }
    pendingPopupPlaceId = null;
    pendingPopupGroupId = null;
  }

  updateCounter(filtered.length);
  setStatus("Подключено к API", false);
}

document.addEventListener("click", async (e) => {
  const btn = e.target;
  if (!btn.classList.contains("mm-delete-btn")) return;

  e.preventDefault();
  e.stopPropagation();

  const id = btn.getAttribute("data-id");
  if (!id) return;

  // подтверждение
  const confirmDelete = confirm("Удалить эту точку?");
  if (!confirmDelete) return;

  if (!accessToken) {
      alert("Нужно авторизоваться, чтобы удалять точки.");
      return;
  }

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "Удаление...";

  try {
      const resp = await apiFetch(`/v1/places/${id}`, { method: "DELETE" });

      if (!resp.ok) {
      console.error("Delete failed", resp.status);
      alert("Не удалось удалить точку (код " + resp.status + ").");
      btn.disabled = false;
      btn.textContent = originalText;
      return;
      }

      // обновляем карту
      refresh();
  } catch (err) {
      console.error(err);
      alert("Ошибка соединения при удалении точки.");
      btn.disabled = false;
      btn.textContent = originalText;
  }
});

document.addEventListener("click", async (e) => {
  const btn = e.target;
  if (!btn.classList || !btn.classList.contains("mm-edit-btn")) return;

  e.preventDefault();
  e.stopPropagation();

  const id = btn.getAttribute("data-id");
  const field = btn.getAttribute("data-field");
  const initial = btn.getAttribute("data-initial") || "";
  if (!id || !field) return;

  if (!accessToken) { alert("Нужно войти."); return; }

  const next = await mmOpenModal({
    title: field === "title" ? "Редактировать название" : "Редактировать заметку",
    mode: field,
    initial,
  });

  if (next === null) return;

  const payload = {};
  payload[field] = next;

  const resp = await apiFetch(`/v1/places/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) { alert("Не удалось сохранить (код " + resp.status + ")"); return; }

  refresh();
});

// ========= Фото: открытие модалки =========
document.addEventListener("click", (e) => {
  const img = e.target.closest(".mm-photo-thumb");
  if (!img) return;

  e.preventDefault();
  e.stopPropagation();

  const url = img.getAttribute("data-full") || img.src;

  let modal = document.getElementById("mm-photo-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "mm-photo-modal";
    modal.className = "mm-photo-modal";
    modal.addEventListener("click", () => modal.remove());

    const bigImg = document.createElement("img");
    modal.appendChild(bigImg);

    document.body.appendChild(modal);
  }

  const bigImg = modal.querySelector("img");
  bigImg.src = url;
});

// ========= Фото: добавить/удалить =========
let _mmUploadPlaceId = null;

document.addEventListener("click", async (e) => {
  // удалить фото (крестик)
  const delMediaBtn = e.target.closest(".mm-del-media-btn");
  if (delMediaBtn) {
    e.preventDefault();
    e.stopPropagation();

    const mediaId = delMediaBtn.getAttribute("data-media-id");
    if (!mediaId) return;

    if (!accessToken) { alert("Нужно войти."); return; }
    if (!confirm("Удалить фото?")) return;

    const resp = await apiFetch(`/v1/media/${mediaId}`, { method: "DELETE" });
    if (!resp.ok) { alert("Не удалось удалить фото (код " + resp.status + ")"); return; }

    refresh();
    return;
  }

  // добавить фото
  const addPhotoBtn = e.target.closest(".mm-add-photo-btn");
  if (addPhotoBtn) {
    e.preventDefault();
    e.stopPropagation();

    if (!accessToken) { alert("Нужно войти."); return; }

    const placeId = addPhotoBtn.getAttribute("data-id");
    const have = Number(addPhotoBtn.getAttribute("data-have") || "0");
    const remaining = 12 - have;

    if (!placeId) return;
    if (remaining <= 0) { alert("Лимит фото достигнут."); return; }

    _mmUploadPlaceId = placeId;

    const inp = document.getElementById("mm-photo-input");
    inp.value = "";
    inp.setAttribute("data-remaining", String(remaining));
    inp.click();
    return;
  }
});

document.getElementById("mm-photo-input").addEventListener("change", async (e) => {
  const inp = e.target;
  const files = inp.files ? Array.from(inp.files) : [];
  if (!files.length) return;

  const remaining = Number(inp.getAttribute("data-remaining") || "0");
  const placeId = _mmUploadPlaceId;
  if (!placeId) return;

  if (files.length > remaining) {
    alert(`Можно добавить только ${remaining} фото(шт).`);
    return;
  }

  try {
    for (const file of files) {
      const ext = file.name.includes(".") ? file.name.split(".").pop() : "";
      const mime = file.type || "image/jpeg";

      const presignResp = await apiFetch("/v1/media/presign-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mime, ext, place_id: Number(placeId) }),
      });
      if (!presignResp.ok) throw new Error("presign " + presignResp.status);
      const u = await presignResp.json();

      const putResp = await fetch(u.url, {
        method: "PUT",
        headers: { "Content-Type": mime },
        body: file,
      });
      if (!putResp.ok) throw new Error("put " + putResp.status);

      const linkResp = await apiFetch(`/v1/places/${placeId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ temp_key: u.key }),
      });
      if (!linkResp.ok) throw new Error("link " + linkResp.status);
    }

    refresh();
  } catch (err) {
    console.error(err);
    alert("Ошибка при добавлении фото.");
  } finally {
    _mmUploadPlaceId = null;
  }
});

// ========= Модерация (admin / moderator) =========

async function loadModerationQueue() {
  const list = document.getElementById("moderation-list");
  if (!list) return;

  list.innerHTML = "<div class='hint'>Загрузка...</div>";

  try {
    const resp = await apiFetch("/v1/moderation/places?status=pending");
    if (!resp.ok) {
      list.innerHTML = "<div class='hint'>Ошибка загрузки.</div>";
      return;
    }

    const data = await resp.json();
    const items = data.items || [];

    if (!items.length) {
      list.innerHTML = "<div class='hint'>Нет точек на модерации.</div>";
      return;
    }

    list.innerHTML = items.map(p => {
      const title = (p.title || "").trim() || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
      const author = p.user_login || p.username || "Аноним";
      const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

      // Обрезаем описание до 100 символов для превью
      const notePreview = p.note && p.note.length > 100
        ? p.note.slice(0, 100) + "..."
        : p.note || "";

      // Превью фотографий (до 3 шт.)
      const photos = (p.media || []).map(m =>
        `<img src="${esc(m.url)}" alt="фото"
          style="width:60px;height:60px;object-fit:cover;border-radius:4px;cursor:pointer;"
          onclick="window.open('${esc(m.url)}','_blank')" />`
      ).join("");
      const photosHtml = photos
        ? `<div style="display:flex;gap:4px;margin-top:4px;">${photos}</div>`
        : "";

      // Жалобы на эту точку
      const reports = Array.isArray(p.reports) ? p.reports : [];
      const reportsHtml = reports.map(r => {
        const who = r.user_login || r.username || `user#${r.user_id}`;
        const cat = esc(r.category_label || r.category);
        const comm = r.comment ? ": " + esc(r.comment) : "";
        return `<div class="mm-report-line">Жалоба от @${esc(who)}: ${cat}${comm}</div>`;
      }).join("");

      return `
        <div style="padding:8px 0;border-bottom:1px solid #e5e7eb;">
          <div style="font-weight:500;">${esc(title)}</div>
          <div style="font-size:12px;color:#6b7280;">${esc(author)} · ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</div>
          ${notePreview ? `<div style="font-size:12px;margin-top:2px;">${esc(notePreview)}</div>` : ""}
          ${reportsHtml}
          ${photosHtml}
          <div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap;">
            <button class="btn" style="font-size:12px;padding:2px 10px;"
              onclick="showPlaceOnMap(${p.id},${p.lon},${p.lat},${p.group_id})">Показать на карте</button>
            <button class="btn btn-primary" style="font-size:12px;padding:2px 10px;"
              onclick="moderatePlace(${p.id},'approved')">Одобрить</button>
            <button class="btn" style="font-size:12px;padding:2px 10px;border-color:#dc2626;color:#b91c1c;"
              onclick="moderatePlace(${p.id},'rejected')">Отклонить</button>
          </div>
        </div>
      `;
    }).join("");

  } catch (e) {
    console.error(e);
    list.innerHTML = "<div class='hint'>Ошибка сети.</div>";
  }
}

/** Перелететь к точке на карте и открыть её попап */
function showPlaceOnMap(placeId, lon, lat, groupId) {
  // закрываем любые открытые попапы
  currentMarkers.forEach(m => {
    const popup = m.getPopup();
    if (popup && popup.isOpen()) {
      popup.remove();
    }
  });

  // сохраняем id для открытия попапа после refresh (который вызовется при moveend)
  pendingPopupPlaceId = placeId;
  pendingPopupGroupId = groupId || null;
  map.flyTo({ center: [lon, lat], zoom: 16 });
}

async function moderatePlace(placeId, status) {
  try {
    const resp = await apiFetch(`/v1/moderation/places/${placeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!resp.ok) {
      alert("Ошибка модерации (код " + resp.status + ").");
      return;
    }
    // обновляем очередь и карту
    loadModerationQueue();
    refresh();
  } catch (e) {
    console.error(e);
    alert("Ошибка сети при модерации.");
  }
}

// ===================== Комментарии к точкам =====================

let _commentsPlaceId = null;
let _commentsPlaceUserId = null;
let _replyToParentId = null;
let _commentSubmitting = false;

/** Русская плюрализация: pluralRu(5, "ответ", "ответа", "ответов") → "ответов" */
function pluralRu(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (d === 1) return one;
  if (d >= 2 && d <= 4) return few;
  return many;
}

/**
 * Вычисляет относительное время: «только что», «5 мин назад», «вчера» и т.д.
 */
function timeAgo(isoStr) {
  if (!isoStr) return "";
  const date = new Date(isoStr);
  const now = new Date();
  const diff = Math.floor((now - date) / 1000);

  if (diff < 60) return "только что";
  if (diff < 3600) { const m = Math.floor(diff / 60); return m + " " + pluralRu(m, "минуту", "минуты", "минут") + " назад"; }
  if (diff < 86400) { const h = Math.floor(diff / 3600); return h + " " + pluralRu(h, "час", "часа", "часов") + " назад"; }
  if (diff < 172800) return "вчера";
  if (diff < 2592000) { const d = Math.floor(diff / 86400); return d + " " + pluralRu(d, "день", "дня", "дней") + " назад"; }
  return date.toLocaleDateString("ru-RU");
}

function formatFullDate(isoStr) {
  if (!isoStr) return "";
  return new Date(isoStr).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

async function openCommentsModal(placeId, placeUserId, scrollToCommentId) {
  _commentsPlaceId = placeId;
  _commentsPlaceUserId = placeUserId;
  _replyToParentId = null;

  // Сбрасываем reply indicator
  const ind = document.getElementById("comment-reply-indicator");
  if (ind) ind.style.display = "none";

  const overlay = document.getElementById("comments-overlay");
  if (!overlay) return;
  overlay.style.display = "flex";

  // Показываем форму ввода только авторизованным
  const form = document.getElementById("comments-form");
  if (form) form.style.display = accessToken ? "" : "none";

  const input = document.getElementById("comment-input");
  if (input) input.value = "";
  const status = document.getElementById("comment-status");
  if (status) status.innerText = "";

  await loadComments(placeId, scrollToCommentId, !!scrollToCommentId);
}

async function loadComments(placeId, scrollToCommentId, highlightComment) {
  const list = document.getElementById("comments-list");
  if (!list) return;

  // Запоминаем состояние ДО перерисовки
  const expandedIds = [...list.querySelectorAll(".comment-replies-container")]
    .filter(el => el.style.display !== "none")
    .map(el => el.id);
  const expandedTextIds = [...list.querySelectorAll(".comment-text-full")]
    .filter(el => el.style.display !== "none")
    .map(el => el.parentElement.id);
  const prevScrollTop = list.scrollTop;
  const hadContent = list.children.length > 0 && !list.querySelector(".hint");

  // «Загрузка...» показываем только при первом открытии
  if (!hadContent) {
    list.innerHTML = "<div class='hint'>Загрузка...</div>";
  }

  try {
    const resp = await apiFetch(`/v1/places/${placeId}/comments`);
    if (!resp.ok) {
      list.innerHTML = "<div class='hint'>Ошибка загрузки комментариев.</div>";
      return;
    }
    const data = await resp.json();
    const comments = data.comments || [];

    if (!comments.length) {
      list.innerHTML = "<div class='hint'>Пока нет комментариев.</div>";
      return;
    }

    const myId = currentUser?.id;
    const isAdmin = currentUser && (currentUser.role === "admin" || currentUser.role === "moderator");
    const isPlaceOwner = myId && _commentsPlaceUserId && String(_commentsPlaceUserId) === String(myId);
    const isAuthed = !!currentUser;

    const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

    // Разделяем на top-level и ответы
    const topLevel = [];
    const repliesMap = {}; // parent_id -> [comment, ...]
    for (const c of comments) {
      if (c.parent_id) {
        if (!repliesMap[c.parent_id]) repliesMap[c.parent_id] = [];
        repliesMap[c.parent_id].push(c);
      } else {
        topLevel.push(c);
      }
    }

    /** Рендер одного комментария */
    function renderComment(c, isReply) {
      const authorName = c.user_login || (c.username ? "@" + c.username : "Аноним");
      const isCommentAuthor = myId && String(c.user_id) === String(myId);
      const editTimeOk = c.created_at && (Date.now() - new Date(c.created_at).getTime()) < 3600000;
      const canEdit = isCommentAuthor && editTimeOk;
      const canReply = isAuthed;
      const canDelete = isCommentAuthor || isPlaceOwner || isAdmin;

      // Пункты меню ⋯
      const menuItems = [];
      if (canEdit) menuItems.push(`<button class="mm-popup-dropdown-item mm-popup-dropdown-item--default" onclick="startEditComment(${c.id})">Редактировать</button>`);
      if (canDelete) menuItems.push(`<button class="mm-popup-dropdown-item" onclick="deleteComment(${c.id})">Удалить</button>`);

      const menuHtml = menuItems.length > 0
        ? `<div class="mm-popup-menu">
            <button class="mm-popup-menu-btn" onclick="toggleCommentMenu(this, event)" title="Действия">⋯</button>
            <div class="mm-popup-dropdown">${menuItems.join("")}</div>
          </div>`
        : "";

      // «(изменено)» если updated_at не null
      const editedBadge = c.updated_at ? `<span class="comment-edited">(изменено)</span>` : "";

      // Метка ответа (кликабельная — прокрутит к родительскому комментарию)
      const replyToTarget = c.reply_to_id || c.parent_id;
      const replyTag = isReply && c.parent_author
        ? `<div class="comment-reply-to" data-target-id="${replyToTarget}" title="Перейти к комментарию">↩ ${esc(c.parent_author)}</div>`
        : "";

      // Кнопка «Ответить» под текстом (только для авторизованных)
      const replyBtnHtml = canReply
        ? `<button class="comment-reply-btn" data-comment-id="${c.id}" data-author="${esc(authorName)}">Ответить</button>`
        : "";

      const itemClass = isReply ? "comment-item comment-item--reply" : "comment-item";

      return `
        <div class="${itemClass}" id="comment-${c.id}">
          <div class="comment-header">
            <div>
              <span class="comment-author">${esc(authorName)}</span>
              <span class="comment-time" title="${esc(formatFullDate(c.created_at))}">${timeAgo(c.created_at)}</span>
            </div>
          </div>
          ${replyTag}
          <div class="comment-text" id="comment-text-${c.id}">${c.text.length > 200
            ? `<span class="comment-text-short">${esc(c.text.slice(0, 200))}…</span><span class="comment-text-full" style="display:none">${esc(c.text)}${editedBadge}</span><br><button class="comment-toggle-text" onclick="toggleCommentText(this)">Показать полностью</button>`
            : `${esc(c.text)}${editedBadge}`}</div>
          <div class="comment-actions">
            ${replyBtnHtml}
            ${menuHtml}
          </div>
        </div>
      `;
    }

    // Рендер всех комментариев
    let html = "";
    for (const c of topLevel) {
      html += renderComment(c, false);
      const replies = repliesMap[c.id] || [];
      if (replies.length > 0) {
        // Toggle для ответов — свёрнуты по умолчанию
        html += `<button class="comment-replies-toggle" onclick="toggleReplies(${c.id})">Просмотреть ${replies.length} ${pluralRu(replies.length, "ответ", "ответа", "ответов")}</button>`;
        html += `<div class="comment-replies-container" id="replies-${c.id}" style="display:none;">`;
        for (const r of replies) {
          html += renderComment(r, true);
        }
        html += `</div>`;
      }
    }

    list.innerHTML = html;

    // Восстанавливаем раскрытые ответы
    expandedIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.style.display = "";
        const btn = el.previousElementSibling;
        if (btn && btn.classList.contains("comment-replies-toggle")) {
          btn.textContent = "Скрыть ответы";
        }
      }
    });

    // Восстанавливаем развёрнутые тексты комментариев
    expandedTextIds.forEach(id => {
      const textEl = document.getElementById(id);
      if (!textEl) return;
      const shortEl = textEl.querySelector(".comment-text-short");
      const fullEl = textEl.querySelector(".comment-text-full");
      const btn = textEl.querySelector(".comment-toggle-text");
      if (shortEl && fullEl) {
        shortEl.style.display = "none";
        fullEl.style.display = "";
        if (btn) btn.textContent = "Свернуть";
      }
    });

    // Скролл к конкретному комментарию (из уведомления)
    if (scrollToCommentId) {
      requestAnimationFrame(() => {
        const targetEl = document.getElementById(`comment-${scrollToCommentId}`);
        if (targetEl) {
          // Если комментарий — ответ, раскрываем контейнер ответов
          const repliesContainer = targetEl.closest(".comment-replies-container");
          if (repliesContainer && repliesContainer.style.display === "none") {
            repliesContainer.style.display = "";
            const toggleBtn = repliesContainer.previousElementSibling;
            if (toggleBtn && toggleBtn.classList.contains("comment-replies-toggle")) {
              toggleBtn.textContent = "Скрыть ответы";
            }
          }
          // Скроллим к комментарию, подсвечиваем только если указано (уведомления)
          targetEl.scrollIntoView({ block: "center" });
          if (highlightComment) {
            targetEl.classList.add("comment-highlight");
            setTimeout(() => targetEl.classList.remove("comment-highlight"), 2000);
          }
        } else {
          list.scrollTop = list.scrollHeight;
        }
      });
    } else if (!hadContent) {
      // Первое открытие — скролл вниз
      list.scrollTop = list.scrollHeight;
    } else {
      requestAnimationFrame(() => { list.scrollTop = prevScrollTop; });
    }
  } catch (e) {
    console.error(e);
    list.innerHTML = "<div class='hint'>Ошибка сети.</div>";
  }
}

/** Прокрутить к комментарию и подсветить (клик по «↩ @автор») */
let _highlightTimer = null;
function scrollToComment(commentId) {
  const targetEl = document.getElementById(`comment-${commentId}`);
  if (!targetEl) return;
  targetEl.scrollIntoView({ block: "center" });
  // Перезапуск анимации при повторном клике
  targetEl.classList.remove("comment-highlight");
  void targetEl.offsetWidth;
  targetEl.classList.add("comment-highlight");
  if (_highlightTimer) clearTimeout(_highlightTimer);
  _highlightTimer = setTimeout(() => targetEl.classList.remove("comment-highlight"), 2000);
}

/** Развернуть/свернуть длинный текст комментария */
function toggleCommentText(btn) {
  const container = btn.parentElement;
  const shortEl = container.querySelector(".comment-text-short");
  const fullEl = container.querySelector(".comment-text-full");
  if (!shortEl || !fullEl) return;

  if (fullEl.style.display === "none") {
    shortEl.style.display = "none";
    fullEl.style.display = "";
    btn.textContent = "Свернуть";
  } else {
    shortEl.style.display = "";
    fullEl.style.display = "none";
    btn.textContent = "Показать полностью";
  }
}

/** Переключить видимость ответов */
function toggleReplies(parentId) {
  const container = document.getElementById(`replies-${parentId}`);
  const btn = container?.previousElementSibling;
  if (!container) return;

  if (container.style.display === "none") {
    container.style.display = "";
    if (btn && btn.classList.contains("comment-replies-toggle")) {
      btn.textContent = "Скрыть ответы";
    }
  } else {
    container.style.display = "none";
    if (btn && btn.classList.contains("comment-replies-toggle")) {
      const count = container.querySelectorAll(".comment-item").length;
      btn.textContent = `Просмотреть ${count} ${pluralRu(count, "ответ", "ответа", "ответов")}`;
    }
  }
}

/** Открыть/закрыть выпадающее меню комментария */
function toggleCommentMenu(btn, event) {
  event.stopPropagation();
  const dd = btn.nextElementSibling;
  // Закрываем все открытые
  document.querySelectorAll(".comment-actions .mm-popup-dropdown.open").forEach(el => {
    if (el !== dd) el.classList.remove("open");
  });
  const isOpening = !dd.classList.contains("open");
  dd.classList.toggle("open");
  // Позиционируем fixed-dropdown относительно кнопки
  if (isOpening) {
    const rect = btn.getBoundingClientRect();
    dd.style.left = rect.left + "px";
    dd.style.top = (rect.bottom + 4) + "px";
    // Корректируем если выходит за правый край экрана
    requestAnimationFrame(() => {
      const ddRect = dd.getBoundingClientRect();
      if (ddRect.right > window.innerWidth) {
        dd.style.left = (window.innerWidth - ddRect.width - 8) + "px";
      }
      // Корректируем если выходит за нижний край
      if (ddRect.bottom > window.innerHeight) {
        dd.style.top = (rect.top - ddRect.height - 4) + "px";
      }
    });
  }
}

/** Начать inline-редактирование комментария */
function startEditComment(commentId) {
  // Закрываем меню
  document.querySelectorAll(".mm-popup-dropdown.open").forEach(el => el.classList.remove("open"));

  // Закрываем все предыдущие edit-области
  document.querySelectorAll("[id^='comment-edit-']").forEach(editDiv => {
    const prevId = editDiv.id.replace("comment-edit-", "");
    const prevText = document.getElementById(`comment-text-${prevId}`);
    if (prevText) prevText.style.display = "";
    const prevActions = editDiv.parentElement?.querySelector(".comment-actions");
    if (prevActions) prevActions.style.display = "";
    editDiv.remove();
  });

  const textEl = document.getElementById(`comment-text-${commentId}`);
  if (!textEl) return;

  // Извлекаем чистый текст (из полной версии, без badge «(изменено)»)
  const fullSpan = textEl.querySelector(".comment-text-full");
  let rawText;
  if (fullSpan) {
    // Длинный комментарий — берём текст из full-span, исключая badge
    rawText = [...fullSpan.childNodes]
      .filter(n => !(n.nodeType === 1 && n.classList?.contains("comment-edited")))
      .map(n => n.textContent).join("");
  } else {
    // Короткий комментарий — берём все textNode-ы, исключая badge
    rawText = [...textEl.childNodes]
      .filter(n => !(n.nodeType === 1 && n.classList?.contains("comment-edited")))
      .map(n => n.textContent).join("");
  }
  const currentText = rawText.trim();

  const parent = textEl.parentElement;
  // Скрываем текст и actions
  textEl.style.display = "none";
  const actionsEl = parent.querySelector(".comment-actions");
  if (actionsEl) actionsEl.style.display = "none";

  // Создаём textarea и кнопки
  const editDiv = document.createElement("div");
  editDiv.id = `comment-edit-${commentId}`;
  editDiv.innerHTML = `
    <textarea class="comment-edit-area" id="comment-edit-area-${commentId}">${escapeHtml(currentText)}</textarea>
    <div class="comment-edit-actions">
      <button class="btn" onclick="cancelEditComment(${commentId})">Отмена</button>
      <button class="btn btn-primary" onclick="saveEditComment(${commentId})">Сохранить</button>
    </div>
  `;
  textEl.insertAdjacentElement("afterend", editDiv);

  // Фокус на textarea
  const ta = document.getElementById(`comment-edit-area-${commentId}`);
  if (ta) {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
}

/** Сохранить отредактированный комментарий */
let _editSaving = false;
async function saveEditComment(commentId) {
  if (_editSaving) return;
  const ta = document.getElementById(`comment-edit-area-${commentId}`);
  if (!ta) return;
  const newText = (ta.value || "").trim();
  if (!newText) { alert("Текст не может быть пустым."); return; }

  _editSaving = true;
  try {
    const resp = await apiFetch(`/v1/comments/${commentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: newText }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const msg = data.detail === "edit_time_expired"
        ? "Время редактирования истекло (1 час)."
        : "Ошибка: " + (data.detail || resp.status);
      alert(msg);
      if (data.detail === "edit_time_expired" && _commentsPlaceId) await loadComments(_commentsPlaceId);
      return;
    }
    if (_commentsPlaceId) await loadComments(_commentsPlaceId);
  } catch (e) {
    console.error(e);
    alert("Ошибка сети.");
  } finally {
    _editSaving = false;
  }
}

/** Отменить редактирование */
function cancelEditComment(commentId) {
  // Локальное восстановление DOM без перезагрузки всех комментариев
  const editDiv = document.getElementById(`comment-edit-${commentId}`);
  if (editDiv) {
    const textEl = document.getElementById(`comment-text-${commentId}`);
    if (textEl) textEl.style.display = "";
    const actionsEl = editDiv.parentElement?.querySelector(".comment-actions");
    if (actionsEl) actionsEl.style.display = "";
    editDiv.remove();
  }
}

/** Начать ответ на комментарий */
function startReplyComment(commentId, authorName) {
  // Закрываем меню
  document.querySelectorAll(".mm-popup-dropdown.open").forEach(el => el.classList.remove("open"));

  _replyToParentId = commentId;

  // Показываем индикатор ответа
  const ind = document.getElementById("comment-reply-indicator");
  const indText = document.getElementById("comment-reply-indicator-text");
  if (ind) ind.style.display = "flex";
  if (indText) indText.textContent = `Ответ: @${authorName}`;

  // Фокус на инпут
  const input = document.getElementById("comment-input");
  if (input) input.focus();

  // Раскрываем ответы для видимости контекста
  const commentEl = document.getElementById(`comment-${commentId}`);
  const container = commentEl?.closest(".comment-replies-container")
    || document.getElementById(`replies-${commentId}`);
  if (container && container.style.display === "none") {
    // Извлекаем parentId из id контейнера (replies-{parentId})
    const parentId = container.id.replace("replies-", "");
    toggleReplies(+parentId);
  }
}

/** Отменить режим ответа */
function cancelReply() {
  _replyToParentId = null;
  const ind = document.getElementById("comment-reply-indicator");
  if (ind) ind.style.display = "none";
}

async function submitComment() {
  const placeId = _commentsPlaceId;
  if (!placeId) return;
  if (!accessToken) { alert("Нужно войти."); return; }
  if (_commentSubmitting) return;

  const input = document.getElementById("comment-input");
  const statusEl = document.getElementById("comment-status");
  const text = (input?.value || "").trim();

  if (!text) {
    if (statusEl) statusEl.innerText = "Введите текст комментария.";
    return;
  }

  _commentSubmitting = true;
  if (statusEl) statusEl.innerText = "Отправка...";

  const payload = { text };
  if (_replyToParentId) payload.parent_id = _replyToParentId;

  try {
    const resp = await apiFetch(`/v1/places/${placeId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const msg = data.detail || "Ошибка";
      const messages = {
        "empty_text": "Текст не может быть пустым.",
        "text_too_long": "Текст слишком длинный (макс. 1000 символов).",
        "place_not_found": "Точка не найдена.",
        "group_not_found": "Группа не найдена.",
        "personal_group": "Комментарии к личным точкам недоступны.",
        "no_access": "Нет доступа к этой группе.",
        "parent_not_found": "Родительский комментарий не найден.",
        "parent_wrong_place": "Родительский комментарий от другой точки.",
      };
      if (statusEl) statusEl.innerText = messages[msg] || `Ошибка: ${msg}`;
      return;
    }

    const result = await resp.json().catch(() => ({}));
    const newCommentId = result.comment?.id || null;

    if (input) input.value = "";
    if (statusEl) statusEl.innerText = "";

    // Сбрасываем режим ответа
    cancelReply();

    // Проверяем, что модалка не была закрыта пока ждали ответ
    if (_commentsPlaceId === placeId) {
      await loadComments(placeId, newCommentId);
      updateCommentsCountInPopup(placeId);
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.innerText = "Ошибка сети.";
  } finally {
    _commentSubmitting = false;
  }
}

let _commentDeleting = false;
async function deleteComment(commentId) {
  // Закрываем меню
  document.querySelectorAll(".mm-popup-dropdown.open").forEach(el => el.classList.remove("open"));

  if (_commentDeleting) return;
  if (!confirm("Удалить комментарий?")) return;

  _commentDeleting = true;
  const placeId = _commentsPlaceId;
  try {
    const resp = await apiFetch(`/v1/comments/${commentId}`, { method: "DELETE" });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      alert("Ошибка: " + (data.detail || resp.status));
      return;
    }
    if (placeId && _commentsPlaceId === placeId) {
      await loadComments(placeId);
      updateCommentsCountInPopup(placeId);
    }
  } catch (e) {
    console.error(e);
    alert("Ошибка сети.");
  } finally {
    _commentDeleting = false;
  }
}

/** Обновляет счётчик «Комментарии (N)» в открытом попапе без перерисовки маркеров. */
function updateCommentsCountInPopup(placeId) {
  const marker = markersByPlaceId[placeId];
  if (!marker) return;
  const popup = marker.getPopup();
  if (!popup) return;
  const el = popup.getElement();
  if (!el) return;
  const btn = el.querySelector(".mm-comments-btn");
  if (!btn) return;
  const list = document.getElementById("comments-list");
  const count = list ? list.querySelectorAll(".comment-item").length : 0;
  btn.textContent = `Комментарии (${count})`;
}

function closeCommentsModal() {
  _commentsPlaceId = null;
  _commentsPlaceUserId = null;
  _replyToParentId = null;
  const overlay = document.getElementById("comments-overlay");
  if (overlay) overlay.style.display = "none";
  // Скрываем индикатор ответа
  const ind = document.getElementById("comment-reply-indicator");
  if (ind) ind.style.display = "none";
}

function closeCommentsModalOnOverlay(e) {
  if (e.target === e.currentTarget) closeCommentsModal();
}

// ===================== Уведомления =====================

async function loadNotifications() {
  const listEl = document.getElementById("notifications-list");
  if (!listEl) return;

  if (!accessToken) {
    listEl.innerHTML = "";
    return;
  }

  listEl.innerHTML = "<div class='hint'>Загрузка...</div>";

  try {
    const resp = await apiFetch("/v1/notifications");
    if (!resp.ok) {
      listEl.innerHTML = "<div class='hint'>Ошибка загрузки уведомлений.</div>";
      return;
    }
    const data = await resp.json();
    const allItems = Array.isArray(data.items) ? data.items : [];
    // Показываем только непрочитанные
    const items = allItems.filter(n => !n.is_read);

    if (!items.length) {
      listEl.innerHTML = "<div class='hint'>Нет новых уведомлений.</div>";
      return;
    }

    const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    listEl.innerHTML = items.map(n => {
      const actor = n.actor_login || (n.actor_username ? "@" + n.actor_username : "Кто-то");
      const placeTitle = n.place_title || "точку";
      const typeText = n.type === "reply_to_comment"
        ? `<b>${esc(actor)}</b> — ответ на ваш комментарий к <b>"${esc(placeTitle)}"</b>`
        : `<b>${esc(actor)}</b> — новый комментарий к вашей точке <b>"${esc(placeTitle)}"</b>`;

      return `
        <div class="notif-item notif-item--unread" onclick="goToNotification(${n.place_id}, ${n.comment_id || "null"}, ${n.id}, ${n.place_group_id || "null"})">
          <div class="notif-text">${typeText}</div>
          <div class="notif-time">${timeAgo(n.created_at)}</div>
        </div>
      `;
    }).join("");
  } catch (e) {
    console.error(e);
    listEl.innerHTML = "<div class='hint'>Ошибка сети.</div>";
  }
}

async function markNotificationRead(notifId) {
  try {
    await apiFetch(`/v1/notifications/${notifId}/read`, { method: "PATCH" });
    await refreshUserSnapshot();
    updateNotifBadge();
  } catch (e) {
    console.error(e);
  }
}

async function markAllNotificationsRead() {
  if (!accessToken) return;
  try {
    await apiFetch("/v1/notifications/read-all", { method: "PATCH" });
    await refreshUserSnapshot();
    updateNotifBadge();
    await loadNotifications();
  } catch (e) {
    console.error(e);
    alert("Ошибка сети.");
  }
}

/** Перейти к точке из уведомления */
async function goToNotification(placeId, commentId, notifId, groupId) {
  // Помечаем прочитанным
  if (notifId) markNotificationRead(notifId);

  // Закрываем модалку уведомлений
  closeFriendRequestsModal();

  if (!placeId) {
    alert("Точка была удалена.");
    return;
  }

  // Перелетаем к точке
  // CASCADE: если точка удалена → уведомление тоже удалено из БД,
  // поэтому дополнительная проверка не нужна
  pendingPopupPlaceId = placeId;
  pendingPopupGroupId = groupId || null;
  pendingCommentId = commentId || null;

  // flyTo вызовет moveend → refresh() → pendingPopupPlaceId откроет попап + комментарии
  const marker = markersByPlaceId[placeId];
  if (marker) {
    const lngLat = marker.getLngLat();
    map.flyTo({ center: [lngLat.lng, lngLat.lat], zoom: Math.max(map.getZoom(), 14) });
    // Fallback: если карта уже на месте, flyTo не вызовет moveend
    setTimeout(() => {
      if (pendingPopupPlaceId !== null) refresh();
    }, 600);
  } else {
    // Маркер не найден — обновим карту вручную
    refresh();
  }
}

// ===================== Жалобы (постмодерация) =====================

let _reportPlaceId = null;

function openReportModal(placeId) {
  _reportPlaceId = placeId;
  const overlay = document.getElementById("report-overlay");
  if (!overlay) return;
  // сброс формы
  const radios = document.querySelectorAll('input[name="report-category"]');
  if (radios.length) radios[0].checked = true;
  const comment = document.getElementById("report-comment");
  if (comment) comment.value = "";
  const status = document.getElementById("report-status");
  if (status) status.innerText = "";
  onReportCategoryChange();
  overlay.style.display = "flex";
}

/** Обновляет подпись и обязательность поля комментария */
function onReportCategoryChange() {
  const selected = document.querySelector('input[name="report-category"]:checked');
  const isOther = selected && selected.value === "other";
  const label = document.getElementById("report-comment-label");
  if (label) label.textContent = isOther ? "Комментарий (обязательно)" : "Комментарий (необязательно)";
}

function closeReportModal() {
  _reportPlaceId = null;
  const overlay = document.getElementById("report-overlay");
  if (overlay) overlay.style.display = "none";
}

function closeReportModalOnOverlay(e) {
  if (e.target === e.currentTarget) closeReportModal();
}

async function submitReport() {
  if (!_reportPlaceId) return;
  if (!accessToken) { alert("Нужно войти."); return; }

  const statusEl = document.getElementById("report-status");
  const selected = document.querySelector('input[name="report-category"]:checked');
  const category = selected ? selected.value : "other";
  const comment = (document.getElementById("report-comment")?.value || "").trim() || null;

  // Для категории «Другое» комментарий обязателен
  if (category === "other" && !comment) {
    if (statusEl) statusEl.innerText = "Для категории «Другое» укажите комментарий.";
    return;
  }

  if (statusEl) statusEl.innerText = "Отправка...";

  try {
    const resp = await apiFetch(`/v1/places/${_reportPlaceId}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, comment }),
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const msg = data.detail || "Ошибка";
      const messages = {
        "place_not_found": "Точка не найдена.",
        "cannot_report_own_place": "Нельзя пожаловаться на свою точку.",
        "already_dismissed": "Вы уже жаловались ранее, жалоба была отклонена модератором.",
        "already_reported": "Вы уже отправили жалобу на эту точку.",
        "place_not_approved": "Жалоба уже отправлена, точка на модерации.",
        "invalid_category": "Некорректная категория.",
      };
      if (statusEl) statusEl.innerText = messages[msg] || `Ошибка: ${msg}`;
      return;
    }

    closeReportModal();
    refresh();
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.innerText = "Ошибка сети.";
  }
}

// Закрытие dropdown-меню по клику вне
document.addEventListener("click", (e) => {
  document.querySelectorAll(".mm-popup-dropdown").forEach(dd => {
    if (dd.style.display === "block" && !dd.parentElement.contains(e.target)) {
      dd.style.display = "none";
    }
  });
  // Закрываем comment-menu dropdown (используют класс open)
  document.querySelectorAll(".comment-actions .mm-popup-dropdown.open").forEach(dd => {
    if (!dd.parentElement.contains(e.target)) {
      dd.classList.remove("open");
    }
  });
});

// Закрываем comment-dropdown при скролле списка комментариев
document.getElementById("comments-list")?.addEventListener("scroll", () => {
  document.querySelectorAll(".comment-actions .mm-popup-dropdown.open").forEach(dd => {
    dd.classList.remove("open");
  });
});

// ===================== Панель администратора =====================

/** Кэш списка пользователей для клиентской фильтрации */
let _adminUsersList = [];

/** Загрузить список пользователей из API */
async function loadAdminUsers() {
  const list = document.getElementById("admin-users-list");
  if (!list) return;

  list.innerHTML = "<div class='hint'>Загрузка...</div>";

  try {
    const resp = await apiFetch("/v1/admin/users");
    if (!resp.ok) {
      list.innerHTML = "<div class='hint'>Ошибка загрузки.</div>";
      return;
    }
    const data = await resp.json();
    _adminUsersList = data.items || [];
    renderAdminUsers(_adminUsersList);
  } catch (e) {
    console.error(e);
    list.innerHTML = "<div class='hint'>Ошибка сети.</div>";
  }
}

/** Фильтр списка пользователей по поисковой строке */
function filterAdminUsers() {
  const q = (document.getElementById("admin-search")?.value || "").trim().toLowerCase();
  if (!q) {
    renderAdminUsers(_adminUsersList);
    return;
  }
  const filtered = _adminUsersList.filter(u =>
    (u.login || "").toLowerCase().includes(q) ||
    (u.email || "").toLowerCase().includes(q)
  );
  renderAdminUsers(filtered);
}

/** Отрисовать список пользователей */
function renderAdminUsers(users) {
  const list = document.getElementById("admin-users-list");
  if (!list) return;

  if (!users.length) {
    list.innerHTML = "<div class='hint'>Пользователи не найдены.</div>";
    return;
  }

  const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  // роли для select (admin не назначается через интерфейс)
  const roleLabels = { admin: "Админ", moderator: "Модератор", user: "Пользователь" };

  list.innerHTML = users.map(u => {
    const isSelf = currentUser && u.id === currentUser.id;
    const isAdmin = u.role === "admin";
    const disabled = isSelf || isAdmin ? "disabled" : "";

    const options = ["user", "moderator"].map(r =>
      `<option value="${r}" ${u.role === r ? "selected" : ""}>${esc(roleLabels[r])}</option>`
    ).join("");

    // для админа — текстовая метка, для остальных — select
    const roleHtml = isAdmin
      ? `<span style="font-size:12px;color:#4f46e5;font-weight:500;">Админ</span>`
      : `<select ${disabled} style="font-size:12px;padding:2px 6px;border-radius:6px;border:1px solid #d1d5db;width:100%;"
          onchange="changeUserRole(${u.id}, this.value)">${options}</select>`;

    return `
      <div style="padding:6px 0;border-bottom:1px solid #e5e7eb;">
        <div style="font-weight:500;font-size:13px;overflow:hidden;text-overflow:ellipsis;">${esc(u.login || "—")}</div>
        <div style="font-size:11px;color:#6b7280;overflow:hidden;text-overflow:ellipsis;">${esc(u.email || "нет email")}</div>
        <div style="margin-top:3px;">${roleHtml}</div>
      </div>
    `;
  }).join("");
}

/** Изменить роль пользователя */
async function changeUserRole(userId, newRole) {
  try {
    const resp = await apiFetch(`/v1/admin/users/${userId}/role`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      alert("Ошибка: " + (data.detail || resp.status));
      loadAdminUsers(); // откатываем select к реальному значению
      return;
    }
    // обновляем список
    loadAdminUsers();
  } catch (e) {
    console.error(e);
    alert("Ошибка сети.");
  }
}

initAuthFromStorage();

// периодически обновляем счетчик уведомлений и список друзей
setInterval(async () => {
  if (!accessToken) return;
  try {
    await refreshUserSnapshot();
    updateNotifBadge();
    refreshFriendsUI();
    renderGroupLayersUI();
    populateAddGroupSelect();
    await loadFriendRequestsListsSafe();
    maybeRefreshSearchResults();
  } catch (e) { /* ignore */ }
}, 8000);

function maybeRefreshSearchResults() {
  const qEl = document.getElementById("friends-search-input");
  const resEl = document.getElementById("friends-search-results");
  if (!qEl || !resEl) return;
  const q = (qEl.value || "").trim();
  if (!q) return;
  // Only refresh if the user has already run a search (i.e. results are shown)
  if (resEl.innerHTML && resEl.innerHTML.trim().length > 0) {
    uiSearchUsers();
  }
}

map.on("load", refresh);
map.on("moveend", refresh);

// --- Layer destructive actions ---
async function leaveLayer(groupId) {
  if (!accessToken) { alert("Сначала войдите."); return; }
  if (!confirm("Точно выйти из слоя?")) return;
  try {
    const resp = await apiFetch(`/v1/groups/${groupId}/leave`, { method: "POST" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert("Не удалось выйти: " + (data.detail || resp.status));
      return;
    }
    await refreshUserSnapshot();
    if (selectedGroupLayerIds.has(groupId)) selectedGroupLayerIds.delete(groupId);
    renderGroupLayersUI();
    populateAddGroupSelect();
    closeLayersModal();
    refresh();
  } catch (e) {
    console.error(e);
    alert("Ошибка сети.");
  }
}

async function deleteLayer(groupId) {
  if (!accessToken) { alert("Сначала войдите."); return; }
  let name = `слой ${groupId}`;
  try {
    const g = ((currentUser && currentUser.groups) || []).find(x => x.id === groupId);
    if (g && (g.name || g.title)) name = g.name || g.title;
  } catch (_) {}

  if (!confirm(`Точно хотите удалить слой "${name}"? Все точки этого слоя будут удалены.`)) return;
  try {
    const resp = await apiFetch(`/v1/groups/${groupId}`, { method: "DELETE" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert("Не удалось удалить слой: " + (data.detail || resp.status));
      return;
    }
    await refreshUserSnapshot();
    if (selectedGroupLayerIds.has(groupId)) selectedGroupLayerIds.delete(groupId);
    renderGroupLayersUI();
    populateAddGroupSelect();
    closeLayersModal();
    refresh();
  } catch (e) {
    console.error(e);
    alert("Ошибка сети.");
  }
}
