const API_BASE = ""; // тот же origin (http://localhost:8000)
const LS_TOKEN = "mm_token";

let accessToken = null;
let currentUser = null;  // объект из /v1/me
let currentMarkers = []; // ссылки на Marker, чтобы их удалять
let markersByPlaceId = {}; // {place_id: Marker} — для открытия попапа из панели модерации
let pendingPopupPlaceId = null; // placeId для открытия попапа после refresh
let pendingPopupGroupId = null; // groupId для включения в feed-запрос
let pendingCommentId = null; // commentId для автооткрытия комментариев из уведомления
let _currentPlaces = []; // текущие отфильтрованные точки (обновляется в refresh())
let _editingPlaceId = null; // id точки, редактируемой в sidebar
let _savingEdit = false; // защита от двойного клика «Сохранить»
let _popupNeedsPersistence = false; // попап не влез на экран — сохранять при перемещении карты
let _pendingPopupFromPersistence = false; // pendingPopupPlaceId установлен из persistence (не из flyTo)
let _pendingSharePlaceId = null; // ID точки из share-ссылки (?place=123)

let tempMarker = null; // временный желтый маркер
let tempCoords = null; // { lng, lat } последнего ПКМ

// Friends UI state
let outgoingPendingIds = new Set();

// Layers UI state
let selectedGroupLayerIds = new Set(); // group_id for personal/shared layers (not public=1)
let personalGroupId = null;
let layersFloatingControl = null;
let _prevFloatingLayersHtml = "";

async function apiFetch(path, { method = "GET", headers = {}, body = null } = {}) {
  const h = { ...headers };
  // C5: сохраняем токен, использованный для запроса
  const usedToken = accessToken;
  if (usedToken) h["Authorization"] = "Bearer " + usedToken;

  const resp = await fetch(`${API_BASE}${path}`, { method, headers: h, body });

  // если токен протух/невалидный - сразу разлогиниваемся
  if (resp.status === 401) {
    // C5: если токен уже сменился (re-login) — не logout'ить
    if (accessToken && accessToken !== usedToken) return resp;

    accessToken = null;
    currentUser = null;
    localStorage.removeItem(LS_TOKEN);
    applyAuthUI(false);

    // убираем временный маркер
    if (tempMarker) { tempMarker.remove(); tempMarker = null; }
    tempCoords = null;
  }

  return resp;
}

function createPin(isMine, overrideColor) {
const color = overrideColor || (isMine ? "#5B5BF5" : "#1B6B52"); // синий свои, тил чужие

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

// ========= Auth modal (Фаза 2) =========

/** Открыть модалку авторизации на нужной форме */
function openAuthModal(formName) {
  const overlay = document.getElementById("auth-modal-overlay");
  if (!overlay) return;

  // C9: если есть pending reset email — восстановить forgot-reset-form
  if (formName === "login" && _pendingResetEmail) {
    _hideAllGuestForms();
    const resetForm = document.getElementById("forgot-reset-form");
    if (resetForm) resetForm.style.display = "";
  } else if (formName === "login") {
    showLoginForm();
  } else if (formName === "register") {
    showRegisterForm();
  }

  overlay.style.display = "";

  // W3: показать/скрыть крестик (скрыт на шаге verify)
  _updateAuthModalCloseBtn();

  // Автофокус на поле ввода
  requestAnimationFrame(() => {
    let input;
    if (formName === "register") {
      input = document.getElementById("reg-login-input");
    } else {
      input = document.getElementById("login-input");
    }
    if (input) input.focus();
  });
}

/** Закрыть модалку авторизации */
function closeAuthModal() {
  const overlay = document.getElementById("auth-modal-overlay");
  if (!overlay) return;
  // W3: не закрывать если verify-form видим
  const verifyForm = document.getElementById("verify-form");
  if (verifyForm && verifyForm.style.display !== "none") return;
  overlay.style.display = "none";
}

/** Закрытие по клику на overlay */
function closeAuthModalOnOverlay(e) {
  if (e.target !== e.currentTarget) return;
  // W3: не закрывать при verify
  const verifyForm = document.getElementById("verify-form");
  if (verifyForm && verifyForm.style.display !== "none") return;
  closeAuthModal();
}

/** Обновить видимость крестика модалки */
function _updateAuthModalCloseBtn() {
  const closeBtn = document.getElementById("auth-modal-close-btn");
  const verifyForm = document.getElementById("verify-form");
  if (closeBtn) {
    closeBtn.style.display =
      (verifyForm && verifyForm.style.display !== "none") ? "none" : "";
  }
}

// ========= Header dropdown =========

function toggleHeaderDropdown(e) {
  e.stopPropagation();
  const dd = document.getElementById("header-dropdown");
  if (dd) dd.classList.toggle("open");
}

function closeHeaderDropdown() {
  const dd = document.getElementById("header-dropdown");
  if (dd) dd.classList.remove("open");
}

// ========= Sidebar tabs (Фаза 3) =========

let _currentTab = "layers";

function switchTab(tabName) {
  _currentTab = tabName;
  // Закрыть панель карточек слоя при уходе с таба «Слои»
  if (tabName !== "layers") closeLayerCardsPanel();
  // Закрыть edit place при уходе с таба «Место»
  if (_editingPlaceId && tabName !== "place") closeEditPlace();

  // Обновить кнопки табов
  const tabs = document.querySelectorAll(".sidebar-tab");
  tabs.forEach(t => {
    if (t.dataset.tab === tabName) t.classList.add("active");
    else t.classList.remove("active");
  });

  // Показать/скрыть контент табов
  const contents = ["tab-layers", "tab-friends", "tab-place", "tab-moderation"];
  for (const id of contents) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.style.display = id === "tab-" + tabName ? "" : "none";
  }

  // W7: закрыть все dropdown при переключении
  document.querySelectorAll(".mm-popup-dropdown.open").forEach(el => el.classList.remove("open"));

  // W6: автообновление при переходе на таб модерации
  if (tabName === "moderation") loadModerationQueue();
}

function applyAuthUI(isAuthed) {
  const authedOnly = document.getElementById("authed-only");
  const appEl = document.querySelector(".app");
  const guestActions = document.getElementById("header-guest-actions");
  const userSection = document.getElementById("header-user-section");

  if (isAuthed) {
    // Скрыть гостевые кнопки, показать юзер-секцию header
    if (guestActions) guestActions.style.display = "none";
    if (userSection) userSection.style.display = "";
    // Убрать guest-mode с .app и html (FOUC)
    if (appEl) appEl.classList.remove("guest-mode");
    document.documentElement.classList.remove("guest-mode");
    // Показать authed-only (sidebar контент)
    if (authedOnly) authedOnly.style.display = "";
    // C19: закрыть auth-модалку после успешного логина
    closeAuthModal();
  } else {
    // Показать гостевые кнопки, скрыть юзер-секцию
    if (guestActions) guestActions.style.display = "";
    if (userSection) userSection.style.display = "none";
    // Добавить guest-mode
    if (appEl) appEl.classList.add("guest-mode");
    document.documentElement.classList.add("guest-mode");
    // Скрыть authed-only
    if (authedOnly) authedOnly.style.display = "none";

    // Сбрасываем header notif badge
    const notifBtn = document.getElementById("header-notif-btn");
    const notifBadge = document.getElementById("header-notif-badge");
    if (notifBtn) notifBtn.style.display = "none";
    if (notifBadge) { notifBadge.innerText = "0"; notifBadge.style.display = "none"; }
    closeFriendRequestsModal(true);

    // W8: закрываем settings overlay при logout
    closeSettingsOverlay(true);

    // Сбрасываем TG-статус
    const tgStatus = document.getElementById("tg-status");
    if (tgStatus) tgStatus.innerText = "";
  }

  // Плавающая кнопка слоёв — показывать только залогиненным
  if (layersFloatingControl) {
    if (isAuthed) layersFloatingControl.show();
    else layersFloatingControl.hide();
  }

  // C1: map.resize() после смены layout
  if (typeof map !== "undefined" && map && map.resize) {
    requestAnimationFrame(() => map.resize());
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

/** Кастомная модалка подтверждения (замена confirm())
 * @param {string} message — текст вопроса
 * @param {Object} [opts]
 * @param {string} [opts.title] — заголовок (по умолчанию "Подтверждение")
 * @param {string} [opts.confirmText] — текст кнопки ОК (по умолчанию "Подтвердить")
 * @param {boolean} [opts.isDanger] — красная кнопка подтверждения
 * @returns {Promise<boolean>}
 */
let _mmConfirmResolve = null;
function mmConfirm(message, opts) {
  // Если уже открыта другая модалка подтверждения — закрываем её с false
  if (_mmConfirmResolve) {
    _mmConfirmResolve(false);
    _mmConfirmResolve = null;
  }
  const o = opts || {};
  const modal = document.getElementById("mm-confirm-modal");
  const titleEl = document.getElementById("mm-confirm-title");
  const textEl = document.getElementById("mm-confirm-text");
  const okBtn = document.getElementById("mm-confirm-ok");
  const cancelBtn = document.getElementById("mm-confirm-cancel");

  titleEl.textContent = o.title || "Подтверждение";
  textEl.textContent = message;
  okBtn.textContent = o.confirmText || "Подтвердить";

  // Стиль кнопки: danger или primary
  okBtn.className = o.isDanger ? "btn btn-danger" : "btn btn-primary";

  modal.style.display = "";

  // Убираем старые обработчики через клонирование
  const newOk = okBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOk, okBtn);
  const newCancel = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);

  return new Promise((resolve) => {
    _mmConfirmResolve = resolve;
    newOk.addEventListener("click", () => {
      modal.style.display = "none";
      _mmConfirmResolve = null;
      resolve(true);
    });
    newCancel.addEventListener("click", () => {
      modal.style.display = "none";
      _mmConfirmResolve = null;
      resolve(false);
    });
  });
}

// Welcome-модалка: одноразовое предложение подключить Telegram-бота после первого входа
function showWelcomeModal() {
  const modal = document.getElementById("mm-welcome-modal");
  if (!modal) return;
  modal.style.display = "";
  document.getElementById("mm-welcome-later").onclick = () => { modal.style.display = "none"; };
  document.getElementById("mm-welcome-connect").onclick = () => { modal.style.display = "none"; openSettingsOverlay(); };
}

async function initAuthFromStorage() {
  const saved = localStorage.getItem(LS_TOKEN);
  // C7: если нет токена — сразу guest mode (без мерцания, класс уже на html)
  if (!saved) {
    applyAuthUI(false);
    // C14: если pathname /settings без токена — redirect на /
    if (location.pathname === "/settings") {
      history.replaceState(null, "", "/");
      openAuthModal("login");
    }
    return;
  }

  accessToken = saved;
  // C7: НЕ вызываем applyAuthUI(false) — чтобы залогиненный не видел мерцание guest→authed
  await loadMe();

  // Фаза 4: если URL = /settings и мы залогинены — открыть settings overlay
  if (location.pathname === "/settings" && accessToken) {
    // C11: подготовить history для корректного Back
    history.replaceState(null, "", "/");
    history.pushState({ page: "settings" }, "", "/settings");
    openSettingsOverlay(true); // silent=true — не pushState повторно
  }
}

async function loadMe() {
  const tgBtn = document.getElementById("tg-link-btn");
  const tgHint = document.getElementById("tg-hint");
  const tgStatus = document.getElementById("tg-status");
  const tgCode = document.getElementById("tg-link-code");

  // если токена нет - сразу UI в гостя
  if (!accessToken) {
    currentUser = null;
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

  // Header: имя юзера и badge роли
  const headerUsername = document.getElementById("header-username");
  const headerRoleBadge = document.getElementById("header-role-badge");
  if (headerUsername) headerUsername.innerText = nick;
  if (headerRoleBadge) {
    if (currentUser.role === "admin") {
      headerRoleBadge.innerText = "Админ";
      headerRoleBadge.style.display = "";
    } else if (currentUser.role === "moderator") {
      headerRoleBadge.innerText = "Модератор";
      headerRoleBadge.style.display = "";
    } else {
      headerRoleBadge.style.display = "none";
    }
  }

  applyAuthUI(true);

  // Telegram UI
  const tgUnlinkBtn = document.getElementById("tg-unlink-btn");
  if (currentUser.tg_id) {
    if (tgStatus) tgStatus.innerText = currentUser.username
      ? `Подключён: @${currentUser.username}`
      : `Подключён (ID: ${currentUser.tg_id})`;
    if (tgBtn) tgBtn.style.display = "none";
    if (tgHint) tgHint.style.display = "none";
    if (tgCode) { tgCode.innerText = ""; tgCode.style.display = "none"; }
    if (tgUnlinkBtn) tgUnlinkBtn.style.display = "";
  } else {
    if (tgStatus) tgStatus.innerText = "Не подключён";
    // не показываем кнопку если уже идёт процесс привязки (код сгенерирован)
    const linkingInProgress = tgCode && tgCode.style.display !== "none" && tgCode.innerHTML.trim() !== "";
    if (tgBtn && !linkingInProgress) tgBtn.style.display = "";
    if (tgHint) tgHint.style.display = "";
    if (tgUnlinkBtn) tgUnlinkBtn.style.display = "none";
  }

  // Таб модерации — показываем только admin и moderator
  const isModerator = currentUser.role === "admin" || currentUser.role === "moderator";
  const tabBtnMod = document.getElementById("tab-btn-moderation");
  if (tabBtnMod) tabBtnMod.style.display = isModerator ? "" : "none";
  if (isModerator) loadModerationQueue();

  // Панель администратора — показываем только admin
  const adminPanel = document.getElementById("admin-panel");
  if (adminPanel) {
    const isAdmin = currentUser.role === "admin";
    adminPanel.style.display = isAdmin ? "" : "none";
    if (isAdmin) loadAdminUsers();
  }

  // Обновляем badge модерации
  updateModerationBadge();

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
    if (!login || !password) { showToast("Введите логин и пароль.", "error"); return; }

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
          _updateAuthModalCloseBtn(); // W3: скрыть крестик при verify
          // C8: сохраняем в sessionStorage
          try { sessionStorage.setItem("mm_pendingVerifyEmail", _pendingVerifyEmail); } catch(_e) {}
          document.getElementById("verify-status").innerText =
            errData.email_sent === false
              ? "Не удалось отправить код. Нажмите «Отправить повторно»."
              : "Код подтверждения отправлен на вашу почту.";
        } else {
          showToast("Email не подтверждён. Попробуйте войти ещё раз.", "error");
        }
      } else if (resp.status === 400 && errData.detail === "password_too_long") {
        showToast("Пароль слишком длинный (макс. 128 символов).", "error");
      } else {
        showToast("Неверный логин или пароль.", "error");
      }
      return;
    }
    const data = await resp.json();
    accessToken = data.access_token;
    localStorage.setItem(LS_TOKEN, accessToken);
    await loadMe();
    refresh();
    // Retry share-ссылки после логина (если была ?place= до авторизации)
    await tryOpenSharedPlace();
    // Welcome-модалка: предлагаем подключить Telegram (одноразово, не при share-ссылке)
    if (currentUser && !currentUser.tg_id
        && !localStorage.getItem("mm_welcome_shown_" + currentUser.id)
        && !new URLSearchParams(window.location.search).has("place")) {
      localStorage.setItem("mm_welcome_shown_" + currentUser.id, "1");
      showWelcomeModal();
    }
  } catch (e) {
    showToast("Ошибка сети. Попробуйте ещё раз.", "error");
  } finally {
    btn.disabled = false;
  }
}

// email, на который отправлен код (запоминаем для verify/resend)
// C8/C9: восстанавливаем из sessionStorage при F5
let _pendingVerifyEmail = null;
let _pendingResetEmail = null;
let _pendingNewEmail = null;
try {
  _pendingVerifyEmail = sessionStorage.getItem("mm_pendingVerifyEmail") || null;
  _pendingResetEmail = sessionStorage.getItem("mm_pendingResetEmail") || null;
} catch(_e) {}

async function uiRegister() {
  const btn = document.querySelector("#register-form .btn-primary");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const login = (document.getElementById("reg-login-input").value || "").trim();
    const email = (document.getElementById("reg-email-input").value || "").trim();
    const password = document.getElementById("reg-password-input").value || "";
    if (!login || !password || !email) { showToast("Заполните логин, email и пароль.", "error"); return; }
    if (login.length < 3 || login.length > 64) { showToast("Логин должен быть от 3 до 64 символов.", "error"); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(login)) { showToast("Логин может содержать только латиницу, цифры, _ и -", "error"); return; }
    if (password.length < 8) { showToast("Пароль должен быть не короче 8 символов.", "error"); return; }
    if (password.length > 128) { showToast("Пароль не должен превышать 128 символов.", "error"); return; }

    const resp = await fetch(`${API_BASE}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, password, email }),
    });
    if (resp.status === 409) {
      const data = await resp.json().catch(() => ({}));
      if (data.detail === "email_taken") showToast("Этот email уже зарегистрирован.", "error");
      else showToast("Логин занят.", "error");
      return;
    }
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      if (data.detail === "invalid_email") showToast("Некорректный формат email.", "error");
      else if (data.detail === "login_invalid_length") showToast("Логин должен быть от 3 до 64 символов.", "error");
      else if (data.detail === "login_invalid_chars") showToast("Логин может содержать только латиницу, цифры, _ и -", "error");
      else if (data.detail === "password_too_short") showToast("Пароль должен быть не короче 8 символов.", "error");
      else if (data.detail === "password_too_long") showToast("Пароль не должен превышать 128 символов.", "error");
      else showToast("Ошибка регистрации.", "error");
      return;
    }
    const regData = await resp.json();
    _pendingVerifyEmail = email;
    // C8: сохраняем в sessionStorage
    try { sessionStorage.setItem("mm_pendingVerifyEmail", email); } catch(_e) {}
    document.getElementById("register-form").style.display = "none";
    document.getElementById("verify-form").style.display = "";
    document.getElementById("verify-email-display").innerText = email;
    _updateAuthModalCloseBtn(); // W3: скрыть крестик при verify
    document.getElementById("verify-status").innerText =
      regData.email_sent === false
        ? "Не удалось отправить письмо. Нажмите «Отправить повторно»."
        : "";
  } catch (e) {
    showToast("Ошибка сети. Попробуйте ещё раз.", "error");
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
    try { sessionStorage.removeItem("mm_pendingVerifyEmail"); } catch(_e) {}
    document.getElementById("verify-form").style.display = "none";
    document.getElementById("login-form").style.display = "";
    document.getElementById("verify-code-input").value = "";
    _updateAuthModalCloseBtn(); // W3: показать крестик после verify
    showToast("Email подтверждён! Теперь войдите в аккаунт.", "success");
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
    // C9: сохраняем в sessionStorage
    try { sessionStorage.setItem("mm_pendingResetEmail", email); } catch(_e) {}
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
    try { sessionStorage.removeItem("mm_pendingResetEmail"); } catch(_e) {}
    document.getElementById("forgot-reset-code-input").value = "";
    document.getElementById("forgot-reset-password-input").value = "";
    showLoginForm();
    showToast("Пароль успешно сброшен! Войдите с новым паролем.", "success");
  } catch (e) {
    statusEl.innerText = "Ошибка сети. Попробуйте ещё раз.";
  } finally {
    btn.disabled = false;
  }
}

// --- Settings overlay (Фаза 4: полноэкранный SPA-оверлей) ---

function openSettingsOverlay(silent) {
  // Закрываем header dropdown
  closeHeaderDropdown();

  const overlay = document.getElementById("settings-overlay");
  if (!overlay) return;
  overlay.style.display = "";

  // заполняем текущие данные
  const loginEl = document.getElementById("settings-current-login");
  const emailEl = document.getElementById("settings-current-email");
  if (loginEl) loginEl.innerText = (currentUser && currentUser.login) || "—";
  if (emailEl) emailEl.innerText = (currentUser && currentUser.email) || "не указан";

  // сбрасываем секции и показываем первую (telegram)
  toggleSettingsSection("telegram");
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

  // C6: pushState только если pathname !== "/settings"
  if (!silent) {
    if (location.pathname !== "/settings") {
      history.pushState({ page: "settings" }, "", "/settings");
    }
  }
}

function closeSettingsOverlay(silent) {
  const overlay = document.getElementById("settings-overlay");
  if (!overlay || overlay.style.display === "none") return;
  overlay.style.display = "none";

  // C6: history.back() чтобы не стекать pushState
  if (!silent && location.pathname === "/settings") {
    history.back();
  }
}

// popstate handler — Back кнопка закрывает settings
window.addEventListener("popstate", () => {
  if (location.pathname !== "/settings") {
    const overlay = document.getElementById("settings-overlay");
    if (overlay) overlay.style.display = "none";
  } else {
    // Если мы вернулись на /settings (Forward), откроем overlay
    if (accessToken) openSettingsOverlay(true);
  }
});

function toggleSettingsSection(name) {
  const sections = ["login", "email", "password", "telegram", "delete"];
  // скрываем все панели, убираем active со всех пунктов
  for (const n of sections) {
    const b = document.getElementById("settings-body-" + n);
    if (b) b.style.display = "none";
    const nav = document.querySelector(`.settings-nav-item[data-section="${n}"]`);
    if (nav) nav.classList.remove("active");
  }
  // показываем выбранную
  const body = document.getElementById("settings-body-" + name);
  const nav = document.querySelector(`.settings-nav-item[data-section="${name}"]`);
  if (body) body.style.display = "";
  if (nav) nav.classList.add("active");
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
    const headerUsername = document.getElementById("header-username");
    if (headerUsername) headerUsername.innerText = newLogin;
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
    closeSettingsOverlay();
    showToast("Пароль изменён.", "success");
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
    closeSettingsOverlay();
    showToast("Email изменён.", "success");
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
  _prevFriendsHtml = "";
  _prevBlockedHtml = "";
  _prevGroupLayersHtml = "";
  _prevGroupSelectHtml = "";
  _prevFloatingLayersHtml = "";
  selectedGroupLayerIds.clear();
  personalGroupId = null;
  layersFloatingControl?.hide();

  // Закрыть edit place если открыт
  closeEditPlace();

  // C18: сброс pending-переменных
  pendingPopupPlaceId = null;
  pendingPopupGroupId = null;
  pendingCommentId = null;
  _popupNeedsPersistence = false;
  _pendingPopupFromPersistence = false;
  outgoingPendingIds = new Set();
  _adminUsersList = null;

  // C12: сброс таба на «Слои»
  _currentTab = "layers";
  switchTab("layers");

  // Закрыть все overlays
  closeLayerCardsPanel();
  closeAuthModal();
  closeSettingsOverlay(true);
  closeHeaderDropdown();

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

  // очистить превью фото
  _selectedFiles = [];
  _renderPhotoPreview();

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
  const overlay = document.getElementById("delete-account-overlay");
  const pwSection = document.getElementById("delete-account-password-section");
  const noPwHint = document.getElementById("delete-account-no-password-hint");
  const pwInput = document.getElementById("delete-account-password");

  // Показываем/скрываем поле пароля в зависимости от has_password
  const hasPw = currentUser && currentUser.has_password;
  if (pwSection) pwSection.style.display = hasPw ? "" : "none";
  if (noPwHint) noPwHint.style.display = hasPw ? "none" : "";
  if (pwInput) pwInput.value = "";

  overlay.style.display = "flex";
}

function closeDeleteAccountModal() {
  document.getElementById("delete-account-overlay").style.display = "none";
  // Очищаем поле пароля при закрытии
  const pwInput = document.getElementById("delete-account-password");
  if (pwInput) pwInput.value = "";
}

function closeDeleteAccountModalOnOverlay(e) {
  if (e.target === e.currentTarget) closeDeleteAccountModal();
}

async function confirmDeleteAccount() {
  const btn = document.getElementById("delete-account-confirm-btn");
  if (btn && btn.disabled) return;

  const hasPw = currentUser && currentUser.has_password;
  const pwInput = document.getElementById("delete-account-password");
  const password = pwInput ? pwInput.value : "";

  // Если есть пароль — требуем его ввод
  if (hasPw && !password) {
    showToast("Введите пароль для подтверждения удаления.", "error");
    return;
  }

  if (btn) btn.disabled = true;
  try {
    const resp = await apiFetch("/v1/me/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    if (resp.status === 403) {
      showToast("Неправильный пароль.", "error");
      return;
    }
    if (!resp.ok) {
      showToast("Не удалось удалить аккаунт.", "error");
      return;
    }

    closeDeleteAccountModal();
    uiLogout();
    showToast("Аккаунт успешно удалён.", "success");
  } finally {
    if (btn) btn.disabled = false;
  }
}

let _linkingTelegram = false;
async function startTelegramLink() {
  if (_linkingTelegram) return;
  if (!accessToken) {
    showToast("Сначала войдите.", "error");
    return;
  }
  _linkingTelegram = true;

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
      _linkingTelegram = false;
      return;
    }

    const data = await resp.json();

    // скрываем кнопку «Подключить» — вместо неё покажем ссылку на бота
    const tgBtn = document.getElementById("tg-link-btn");
    if (tgBtn) tgBtn.style.display = "none";

    // deep link — кликабельная кнопка-ссылка на бота
    if (tgCode) {
      if (data.bot_link) {
        // вытаскиваем @username бота из ссылки t.me/BotName?start=...
        const botName = data.bot_link.match(/t\.me\/([^?/]+)/)?.[1] || "";
        tgCode.innerHTML =
          `<a href="${escapeHtml(data.bot_link)}" target="_blank" class="btn btn-primary" ` +
          `style="display:inline-block;text-decoration:none;margin-top:4px;">` +
          `Открыть бота в Telegram</a>` +
          `<div class="hint" style="margin-top:6px;">Или отправьте команду <b>/link ${escapeHtml(data.code)}</b> боту ` +
          `<a href="https://t.me/${escapeHtml(botName)}" target="_blank" style="color:#2ECC71;">@${escapeHtml(botName)}</a></div>`;
      } else {
        tgCode.innerText = `Отправьте команду /link ${data.code} боту в Telegram`;
      }
    }

    // ждем привязку
    let attempts = 30;
    const timer = setInterval(async () => {
      attempts--;
      if (!accessToken) { clearInterval(timer); _linkingTelegram = false; return; }
      await loadMe();
      if (currentUser?.tg_id || attempts <= 0) {
        clearInterval(timer);
        _linkingTelegram = false;
      }
    }, 2000);

  } catch (e) {
    console.error(e);
    if (tgCode) tgCode.innerText = "Ошибка сети при генерации кода.";
    _linkingTelegram = false;
  }
}

let _unlinkingTelegram = false;
async function unlinkTelegram() {
  if (_unlinkingTelegram) return;
  if (!await mmConfirm("Отвязать Telegram от аккаунта?", { confirmText: "Отвязать", isDanger: true })) return;
  _unlinkingTelegram = true;
  try {
    const resp = await apiFetch("/v1/me/telegram", { method: "DELETE" });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      if (data.detail === "set_password_first") {
        showToast("Сначала установите пароль в настройках, иначе вы не сможете войти в аккаунт.", "error");
      } else if (data.detail === "telegram_not_linked") {
        showToast("Telegram уже отвязан.", "error");
      } else {
        showToast(data.detail || "Ошибка отвязки.", "error");
      }
      return;
    }
    await loadMe();
  } catch (e) {
    console.error(e);
    showToast("Ошибка сети.", "error");
  } finally {
    _unlinkingTelegram = false;
  }
}


// -------------------- FRIENDS UI --------------------

function updateNotifBadge() {
  const badge = document.getElementById("header-notif-badge");
  const btn = document.getElementById("header-notif-btn");
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
  // Показываем кнопку колокольчика всегда для залогиненных
  if (btn) btn.style.display = currentUser ? "" : "none";
}

/** Обновить badge модерации на табе */
function updateModerationBadge() {
  const badge = document.getElementById("moderation-badge");
  if (!badge) return;
  const count = (currentUser && typeof currentUser.moderation_pending_count === "number")
    ? currentUser.moderation_pending_count : 0;
  badge.innerText = String(count);
  badge.style.display = count > 0 ? "" : "none";
}

// Сохранённые копии последнего сгенерированного HTML — сравниваем с ними,
// а не с innerHTML, потому что пользовательские взаимодействия (открытие dropdown,
// клик по checkbox) модифицируют DOM и innerHTML начинает отличаться от шаблона.
let _prevFriendsHtml = "";
let _prevBlockedHtml = "";
let _prevGroupLayersHtml = "";
let _prevGroupSelectHtml = "";

function refreshFriendsUI() {
  const listEl = document.getElementById("friends-list");
  if (!listEl) return;

  const friends = (currentUser && Array.isArray(currentUser.friends)) ? currentUser.friends : [];
  if (friends.length === 0) {
    const empty = `<div class="hint">Пока друзей нет.</div>`;
    if (_prevFriendsHtml !== empty) {
      listEl.innerHTML = empty;
      _prevFriendsHtml = empty;
    }
    refreshBlockedListUI();
    return;
  }

  const newHtml = friends.map(u => {
    const title = escapeHtml(u.login || u.username || `user#${u.id}`);
    const sub = escapeHtml(
      u.username ? `@${u.username}` : ""
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
              <button class="mm-popup-dropdown-item" data-action="remove-friend" data-user-id="${u.id}" data-name="${escapedName}">Удалить из друзей</button>
              <button class="mm-popup-dropdown-item" data-action="block-user" data-user-id="${u.id}" data-name="${escapedName}">Заблокировать</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join("");

  // Обновляем DOM только если данные изменились (убирает мерцание при периодическом обновлении).
  // Сравниваем с _prevFriendsHtml, а не с innerHTML — пользователь может открыть dropdown
  // (добавится класс .open), и innerHTML будет отличаться от шаблона.
  if (_prevFriendsHtml !== newHtml) {
    listEl.innerHTML = newHtml;
    _prevFriendsHtml = newHtml;
  }

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
    const eyeSvg = _layerEyeSvg(selectedGroupLayerIds.has(personalGroupId));
    parts.push(
      `<div class="layer-row" onclick="onLayerRowClick(event, ${personalGroupId})">
        <div class="left">
          ${eyeSvg(personalGroupId)}
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
    const eyeSvg = _layerEyeSvg(selectedGroupLayerIds.has(g.id));
    const name = escapeHtml(g.name || `Слой ${g.id}`);
    const visibility = g.visibility === "friends" ? "друзья" : "приватный";
    const role = g.my_role ? String(g.my_role) : "";
    parts.push(
      `<div class="layer-row" onclick="onLayerRowClick(event, ${g.id})">
        <div class="left">
          ${eyeSvg(g.id)}
          <div style="min-width:0;">
            <div class="name">${name}</div>
            <div class="meta">${escapeHtml(visibility)}${role ? ` • ${escapeHtml(role)}` : ""}</div>
          </div>
        </div>
        <div class="actions">
          <button class="btn btn-ghost btn-icon" title="Открыть" onclick="openEditLayerModal(${g.id})">⚙</button>
        </div>
      </div>`
    );
  }

  const newHtml = parts.join("");
  if (_prevGroupLayersHtml !== newHtml) {
    listEl.innerHTML = newHtml;
    _prevGroupLayersHtml = newHtml;
  }
  renderFloatingLayersContent();
}

/** Возвращает функцию (groupId) => htmlString для SVG-иконки видимости */
function _layerEyeSvg(isVisible) {
  if (isVisible) {
    return (gid) => `<svg class="layer-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" onclick="toggleGroupLayer(${gid})" title="Скрыть"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
  }
  return (gid) => `<svg class="layer-eye layer-eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" onclick="toggleGroupLayer(${gid})" title="Показать"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`;
}

/** Клик по строке слоя — открыть панель карточек, если клик не по иконке видимости / кнопке настроек */
function onLayerRowClick(event, groupId) {
  if (event.target.closest(".layer-eye") || event.target.closest(".actions")) return;
  openLayerCardsPanel(groupId);
}

function toggleGroupLayer(groupId) {
  if (selectedGroupLayerIds.has(groupId)) selectedGroupLayerIds.delete(groupId);
  else selectedGroupLayerIds.add(groupId);
  renderFloatingLayersContent();
  renderGroupLayersUI();
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
  const newHtml = opts.map(o => `<option value="${o.id}">${escapeHtml(o.label)}</option>`).join("");
  if (_prevGroupSelectHtml !== newHtml) {
    _prevGroupSelectHtml = newHtml;
    sel.innerHTML = newHtml;
    // keep selection if possible
    const still = opts.find(o => o.id === current);
    sel.value = String(still ? current : 1);
  }
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
  if (!accessToken) { showToast("Сначала войдите.", "error"); return; }
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
    <input id="layer-create-name" class="input" placeholder="Например: Поездки" maxlength="100" onkeydown="if(event.key==='Enter'){event.preventDefault();submitCreateLayer();}" />

    <div class="field-label" style="margin-top:10px;">Добавить редакторов (друзья)</div>
    <div style="max-height:220px;overflow:auto;border:1px solid #D6CFC5;border-radius:14px;padding:8px;">
      ${friendsHtml}
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
      <button class="btn" onclick="closeLayersModal()">Отмена</button>
      <button class="btn btn-primary" onclick="submitCreateLayer()">Создать</button>
    </div>
    <div id="layer-create-status" class="hint" style="margin-top:8px;"></div>
  `);
}

let _creatingLayer = false;
async function submitCreateLayer() {
  if (_creatingLayer) return;
  const statusEl = document.getElementById("layer-create-status");
  const nameEl = document.getElementById("layer-create-name");
  const name = (nameEl ? nameEl.value : "").trim();
  if (!name) { if (statusEl) { statusEl.style.color = ""; statusEl.innerText = "Введите название."; } return; }

  _creatingLayer = true;
  const checked = Array.from(document.querySelectorAll(".layer-friend-checkbox"))
    .filter(x => x.checked)
    .map(x => Number(x.value))
    .filter(Boolean);

  try {
    if (statusEl) { statusEl.style.color = ""; statusEl.innerText = "Создаю слой…"; }
    const resp = await apiFetch("/v1/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, visibility: "private", add_friends: false }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (statusEl) { statusEl.style.color = "#b91c1c"; statusEl.innerText = "Ошибка: " + (data.detail || resp.status); }
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
    showToast("Слой создан.", "success");
  } catch (e) {
    console.error(e);
    if (statusEl) { statusEl.style.color = "#b91c1c"; statusEl.innerText = "Ошибка сети."; }
  } finally {
    _creatingLayer = false;
  }
}

async function openEditLayerModal(groupId) {
  if (!accessToken) { showToast("Сначала войдите.", "error"); return; }

  // determine my role from current snapshot
  const g = ((currentUser && currentUser.groups) || []).find(x => x.id === groupId);
  const myRole = g ? g.my_role : null;
  const isOwner = myRole === "owner" || currentUser?.role === "admin";
  const isPersonal = personalGroupId && groupId === personalGroupId;

  try {
    const resp = await apiFetch(`/v1/groups/${groupId}`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      showToast("Не удалось открыть слой: " + (data.detail || resp.status), "error");
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
        : `<button class="btn btn-ghost btn-icon" title="Удалить" data-action="remove-member" data-group-id="${groupId}" data-user-id="${m.id}" data-name="${label}">✕</button>`;

      return `
        <div class="list-item" style="align-items:center;">
          <div class="meta">
            <div class="title">${label}</div>
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
      ${pendingInvitesHtml}
    ` : `
      <div class="hint" style="margin-top:10px;">Управлять участниками может только владелец слоя.</div>
    `;

    const renameSection = isOwner ? `
      <div class="field-label">Переименовать</div>
      <div style="display:flex;gap:8px;align-items:center;">
        <input id="layer-rename" class="input" value="${title}" style="flex:1;" maxlength="100" onkeydown="if(event.key==='Enter'){event.preventDefault();renameLayer(${groupId});}" />
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
      <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
        ${(!isPersonal && !isOwner) ? `<button class="btn" onclick="leaveLayer(${groupId}, ${data.place_count || 0})">Выйти из слоя</button>` : ``}
        ${(!isPersonal && isOwner) ? `<button class="btn btn-danger" onclick="deleteLayer(${groupId})">Удалить слой</button>` : ``}
      </div>

    `);

  } catch (e) {
    console.error(e);
    showToast("Ошибка сети.", "error");
  }
}

let _renamingLayer = false;
async function renameLayer(groupId) {
  if (_renamingLayer) return;
  const statusEl = document.getElementById("layer-edit-status");
  const inp = document.getElementById("layer-rename");
  const name = (inp ? inp.value : "").trim();
  if (!name) { if (statusEl) { statusEl.style.color = ""; statusEl.innerText = "Название не может быть пустым."; } return; }
  _renamingLayer = true;
  try {
    const resp = await apiFetch(`/v1/groups/${groupId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (statusEl) { statusEl.style.color = "#b91c1c"; statusEl.innerText = "Ошибка: " + (data.detail || resp.status); }
      return;
    }
    await refreshUserSnapshot();
    renderGroupLayersUI();
    populateAddGroupSelect();
    // Обновить заголовок панели карточек, если она открыта для этого слоя
    if (_layerCardsPanelGroupId === groupId) {
      const titleEl = document.getElementById("layer-cards-title");
      if (titleEl) titleEl.textContent = name;
    }
    if (statusEl) { statusEl.style.color = ""; statusEl.innerText = "Сохранено."; }
  } catch (e) {
    console.error(e);
    if (statusEl) { statusEl.style.color = "#b91c1c"; statusEl.innerText = "Ошибка сети."; }
  } finally {
    _renamingLayer = false;
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

let _sendingInvite = false;
async function sendLayerInvite(groupId) {
  if (_sendingInvite) return;
  const statusEl = document.getElementById("layer-edit-status");
  const userSel = document.getElementById("layer-add-user");
  const roleSel = document.getElementById("layer-add-role");
  const uid = userSel ? Number(userSel.value) : null;
  const role = roleSel ? roleSel.value : "editor";
  if (!uid) return;
  _sendingInvite = true;
  try {
    const resp = await apiFetch(`/v1/groups/${groupId}/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: uid, role }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (statusEl) { statusEl.style.color = "#b91c1c"; statusEl.innerText = "Ошибка: " + (data.detail || resp.status); }
      return;
    }
    if (data.status === "already_pending") {
      if (statusEl) { statusEl.style.color = ""; statusEl.innerText = "Приглашение уже отправлено."; }
      return;
    }
    if (statusEl) { statusEl.style.color = ""; statusEl.innerText = "Приглашение отправлено."; }
    // Обновляем модалку чтобы показать pending-инвайт
    openEditLayerModal(groupId);
  } catch (e) {
    console.error(e);
    if (statusEl) { statusEl.style.color = "#b91c1c"; statusEl.innerText = "Ошибка сети."; }
  } finally {
    _sendingInvite = false;
  }
}

async function cancelGroupInvite(inviteId, groupId) {
  const statusEl = document.getElementById("layer-edit-status");
  try {
    const resp = await apiFetch(`/v1/groups/invites/${inviteId}`, { method: "DELETE" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (statusEl) { statusEl.style.color = "#b91c1c"; statusEl.innerText = "Ошибка: " + (data.detail || resp.status); }
      return;
    }
    openEditLayerModal(groupId);
  } catch (e) {
    console.error(e);
    if (statusEl) { statusEl.style.color = "#b91c1c"; statusEl.innerText = "Ошибка сети."; }
  }
}

async function removeLayerMember(groupId, userId, displayName) {
  const ok = await mmConfirm(`Удалить пользователя ${displayName} из слоя?`, { confirmText: "Удалить", isDanger: true });
  if (!ok) return;
  const statusEl = document.getElementById("layer-edit-status");
  try {
    const resp = await apiFetch(`/v1/groups/${groupId}/members/${userId}`, { method: "DELETE" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (statusEl) { statusEl.style.color = "#b91c1c"; statusEl.innerText = "Ошибка: " + (data.detail || resp.status); }
      return;
    }
    await refreshUserSnapshot();
    renderGroupLayersUI();
    populateAddGroupSelect();
    openEditLayerModal(groupId);
  } catch (e) {
    console.error(e);
    if (statusEl) { statusEl.style.color = "#b91c1c"; statusEl.innerText = "Ошибка сети."; }
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
      if (statusEl) { statusEl.style.color = "#b91c1c"; statusEl.innerText = "Ошибка: " + (data.detail || resp.status); }
      return;
    }
    await refreshUserSnapshot();
    openEditLayerModal(groupId);
  } catch (e) {
    console.error(e);
    if (statusEl) { statusEl.style.color = "#b91c1c"; statusEl.innerText = "Ошибка сети."; }
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
  layersFloatingControl?.close();
});

// Закрытие по Escape — полная цепочка приоритетов (W1)
document.addEventListener("keydown", (e) => {
  // Приоритет 0: фото-галерея (Escape/стрелки)
  if (_galleryState) {
    if (e.key === "Escape") { closeGallery(); return; }
    if (e.key === "ArrowLeft") { galleryNav(-1); return; }
    if (e.key === "ArrowRight") { galleryNav(1); return; }
    return; // блокируем остальные клавиши пока галерея открыта
  }

  if (e.key === "Escape") {
    // Приоритет 0.5: модалка подтверждения (mmConfirm)
    const confirmModal = document.getElementById("mm-confirm-modal");
    if (confirmModal && confirmModal.style.display !== "none") {
      document.getElementById("mm-confirm-cancel").click();
      return;
    }
    // Приоритет 0.7: welcome-модалка
    const welcomeModal = document.getElementById("mm-welcome-modal");
    if (welcomeModal && welcomeModal.style.display !== "none") {
      welcomeModal.style.display = "none";
      return;
    }
    // Приоритет 1: floating layers dropdown
    if (layersFloatingControl?.isOpen()) {
      layersFloatingControl.close();
      return;
    }
    // Приоритет 2: header dropdown
    const headerDD = document.getElementById("header-dropdown");
    if (headerDD && headerDD.classList.contains("open")) {
      closeHeaderDropdown();
      return;
    }
    // Приоритет 4: popup dropdown-меню (report + comment + friends)
    const openDropdowns = document.querySelectorAll(".mm-popup-dropdown.open");
    if (openDropdowns.length) {
      openDropdowns.forEach(el => el.classList.remove("open"));
      return;
    }
    // Приоритет 4: inline-редактирование комментариев
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
    // Приоритет 4.5: sidebar edit (после dropdown, чтобы Escape сначала закрыл dropdown)
    if (_editingPlaceId) { closeEditPlace(); return; }
    // Приоритет 5: модалка удаления аккаунта (вложена в settings)
    const delOverlay = document.getElementById("delete-account-overlay");
    if (delOverlay && delOverlay.style.display !== "none") {
      closeDeleteAccountModal();
      return;
    }
    // Приоритет 6: auth-модалка (но не при verify)
    const authOverlay = document.getElementById("auth-modal-overlay");
    const verifyForm = document.getElementById("verify-form");
    if (authOverlay && authOverlay.style.display !== "none") {
      if (!verifyForm || verifyForm.style.display === "none") {
        closeAuthModal();
        return;
      }
    }
    // Приоритет 7: settings overlay
    const settingsOverlay = document.getElementById("settings-overlay");
    if (settingsOverlay && settingsOverlay.style.display !== "none") {
      closeSettingsOverlay();
      return;
    }
    // Приоритет 8: модалка комментариев
    const commOverlay = document.getElementById("comments-overlay");
    if (commOverlay && commOverlay.style.display !== "none") {
      closeCommentsModal();
      return;
    }
    // Приоритет 9: модалка жалобы
    const reportOverlay = document.getElementById("report-overlay");
    if (reportOverlay && reportOverlay.style.display !== "none") {
      closeReportModal();
      return;
    }
    // Приоритет 10: модалка слоёв
    const layersOverlay = document.getElementById("layers-modal-overlay");
    if (layersOverlay && layersOverlay.style.display !== "none") {
      closeLayersModal();
      return;
    }
    // Приоритет 11: модалка уведомлений
    const frOverlay = document.getElementById("modal-overlay");
    if (frOverlay && frOverlay.style.display !== "none") {
      closeFriendRequestsModal();
      return;
    }
    // Приоритет 12: панель карточек слоя
    if (_layerCardsPanelGroupId !== null) {
      closeLayerCardsPanel();
      return;
    }
  }
});

// Закрытие popup-меню при клике вне
document.addEventListener("click", (e) => {
  // Закрытие header dropdown при клике вне
  if (!e.target.closest(".header-user-menu")) {
    closeHeaderDropdown();
  }
  // Закрытие floating layers dropdown при клике вне
  if (layersFloatingControl?.isOpen() && !e.target.closest(".mm-layers-float")) {
    layersFloatingControl.close();
  }
  if (e.target.closest(".mm-popup-dropdown") || e.target.closest(".mm-popup-menu-btn")) return;
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
  if (!accessToken) { showToast("Сначала войдите.", "error"); return; }
  const ok = await mmConfirm(`Точно хотите удалить из друзей ${friendName}?`, { confirmText: "Удалить", isDanger: true });
  if (!ok) return;

  try {
    const resp = await apiFetch(`/v1/friends/${friendId}`, { method: "DELETE" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      showToast("Не удалось удалить из друзей: " + (data.detail || resp.status), "error");
      return;
    }
    await refreshUserSnapshot();
    refreshFriendsUI();
    // обновим поиск/инвайты тоже
    outgoingPendingIds.delete(friendId);
    updateNotifBadge();
  } catch (e) {
    console.error(e);
    showToast("Ошибка сети при удалении из друзей.", "error");
  }
}

// -------------------- BLOCK / UNBLOCK --------------------

async function confirmBlockUser(userId, displayName) {
  if (!accessToken) { showToast("Сначала войдите.", "error"); return; }
  const ok = await mmConfirm(`Заблокировать ${displayName}? Дружба будет удалена, пользователь не сможет найти вас и отправить запрос.`, { confirmText: "Заблокировать", isDanger: true });
  if (!ok) return;

  try {
    const resp = await apiFetch("/v1/blocks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      showToast("Не удалось заблокировать: " + (data.detail || resp.status), "error");
      return;
    }
    await refreshUserSnapshot();
    refreshFriendsUI();
    updateNotifBadge();
  } catch (e) {
    console.error(e);
    showToast("Ошибка сети при блокировке.", "error");
  }
}

async function declineAndBlockUser(requestId, userId, displayName) {
  if (!accessToken) { showToast("Сначала войдите.", "error"); return; }
  const ok = await mmConfirm(`Отклонить запрос и заблокировать ${displayName}?`, { confirmText: "Заблокировать", isDanger: true });
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
      showToast("Запрос отклонён, но не удалось заблокировать: " + (data.detail || resp.status), "error");
    }
    await refreshUserSnapshot();
    await loadFriendRequestsLists();
    refreshFriendsUI();
    updateNotifBadge();
  } catch (e) {
    console.error(e);
    showToast("Ошибка сети.", "error");
  }
}

async function unblockUser(userId) {
  if (!accessToken) { showToast("Сначала войдите.", "error"); return; }

  try {
    const resp = await apiFetch(`/v1/blocks/${userId}`, { method: "DELETE" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      showToast("Не удалось разблокировать: " + (data.detail || resp.status), "error");
      return;
    }
    await refreshUserSnapshot();
    refreshBlockedListUI();
  } catch (e) {
    console.error(e);
    showToast("Ошибка сети при разблокировке.", "error");
  }
}

function refreshBlockedListUI() {
  const section = document.getElementById("blocked-section");
  const listEl = document.getElementById("blocked-list");
  if (!section || !listEl) return;

  const blocked = (currentUser && Array.isArray(currentUser.blocked_users)) ? currentUser.blocked_users : [];
  if (blocked.length === 0) {
    section.style.display = "none";
    if (_prevBlockedHtml !== "") {
      listEl.innerHTML = "";
      _prevBlockedHtml = "";
    }
    return;
  }

  section.style.display = "";
  const newHtml = blocked.map(u => {
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
  if (_prevBlockedHtml !== newHtml) {
    listEl.innerHTML = newHtml;
    _prevBlockedHtml = newHtml;
  }
}

let _searchingUsers = false;
async function uiSearchUsers() {
  if (_searchingUsers) return;
  if (!accessToken) { showToast("Сначала войдите.", "error"); return; }

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

  _searchingUsers = true;
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
        u.username ? `@${u.username}` : ""
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
  } finally {
    _searchingUsers = false;
  }
}

async function sendFriendRequest(toUserId) {
  if (!accessToken) { showToast("Сначала войдите.", "error"); return; }

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
      showToast("Не удалось отправить приглашение: " + (data.detail || resp.status), "error");
      return;
    }

    // backend might auto-accept reverse request
    if (data.status === "accepted_by_reverse_request") {
      outgoingPendingIds.delete(toUserId);
      showToast("Запрос принят автоматически. Теперь вы друзья.", "success");
    } else if (data.status === "already_friends") {
      outgoingPendingIds.delete(toUserId);
      showToast("Вы уже друзья.", "info");
    } else {
      showToast("Приглашение отправлено.", "success");
    }

    await refreshUserSnapshot();
    await loadFriendRequestsListsSafe();
    uiSearchUsers();
  } catch (e) {
    console.error(e);
    outgoingPendingIds.delete(toUserId);
    showToast("Ошибка сети при отправке приглашения.", "error");
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
  if (!accessToken) { showToast("Сначала войдите.", "error"); return; }

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
            from.username ? `@${from.username}` : ""
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
                    <button class="mm-popup-dropdown-item" data-action="decline-block" data-request-id="${r.id}" data-user-id="${from.id}" data-name="${fromName}">Заблокировать</button>
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
            to.username ? `@${to.username}` : ""
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
      showToast("Не удалось принять: " + (data.detail || resp.status), "error");
      return;
    }
    await refreshUserSnapshot();
    await loadFriendRequestsLists();
    refresh(); // чтобы новые точки от друзей (в будущем) могли появиться; сейчас просто безопасно
  } catch (e) {
    console.error(e);
    showToast("Ошибка сети.", "error");
  }
}

async function declineFriendRequest(requestId) {
  try {
    const resp = await apiFetch(`/v1/friends/requests/${requestId}/decline`, { method: "POST" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      showToast("Не удалось отклонить: " + (data.detail || resp.status), "error");
      return;
    }
    await refreshUserSnapshot();
    await loadFriendRequestsLists();
  } catch (e) {
    console.error(e);
    showToast("Ошибка сети.", "error");
  }
}

let _processingInvites = new Set();

async function acceptGroupInvite(inviteId) {
  if (_processingInvites.has(inviteId)) return;
  _processingInvites.add(inviteId);
  try {
    const resp = await apiFetch(`/v1/groups/invites/${inviteId}/accept`, { method: "POST" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      showToast("Не удалось принять: " + (data.detail || resp.status), "error");
      return;
    }
    await refreshUserSnapshot();
    renderGroupLayersUI();
    populateAddGroupSelect();
    await loadFriendRequestsLists();
    refresh();
  } catch (e) {
    console.error(e);
    showToast("Ошибка сети.", "error");
  } finally {
    _processingInvites.delete(inviteId);
  }
}

async function declineGroupInvite(inviteId) {
  if (_processingInvites.has(inviteId)) return;
  _processingInvites.add(inviteId);
  try {
    const resp = await apiFetch(`/v1/groups/invites/${inviteId}/decline`, { method: "POST" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      showToast("Не удалось отклонить: " + (data.detail || resp.status), "error");
      return;
    }
    await refreshUserSnapshot();
    await loadFriendRequestsLists();
  } catch (e) {
    console.error(e);
    showToast("Ошибка сети.", "error");
  } finally {
    _processingInvites.delete(inviteId);
  }
}

// Лёгкое обновление currentUser (без трогания панелей модерации/админки)
async function refreshUserSnapshot() {
  if (!accessToken) return;
  const resp = await apiFetch("/v1/me");
  // W16: после await проверить что не вышли из аккаунта
  if (!accessToken) return;
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


let _addingWebPoint = false;
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

const files = _selectedFiles.slice(); // копия массива выбранных файлов
if (files.length > 12) {
    if (statusEl) {
    statusEl.innerText = "Можно добавить не более 12 фотографий.";
    statusEl.style.color = "#A33D33";
    statusEl.style.fontWeight = "600";
    }
    return;
}

// Защита от двойного клика
if (_addingWebPoint) return;
_addingWebPoint = true;

try {
const titleInput = document.getElementById("web-title");
const noteInput = document.getElementById("web-note");

const titleRaw = titleInput ? titleInput.value : "";
const note = noteInput ? noteInput.value.trim() : "";

let titleFinal = (titleRaw || "").trim();
if (!titleFinal) {
  titleFinal = `${tempCoords.lat.toFixed(5)}, ${tempCoords.lng.toFixed(5)}`;
}

let mediaKeys = [];
if (files.length > 0) {
    if (statusEl) {
        statusEl.innerText = "Загрузка фотографий...";
        statusEl.style.color = "#52525b";
        statusEl.style.fontWeight = "400";
    }
    mediaKeys = await uploadPhotos(files);
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

    const resp = await apiFetch("/v1/places", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
    if (statusEl) {
        statusEl.innerText = "Не удалось добавить точку (код " + resp.status + ").";
        statusEl.style.color = "#A33D33";
        statusEl.style.fontWeight = "600";
    }
    return;
    }

    // успех
    if (statusEl) {
    statusEl.innerText = "Точка добавлена.";
    statusEl.style.color = "#1B6B52";
    statusEl.style.fontWeight = "600";
    }

    // очищаем форму и временный пин
    if (titleInput) titleInput.value = "";
    if (noteInput) noteInput.value = "";
    _selectedFiles = [];
    _renderPhotoPreview();
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
    refreshLayerCardsPanel();
} catch (err) {
    console.error(err);
    if (statusEl) {
    statusEl.innerText = "Ошибка соединения с API при добавлении точки.";
    }
} finally {
    _addingWebPoint = false;
}
}

// Конвертация HEIC/HEIF в JPEG на клиенте (для iPhone фото).
// Возвращает null если HEIC и heic2any недоступен — вызывающий код должен пропустить файл.
async function convertHeicIfNeeded(file) {
  var isHeic = file.type === "image/heic" || file.type === "image/heif"
    || file.name.toLowerCase().endsWith(".heic")
    || file.name.toLowerCase().endsWith(".heif");
  if (!isHeic) return file;
  if (typeof heic2any === "undefined") {
    console.warn("heic2any не загружен, HEIC-файл пропущен:", file.name);
    return null;
  }
  var blob = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
  return new File([blob], file.name.replace(/\.hei[cf]$/i, ".jpg"), { type: "image/jpeg" });
}

async function uploadPhotos(files) {
const mediaKeys = [];

for (const origFile of files) {
    const file = await convertHeicIfNeeded(origFile);
    if (!file) continue; // HEIC без heic2any — пропускаем
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

function onLayerChange() {
renderFloatingLayersContent();
refresh();
}

// ===== Плавающая кнопка слоёв на карте (IControl) =====

class LayersFloatingControl {
  onAdd() {
    this._container = document.createElement("div");
    this._container.className = "mm-layers-float maplibregl-ctrl";
    this._container.style.display = "none"; // скрыт до логина

    // Кнопка (SVG — Lucide «layers»)
    this._btn = document.createElement("button");
    this._btn.className = "mm-layers-float-btn";
    this._btn.type = "button";
    this._btn.title = "Слои";
    this._btn.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M12 2 2 7l10 5 10-5-10-5z"/>' +
      '<path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>';

    // Dropdown
    this._dropdown = document.createElement("div");
    this._dropdown.className = "mm-layers-float-dropdown";

    this._container.appendChild(this._btn);
    this._container.appendChild(this._dropdown);

    // Клик по кнопке — toggle dropdown
    this._btn.addEventListener("click", (e) => {
      // Закрываем другие открытые menus перед stopPropagation
      document.querySelectorAll(".mm-popup-dropdown.open").forEach(el => el.classList.remove("open"));
      e.stopPropagation();
      if (this.isOpen()) this.close();
      else this.open();
    });

    // Остановка propagation внутри dropdown (чтобы глобальный click-handler не закрывал)
    // Но закрываем другие открытые menus (report/comment dropdown)
    this._dropdown.addEventListener("click", (e) => {
      document.querySelectorAll(".mm-popup-dropdown.open").forEach(el => el.classList.remove("open"));
      e.stopPropagation();
    });

    // Change handler — event delegation на чекбоксах
    this._dropdown.addEventListener("change", (e) => {
      const cb = e.target;
      if (!cb.matches("input[type=checkbox]")) return;

      if (cb.dataset.floatLayer === "public") {
        const el = document.getElementById("layer-public");
        if (el) el.checked = cb.checked;
      } else if (cb.dataset.floatLayer === "my") {
        const el = document.getElementById("layer-my");
        if (el) el.checked = cb.checked;
      } else if (cb.dataset.floatGroup) {
        const gid = Number(cb.dataset.floatGroup);
        if (cb.checked) selectedGroupLayerIds.add(gid);
        else selectedGroupLayerIds.delete(gid);
        // Обновить иконку видимости в sidebar
        renderGroupLayersUI();
      }
      // Обновить _prevFloatingLayersHtml без innerHTML (защита от мерцания при setInterval)
      _prevFloatingLayersHtml = buildFloatingLayersHtml();
      refresh();
    });

    // Остановка wheel/touch propagation (чтобы скролл dropdown не зумил/панорамировал карту)
    this._dropdown.addEventListener("wheel", (e) => e.stopPropagation());
    this._dropdown.addEventListener("touchmove", (e) => e.stopPropagation(), { passive: true });

    return this._container;
  }

  onRemove() {
    this._container.parentNode?.removeChild(this._container);
  }

  isOpen() { return this._dropdown.classList.contains("open"); }

  open() {
    renderFloatingLayersContent(true);
    this._dropdown.classList.add("open");
  }

  close() { this._dropdown.classList.remove("open"); }

  show() { this._container.style.display = ""; }

  hide() {
    this.close();
    this._container.style.display = "none";
  }
}

/** Чистая функция — генерирует HTML содержимого floating dropdown слоёв */
function buildFloatingLayersHtml() {
  const pubChecked = document.getElementById("layer-public")?.checked;
  const myChecked = document.getElementById("layer-my")?.checked;
  const groups = (currentUser && Array.isArray(currentUser.groups)) ? currentUser.groups : [];

  let html = '<div class="mm-layers-float-section">Публичные</div>';
  html += `<label class="mm-layers-float-item">
    <input type="checkbox" data-float-layer="public"${pubChecked ? " checked" : ""}> Все точки
  </label>`;
  html += `<label class="mm-layers-float-item">
    <input type="checkbox" data-float-layer="my"${myChecked ? " checked" : ""}> Мои точки
  </label>`;

  // Личная карта + групповые слои (сортировка по ID — как в sidebar)
  const layerGroups = groups
    .filter(g => g && g.id && g.visibility !== "public" && g.id !== 1)
    .sort((a, b) => (a.id || 0) - (b.id || 0));

  if (layerGroups.length > 0) {
    html += '<div class="mm-layers-float-divider"></div>';
    html += '<div class="mm-layers-float-section">Личные и групповые</div>';
    for (const g of layerGroups) {
      const checked = selectedGroupLayerIds.has(g.id) ? " checked" : "";
      const isPersonal = personalGroupId && g.id === personalGroupId;
      const name = isPersonal ? "Личная карта" : escapeHtml(g.name || `Слой ${g.id}`);
      html += `<label class="mm-layers-float-item">
        <input type="checkbox" data-float-group="${g.id}"${checked}> <span class="mm-layers-float-name">${name}</span>
      </label>`;
    }
  }

  return html;
}

/** Применяет HTML к dropdown (с diff-защитой от мерцания) */
function renderFloatingLayersContent(force) {
  if (!layersFloatingControl) return;
  const html = buildFloatingLayersHtml();
  if (!force && html === _prevFloatingLayersHtml) return;
  layersFloatingControl._dropdown.innerHTML = html;
  _prevFloatingLayersHtml = html;
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

// Оба контрола в bottom-right: сначала zoom (у угла), потом слои (над ним)
map.addControl(new maplibregl.NavigationControl(), "bottom-right");
layersFloatingControl = new LayersFloatingControl();
map.addControl(layersFloatingControl, "bottom-right");

map.on("contextmenu", (e) => {
  // W2: запрет до входа — не подавлять стандартное меню для гостя
  if (!currentUser) return;

  if (e.originalEvent && e.originalEvent.preventDefault) {
    e.originalEvent.preventDefault();
  }

  // Закрыть edit place если открыт — ПКМ = добавление новой точки
  if (_editingPlaceId) closeEditPlace();
  setTempMarker(e.lngLat);
  // Автопереключение на таб «Место»
  switchTab("place");
});

function clearMarkers() {
currentMarkers.forEach(m => {
    const popup = m.getPopup();
    if (popup) popup.remove();
    m.remove();
});
currentMarkers = [];
markersByPlaceId = {};
}

// ========= Кластеризация маркеров (grid-based) =========

/** Группирует близкие точки в кластеры (по расстоянию).
 *  excludeId — id точки, которую не кластеризовать (для pendingPopupPlaceId). */
function clusterPoints(points, zoom, excludeId) {
  if (points.length === 0) return points;

  // Радиус кластеризации: при удалении больше, при приближении меньше
  // zoom 8 → ~26px, zoom 10 → ~20px, zoom 12 → ~14px, zoom 14+ → ~8px
  const base = Math.max(8, 50 - zoom * 3);
  const radius = base / Math.pow(2, zoom);
  const r2 = radius * radius;

  // Исключаем точку, для которой нужен попап
  let excluded = null;
  let toCluster = points;
  if (excludeId != null) {
    toCluster = [];
    for (const p of points) {
      if (p.id === excludeId) excluded = p;
      else toCluster.push(p);
    }
  }
  const clusters = []; // [{lat, lon, points: [...]}]

  for (const p of toCluster) {
    let nearest = null;
    let nearestDist = Infinity;
    for (const c of clusters) {
      const dlat = p.lat - c.lat;
      const dlon = p.lon - c.lon;
      const d2 = dlat * dlat + dlon * dlon;
      if (d2 <= r2 && d2 < nearestDist) {
        nearest = c;
        nearestDist = d2;
      }
    }
    if (nearest) {
      nearest.points.push(p);
      // Обновляем центроид
      const n = nearest.points.length;
      nearest.lat = (nearest.lat * (n - 1) + p.lat) / n;
      nearest.lon = (nearest.lon * (n - 1) + p.lon) / n;
    } else {
      clusters.push({ lat: p.lat, lon: p.lon, points: [p] });
    }
  }

  const result = [];
  for (const c of clusters) {
    if (c.points.length === 1) {
      result.push(c.points[0]);
    } else {
      let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
      for (const p of c.points) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lon < minLon) minLon = p.lon;
        if (p.lon > maxLon) maxLon = p.lon;
      }
      // Вычисляем зум, при котором кластер точно разделится
      const diagLat = maxLat - minLat;
      const diagLon = maxLon - minLon;
      const diag = Math.sqrt(diagLat * diagLat + diagLon * diagLon);
      let splitZoom = 18;
      for (let z = Math.floor(zoom) + 1; z <= 18; z++) {
        const b = Math.max(8, 50 - z * 3);
        const r = b / Math.pow(2, z);
        if (diag > 2 * r) { splitZoom = z; break; }
      }
      // Точки на одинаковых координатах: при высоком зуме показываем индивидуально
      if (splitZoom > 17 && zoom >= 17) {
        for (const p of c.points) result.push(p);
        continue;
      }
      result.push({
        _isCluster: true,
        _count: c.points.length,
        lat: c.lat,
        lon: c.lon,
        _bounds: [[minLon, minLat], [maxLon, maxLat]],
        _splitZoom: splitZoom,
      });
    }
  }
  // Добавляем исключённую точку как индивидуальный маркер
  if (excluded) result.push(excluded);
  return result;
}

/** Создаёт DOM-элемент для маркера кластера */
function createClusterMarker(count) {
  const size = count < 10 ? 28 : count < 50 ? 36 : 44;
  const el = document.createElement("div");
  el.className = "mm-cluster-marker";
  el.style.width = size + "px";
  el.style.height = size + "px";
  el.textContent = count;
  return el;
}

function updateCounter(n) {
const el = document.getElementById("points-counter");
if (el) el.innerText = "Точек: " + n;
}

function setStatus(text, isError) {
const el = document.getElementById("status-text");
if (!el) return;
el.innerText = text;
el.style.color = isError ? "#dc2626" : "#16a34a";
}

function setTempMarker(lngLat) {
tempCoords = { lng: lngLat.lng, lat: lngLat.lat };

// обновляем текст с координатами
const coordsEl = document.getElementById("web-coords");
if (coordsEl) {
    coordsEl.textContent =
    tempCoords.lat.toFixed(5) + ", " + tempCoords.lng.toFixed(5) + "  (широта, долгота)";
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

let _refreshSeq = 0; // sequence counter для отбрасывания устаревших ответов
async function refresh() {
  const seq = ++_refreshSeq;
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
    if (seq !== _refreshSeq) return; // устаревший ответ — игнорируем
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

  _currentPlaces = filtered;

  // Сохранить открытый попап для переоткрытия после refresh (только если не влез на экран)
  if (pendingPopupPlaceId === null && _popupNeedsPersistence) {
    for (const [pid, m] of Object.entries(markersByPlaceId)) {
      if (m.getPopup && m.getPopup()?.isOpen()) {
        pendingPopupPlaceId = Number(pid);
        _pendingPopupFromPersistence = true;
        break;
      }
    }
  }

  clearMarkers();

  // Кластеризация: при зуме < 15 группируем близкие точки
  const clustered = clusterPoints(filtered, map.getZoom(), pendingPopupPlaceId);

  clustered.forEach(p => {
      // Кластер — круг с числом, клик зумит ближе
      if (p._isCluster) {
        const el = createClusterMarker(p._count);
        el.addEventListener("click", () => {
          // Зумим до уровня, где кластер точно разделится (минимум +1, максимум 18)
          const targetZoom = Math.min(18, Math.max(map.getZoom() + 1, p._splitZoom));
          map.flyTo({ center: [p.lon, p.lat], zoom: targetZoom });
        });
        const marker = new maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat([p.lon, p.lat])
          .addTo(map);
        currentMarkers.push(marker);
        return;
      }

      // серый пин для точек на модерации/отклонённых, зелёный для своих, синий для чужих
      const isPending = p.moderation_status === "pending";
      const isRejected = p.moderation_status === "rejected";
      const pinColor = (isPending || isRejected) ? "#A0A0A0" : undefined;
      const el = createPin(p.isMine, pinColor);

      const who = p.isMine
          ? "Моя точка"
          : (p.user_login ? p.user_login : (p.username ? ("@" + p.username) : "Аноним"));

      // плашка «На модерации» (новая точка) / «Поступила жалоба» (approved с жалобой)
      let pendingBadge = "";
      if (isPending) {
        pendingBadge = `<div class="mm-report-badge mm-report-badge--pending">На модерации</div>`;
      } else if (isRejected && p.isMine) {
        pendingBadge = `<div class="mm-report-badge mm-report-badge--reported">Отклонено</div>`;
      } else if (p.isMine && p.has_report) {
        pendingBadge = `<div class="mm-report-badge mm-report-badge--reported">Поступила жалоба</div>`;
      }

      // экранируем кавычки
      const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

      // Единый ⋯ меню: пункты зависят от роли
      const menuItems = [];
      // Кнопка «Поделиться» — для всех точек (копирует ссылку в буфер обмена)
      menuItems.push(`<button class="mm-popup-dropdown-item mm-popup-dropdown-item--default" onclick="sharePlace(${p.id});event.stopPropagation();">Поделиться</button>`);
      if (p.isMine) {
        menuItems.push(`<button class="mm-popup-dropdown-item mm-popup-dropdown-item--default" onclick="openEditPlace(${p.id})">Редактировать</button>`);
        menuItems.push(`<button class="mm-popup-dropdown-item mm-popup-dropdown-item--danger" onclick="confirmDeletePlace(${p.id})">Удалить</button>`);
      }
      const canReport = !p.isMine && !isPending && currentUser;
      if (canReport) {
        menuItems.push(`<button class="mm-popup-dropdown-item mm-popup-dropdown-item--danger" onclick="openReportModal(${p.id})">Пожаловаться</button>`);
      }
      const menuHtml = menuItems.length > 0
        ? `<div class="mm-popup-menu">
            <button class="mm-popup-menu-btn" onclick="this.nextElementSibling.classList.toggle('open');event.stopPropagation();" title="Действия">⋯</button>
            <div class="mm-popup-dropdown">${menuItems.join("")}</div>
          </div>`
        : "";

      // кнопки модерации в попапе (только для pending-точек, видны admin/moderator)
      const moderationBtns = isPending && currentUser && (currentUser.role === "admin" || currentUser.role === "moderator")
        ? `<div style="margin-top:6px;display:flex;gap:6px;">
            <button onclick="moderatePlace(${p.id},'approved')" style="font-size:12px;padding:4px 10px;border-radius:9999px;border:1px solid #1B6B52;background:#E0F0E8;color:#145A44;cursor:pointer;">Одобрить</button>
            <button onclick="moderatePlace(${p.id},'rejected')" style="font-size:12px;padding:4px 10px;border-radius:9999px;border:1px solid #C44B3F;background:#FDF0EE;color:#A33D33;cursor:pointer;">Отклонить</button>
          </div>`
        : "";

      // Фото: все в сетке со скроллом
      let photosHtml = "";
      if (p.media && p.media.length) {
        const maxVisible = 3;
        const visible = p.media.slice(0, maxVisible);
        const hiddenCount = p.media.length - maxVisible;
        const thumbs = visible.map(m =>
          `<img src="${m.url}" data-full="${m.url}" class="mm-photo-thumb" style="width:56px;height:56px;object-fit:cover;border-radius:6px;cursor:pointer;" />`
        ).join("");
        const moreBtn = hiddenCount > 0
          ? `<div class="mm-photo-more" onclick="openGalleryForPlace(${p.id},${maxVisible});event.stopPropagation();">+${hiddenCount}</div>`
          : "";
        photosHtml = `<div class="mm-popup-photos" data-place-id="${p.id}">${thumbs}${moreBtn}</div>`;
      }

      const displayTitle =
        p.title && p.title.trim()
          ? p.title
          : `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;

      const titleHtml = `<div class="mm-popup-title">${esc(displayTitle)}</div>`;

      // Бейдж слоя (не для личной группы)
      const layerBadgeHtml = (!p.group_is_personal && p.group_name)
        ? `<span class="mm-layer-badge">${esc(p.group_name)}</span>`
        : "";

      // Описание: collapse >3 строк, «Развернуть» inline после текста
      const noteText = p.note || "";
      const needsCollapse = noteText.length > 150 || noteText.split("\n").length > 3;
      let noteHtml = "";
      if (noteText) {
        if (needsCollapse) {
          // Обрезаем до 3 строк / 150 символов
          let truncLines = noteText.split("\n").slice(0, 3).join("\n");
          if (truncLines.length > 150) truncLines = truncLines.substring(0, 150);
          truncLines = truncLines.trimEnd();
          noteHtml = `<div class="mm-popup-note" data-place-id="${p.id}"><span class="mm-popup-note-text">${esc(truncLines)}… </span><span class="mm-popup-expand" onclick="expandPopupNote(${p.id});event.stopPropagation();">Развернуть</span></div>`;
        } else {
          noteHtml = `<div class="mm-popup-note">${esc(noteText)}</div>`;
        }
      }

      // Кнопка «Комментарии (N)» — для не-личных точек
      const commentsCount = p.comments_count || 0;
      const showComments = !p.group_is_personal;
      const commentsBtnHtml = showComments
        ? `<button class="mm-comments-btn" onclick="openCommentsModal(${p.id}, ${p.user_id || 'null'})">${pluralRu(commentsCount, "Комментарий", "Комментария", "Комментариев")} (${commentsCount})</button>`
        : "";

      const popupHtml = `<div class="mm-popup">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:4px;">
<div style="flex:1;min-width:0;">${titleHtml}</div>
${menuHtml}
</div>
<div class="mm-popup-meta">${esc(who)} ${layerBadgeHtml}</div>
${noteHtml}
${pendingBadge}
${moderationBtns}
${photosHtml}
${commentsBtnHtml}
</div>`;

      const popup = new maplibregl.Popup({ closeButton: false }).setHTML(popupHtml);
      // Проверяем, влез ли попап на экран — если нет, сохраняем при перемещении карты
      popup.on('open', () => {
        requestAnimationFrame(() => {
          const popupEl = popup.getElement();
          if (popupEl) {
            const r = popupEl.getBoundingClientRect();
            _popupNeedsPersistence = !(
              r.top >= 0 && r.left >= 0 &&
              r.bottom <= window.innerHeight && r.right <= window.innerWidth
            );
          }
        });
      });

      const marker = new maplibregl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([p.lon, p.lat])
      .setPopup(popup)
      .addTo(map);

      currentMarkers.push(marker);
      markersByPlaceId[p.id] = marker;
  });

  // Открываем попап, если был запрос через "Показать на карте" или persistence
  // Только когда карта остановилась — иначе следующий refresh уничтожит попап
  if (pendingPopupPlaceId !== null && !map.isMoving()) {
    const marker = markersByPlaceId[pendingPopupPlaceId];
    if (marker) {
      marker.togglePopup();
      // Убрать автофокус с кнопок попапа (иначе синяя рамка на троеточии/карандаше)
      document.activeElement?.blur();
      requestAnimationFrame(() => document.activeElement?.blur());
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
      pendingPopupPlaceId = null;
      pendingPopupGroupId = null;
      _pendingPopupFromPersistence = false;
    } else if (_pendingPopupFromPersistence) {
      // Точка вышла за bbox — прекращаем попытки persistence
      pendingPopupPlaceId = null;
      _pendingPopupFromPersistence = false;
      _popupNeedsPersistence = false;
    }
  }

  updateCounter(filtered.length);
  setStatus("Подключено к API", false);
}

/** Развернуть/свернуть описание в попапе */
function expandPopupNote(placeId) {
  var p = _currentPlaces.find(function(x) { return x.id === placeId; });
  if (!p || !p.note) return;
  var noteDiv = document.querySelector('.mm-popup-note[data-place-id="' + placeId + '"]');
  if (!noteDiv) return;
  var textSpan = noteDiv.querySelector(".mm-popup-note-text");
  var expandBtn = noteDiv.querySelector(".mm-popup-expand");
  if (!textSpan || !expandBtn) return;
  var isExpanded = noteDiv.classList.toggle("mm-popup-note--expanded");
  if (isExpanded) {
    textSpan.textContent = p.note + " ";
    expandBtn.textContent = "Свернуть";
  } else {
    var lines = p.note.split("\n").slice(0, 3).join("\n");
    if (lines.length > 150) lines = lines.substring(0, 150);
    textSpan.textContent = lines.trimEnd() + "… ";
    expandBtn.textContent = "Развернуть";
  }
}

/** Удалить точку через ⋯ меню */
async function confirmDeletePlace(placeId) {
  // Закрываем dropdown
  document.querySelectorAll(".mm-popup-dropdown.open").forEach(el => el.classList.remove("open"));
  if (!await mmConfirm("Удалить эту точку?", { confirmText: "Удалить", isDanger: true })) return;
  if (!accessToken) { showToast("Сначала войдите.", "error"); return; }
  const resp = await apiFetch(`/v1/places/${placeId}`, { method: "DELETE" });
  if (!resp.ok) { showToast("Ошибка удаления (код " + resp.status + ")", "error"); return; }
  refresh();
  refreshLayerCardsPanel();
}

/** Открыть галерею со всеми фото точки */
function openGalleryForPlace(placeId, startIndex) {
  const p = _currentPlaces.find(x => x.id === placeId);
  if (!p || !p.media || !p.media.length) return;
  const urls = p.media.map(m => m.url);
  openGallery(urls, startIndex || 0);
}

// ========= Sidebar: редактирование точки =========

/** Открыть форму редактирования точки в sidebar */
function openEditPlace(placeId) {
  // Закрываем dropdown
  document.querySelectorAll(".mm-popup-dropdown.open").forEach(el => el.classList.remove("open"));

  const place = _currentPlaces.find(p => p.id === placeId);
  if (!place) { showToast("Точка не найдена.", "error"); return; }

  _editingPlaceId = placeId;
  _popupNeedsPersistence = false; // сбрасываем persistence при переходе к edit

  // Title, Note
  const editTitleEl = document.getElementById("edit-title");
  editTitleEl.value = place.title || "";
  document.getElementById("edit-note").value = place.note || "";

  // Слой — select из доступных групп (owner/editor)
  renderEditGroupSelect(place);

  // Фото
  renderEditPhotos(place);

  // Переключиться на таб «Место» и показать секцию редактирования
  switchTab("place");
  document.getElementById("place-add-section").style.display = "none";
  document.getElementById("place-edit-section").style.display = "";

  // Подстроить высоту textarea названия (после показа секции, иначе scrollHeight = 0)
  editTitleEl.style.height = "auto";
  editTitleEl.style.height = editTitleEl.scrollHeight + "px";

  // Закрыть попап
  currentMarkers.forEach(m => {
    const popup = m.getPopup();
    if (popup && popup.isOpen()) popup.remove();
  });

  // Очистить статус
  const statusEl = document.getElementById("edit-status");
  if (statusEl) { statusEl.innerText = ""; statusEl.style.color = ""; }
}

/** Заполнить select слоя для edit */
function renderEditGroupSelect(place) {
  const sel = document.getElementById("edit-group");
  if (!currentUser || !currentUser.groups) { sel.innerHTML = ""; return; }

  // Доступные группы: Public map (id=1) + private где owner/editor (кроме чужих личных)
  // Аналогично фильтру в форме создания точки (renderGroupSelect)
  const available = [];
  for (const g of currentUser.groups) {
    if (!g || !g.id) continue;
    if (g.id === 1) {
      available.push(g);
    } else if (g.visibility === "public") {
      continue; // остальные публичные группы пропускаем
    } else if ((g.my_role === "owner" || g.my_role === "editor") &&
               (!g.is_personal || g.my_role === "owner")) {
      available.push(g);
    }
  }

  sel.innerHTML = available.map(g => {
    const selected = g.id === place.group_id ? "selected" : "";
    return `<option value="${g.id}" ${selected}>${escapeHtml(g.name)}</option>`;
  }).join("");
}

/** Отрисовать фото в edit panel */
function renderEditPhotos(place) {
  const container = document.getElementById("edit-photos");
  const media = place.media || [];

  container.innerHTML = media.map(m => `
    <div style="position:relative;width:60px;height:60px;">
      <img src="${m.url}" class="mm-photo-thumb"
        style="width:60px;height:60px;object-fit:cover;border-radius:6px;cursor:pointer;"
        data-full="${m.url}" />
      <button class="mm-del-media-btn" data-media-id="${m.id}" title="Удалить"
        style="position:absolute;top:2px;right:2px;border:none;background:rgba(0,0,0,0.55);
        color:#fff;border-radius:9999px;width:18px;height:18px;cursor:pointer;">×</button>
    </div>
  `).join("");

  const actionsEl = document.getElementById("edit-photo-actions");
  const remaining = 12 - media.length;
  actionsEl.innerHTML = remaining > 0
    ? `<button class="btn mm-add-photo-btn" data-id="${place.id}" data-have="${media.length}">Добавить фото</button>`
    : `<span class="hint">Лимит фото (12)</span>`;
}

/** Сохранить изменения точки */
async function saveEditPlace() {
  if (_savingEdit) return;
  _savingEdit = true;

  const statusEl = document.getElementById("edit-status");
  statusEl.innerText = "Сохранение...";
  statusEl.style.color = "";

  try {
    const payload = {
      title: document.getElementById("edit-title").value,
      note: document.getElementById("edit-note").value,
      group_id: Number(document.getElementById("edit-group").value),
    };

    const resp = await apiFetch(`/v1/places/${_editingPlaceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      let msg = err.detail || "Ошибка сохранения";
      if (msg === "title_too_long") msg = "Название слишком длинное (макс. 200)";
      if (msg === "note_too_long") msg = "Заметка слишком длинная (макс. 5000)";
      if (msg === "group_not_found") msg = "Слой не найден";
      if (msg === "no_write_access") msg = "Нет доступа к этому слою";
      statusEl.innerText = msg;
      statusEl.style.color = "#b91c1c";
      return;
    }

    statusEl.innerText = "Сохранено.";
    statusEl.style.color = "#1B6B52";

    refresh();
    refreshLayerCardsPanel();
    setTimeout(() => closeEditPlace(), 600);
  } catch (e) {
    console.error(e);
    statusEl.innerText = "Ошибка сети.";
    statusEl.style.color = "#b91c1c";
  } finally {
    _savingEdit = false;
  }
}

/** Закрыть форму редактирования */
function closeEditPlace() {
  _editingPlaceId = null;
  document.getElementById("place-edit-section").style.display = "none";
  document.getElementById("place-add-section").style.display = "";

  const statusEl = document.getElementById("edit-status");
  if (statusEl) { statusEl.innerText = ""; statusEl.style.color = ""; }
}

// ========= Фото-галерея (lightbox) =========
let _galleryState = null; // null = закрыта, { urls: string[], index: number }
let _galleryLoadGen = 0;  // счётчик поколений загрузки — защита от гонки callback'ов

function openGallery(urls, index) {
  // Защита от двойного клика — удаляем старую галерею
  var old = document.getElementById("mm-photo-modal");
  if (old) old.remove();

  _galleryState = { urls: urls, index: index };
  document.body.style.overflow = "hidden";

  var modal = document.createElement("div");
  modal.id = "mm-photo-modal";
  modal.className = "mm-photo-modal";

  var closeBtn = document.createElement("button");
  closeBtn.className = "mm-gallery-close";
  closeBtn.innerHTML = "&#10005;";
  closeBtn.onclick = function(e) { e.stopPropagation(); closeGallery(); };

  var prevBtn = document.createElement("button");
  prevBtn.className = "mm-gallery-arrow mm-gallery-prev";
  prevBtn.innerHTML = "&#8249;";
  prevBtn.style.display = urls.length <= 1 ? "none" : "";
  prevBtn.onclick = function(e) { e.stopPropagation(); galleryNav(-1); };

  var nextBtn = document.createElement("button");
  nextBtn.className = "mm-gallery-arrow mm-gallery-next";
  nextBtn.innerHTML = "&#8250;";
  nextBtn.style.display = urls.length <= 1 ? "none" : "";
  nextBtn.onclick = function(e) { e.stopPropagation(); galleryNav(1); };

  var img = document.createElement("img");
  img.className = "mm-gallery-img";
  img.alt = "Фото";

  // Spinner загрузки фото
  var spinner = document.createElement("div");
  spinner.className = "mm-gallery-spinner";

  modal.appendChild(closeBtn);
  modal.appendChild(prevBtn);
  modal.appendChild(spinner);
  modal.appendChild(img);
  modal.appendChild(nextBtn);

  // Закрытие по клику на фон (не на дочерние элементы)
  modal.onclick = function(e) {
    if (e.target === modal) closeGallery();
  };

  // Touch-свайп для мобильных
  var touchStartX = 0;
  modal.addEventListener("touchstart", function(e) {
    touchStartX = e.changedTouches[0].clientX;
  }, { passive: true });
  modal.addEventListener("touchmove", function(e) {
    e.preventDefault(); // блокируем нативный скролл/bounce внутри галереи
  }, { passive: false });
  modal.addEventListener("touchend", function(e) {
    var delta = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(delta) > 50) {
      galleryNav(delta < 0 ? 1 : -1);
    }
  });

  document.body.appendChild(modal);
  _galleryUpdateView();
}

function closeGallery() {
  var modal = document.getElementById("mm-photo-modal");
  if (modal) modal.remove();
  _galleryState = null;
  _galleryLoadGen++;  // инвалидируем все pending callback'и preload-изображений
  document.body.style.overflow = "";
}

function galleryNav(delta) {
  if (!_galleryState || _galleryState.urls.length <= 1) return;
  var len = _galleryState.urls.length;
  _galleryState.index = (_galleryState.index + delta + len) % len;
  _galleryUpdateView();
}

function _galleryUpdateView() {
  if (!_galleryState) return;
  var modal = document.getElementById("mm-photo-modal");
  if (!modal) return;
  var img = modal.querySelector(".mm-gallery-img");
  if (!img) return;
  var spinner = modal.querySelector(".mm-gallery-spinner");

  var url = _galleryState.urls[_galleryState.index];

  // Увеличиваем поколение — все предыдущие callback'и станут неактуальными
  var gen = ++_galleryLoadGen;

  // Убираем предыдущее сообщение об ошибке
  var oldErr = modal.querySelector(".mm-gallery-error");
  if (oldErr) oldErr.remove();
  img.style.display = "";

  // Показываем spinner, делаем текущее фото полупрозрачным
  img.style.opacity = "0.3";
  if (spinner) spinner.style.display = "";

  var preload = new Image();
  preload.onload = function() {
    // Проверяем что это всё ещё актуальный запрос (защита от быстрых кликов)
    if (_galleryLoadGen !== gen) return;
    // Убираем errEl если вдруг остался от предыдущего цикла
    var staleErr = modal.querySelector(".mm-gallery-error");
    if (staleErr) staleErr.remove();
    img.style.display = "";
    img.src = url;
    img.alt = "Фото";
    img.style.opacity = "1";
    if (spinner) spinner.style.display = "none";
  };
  preload.onerror = function() {
    if (_galleryLoadGen !== gen) return;
    img.style.display = "none";
    if (spinner) spinner.style.display = "none";
    // Текстовое сообщение вместо broken image (проверяем что ещё нет errEl)
    if (!modal.querySelector(".mm-gallery-error")) {
      var errEl = document.createElement("div");
      errEl.className = "mm-gallery-error";
      errEl.textContent = "Не удалось загрузить фото";
      modal.appendChild(errEl);
    }
  };
  preload.src = url;
}

// Делегированный click handler для открытия галереи
document.addEventListener("click", function(e) {
  var img = e.target.closest(".mm-photo-thumb");
  if (!img) return;
  e.preventDefault();
  e.stopPropagation();

  // В попапе показаны только 3 фото — используем _currentPlaces для полного списка
  var popupContainer = img.closest(".mm-popup");
  if (popupContainer) {
    var photoDiv = img.closest("[data-place-id]");
    if (photoDiv) {
      var placeId = Number(photoDiv.getAttribute("data-place-id"));
      var visibleThumbs = photoDiv.querySelectorAll(".mm-photo-thumb");
      var clickedIndex = Array.from(visibleThumbs).indexOf(img);
      openGalleryForPlace(placeId, clickedIndex >= 0 ? clickedIndex : 0);
      return;
    }
  }

  // Для остальных контейнеров (модерация, sidebar edit) — из DOM
  var container = img.parentElement;
  if (container.querySelectorAll(".mm-photo-thumb").length <= 1) {
    container = container.parentElement;
  }
  var thumbs = container.querySelectorAll(".mm-photo-thumb");
  var urls = Array.from(thumbs).map(function(t) { return t.getAttribute("data-full") || t.src; });
  var index = Array.from(thumbs).indexOf(img);

  openGallery(urls, index >= 0 ? index : 0);
});

// ========= Превью фото перед загрузкой =========
let _selectedFiles = []; // файлы выбранные для загрузки (форма «Добавить точку»)

document.getElementById("web-photos").addEventListener("change", async function(e) {
  var inp = e.target;
  var newFiles = inp.files ? Array.from(inp.files) : [];
  // Добавляем к уже выбранным, конвертируя HEIC→JPEG
  var heicSkipped = 0;
  for (var i = 0; i < newFiles.length; i++) {
    if (_selectedFiles.length >= 12) break;
    var file = await convertHeicIfNeeded(newFiles[i]);
    if (!file) { heicSkipped++; continue; }
    _selectedFiles.push(file);
  }
  inp.value = ""; // сбрасываем input чтобы можно было выбрать ещё
  _renderPhotoPreview();
  if (heicSkipped > 0) {
    showToast("HEIC-фото не удалось обработать. Попробуйте конвертировать в JPEG.", "error");
  }
});

function _renderPhotoPreview() {
  var container = document.getElementById("web-photos-preview");
  if (!container) return;

  // Освобождаем старые ObjectURL
  container.querySelectorAll("img").forEach(function(img) {
    if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
  });

  if (_selectedFiles.length === 0) {
    container.innerHTML = "";
    return;
  }

  var html = "";
  for (var i = 0; i < _selectedFiles.length; i++) {
    var url = URL.createObjectURL(_selectedFiles[i]);
    html += '<div class="mm-preview-item">'
      + '<img src="' + url + '" alt="">'
      + '<button class="mm-preview-remove" data-idx="' + i + '">&times;</button>'
      + '</div>';
  }
  container.innerHTML = html;

  // Обработчики удаления
  container.querySelectorAll(".mm-preview-remove").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var idx = Number(this.getAttribute("data-idx"));
      _selectedFiles.splice(idx, 1);
      _renderPhotoPreview();
    });
  });
}

// ========= Фото: добавить/удалить =========
let _mmUploadPlaceId = null;

document.addEventListener("click", async (e) => {
  // удалить фото (крестик)
  var delMediaBtn = e.target.closest(".mm-del-media-btn");
  if (delMediaBtn) {
    e.preventDefault();
    e.stopPropagation();

    var mediaId = delMediaBtn.getAttribute("data-media-id");
    if (!mediaId) return;

    if (!accessToken) { showToast("Сначала войдите.", "error"); return; }
    if (!await mmConfirm("Удалить фото?", { confirmText: "Удалить", isDanger: true })) return;

    // Сохраняем ссылки на DOM ДО await (после удаления wrapper будет недоступен)
    var wrapper = delMediaBtn.closest("div[style*='position:relative']");

    var resp = await apiFetch("/v1/media/" + mediaId, { method: "DELETE" });
    if (!resp.ok) { showToast("Не удалось удалить фото (код " + resp.status + ")", "error"); return; }

    // Sidebar edit path: обновляем _currentPlaces + перерисовываем edit panel
    if (_editingPlaceId) {
      var p = _currentPlaces.find(x => x.id === _editingPlaceId);
      if (p) {
        p.media = (p.media || []).filter(m => m.id !== Number(mediaId));
        renderEditPhotos(p);
      }
      return;
    }

    // Попап path: точечное обновление DOM попапа
    if (wrapper) {
      var photosContainer = wrapper.parentElement;
      wrapper.remove();
      if (photosContainer && !photosContainer.querySelector(".mm-photo-thumb")) {
        photosContainer.remove();
      }
    }
    return;
  }

  // добавить фото
  var addPhotoBtn = e.target.closest(".mm-add-photo-btn");
  if (addPhotoBtn) {
    e.preventDefault();
    e.stopPropagation();

    if (!accessToken) { showToast("Сначала войдите.", "error"); return; }

    var placeId = addPhotoBtn.getAttribute("data-id");
    var haveNow = Number(addPhotoBtn.getAttribute("data-have") || "0");
    var remaining = 12 - haveNow;

    if (!placeId) return;
    if (remaining <= 0) { showToast("Лимит фото достигнут.", "error"); return; }

    _mmUploadPlaceId = placeId;

    var inp = document.getElementById("mm-photo-input");
    inp.value = "";
    inp.setAttribute("data-remaining", String(remaining));
    inp.click();
    return;
  }
});

document.getElementById("mm-photo-input").addEventListener("change", async function(e) {
  var inp = e.target;
  var files = inp.files ? Array.from(inp.files) : [];
  if (!files.length) return;

  var remaining = Number(inp.getAttribute("data-remaining") || "0");
  var placeId = _mmUploadPlaceId;
  if (!placeId) return;

  if (files.length > remaining) {
    showToast("Можно добавить только " + remaining + " фото(шт).", "error");
    return;
  }

  // Собираем загруженные фото для точечного обновления DOM
  var newPhotos = [];
  try {
    for (var fi = 0; fi < files.length; fi++) {
      var file = await convertHeicIfNeeded(files[fi]);
      if (!file) continue; // HEIC без heic2any — пропускаем
      var ext = file.name.includes(".") ? file.name.split(".").pop() : "";
      var mime = file.type || "image/jpeg";

      var presignResp = await apiFetch("/v1/media/presign-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mime: mime, ext: ext, place_id: Number(placeId) }),
      });
      if (!presignResp.ok) throw new Error("presign " + presignResp.status);
      var u = await presignResp.json();

      var putResp = await fetch(u.url, {
        method: "PUT",
        headers: { "Content-Type": mime },
        body: file,
      });
      if (!putResp.ok) throw new Error("put " + putResp.status);

      var linkResp = await apiFetch("/v1/places/" + placeId + "/media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ temp_key: u.key }),
      });
      if (!linkResp.ok) throw new Error("link " + linkResp.status);

      var linkData = await linkResp.json();

      // Получаем presigned URL для отображения миниатюры
      var dlResp = await apiFetch("/v1/media/presign-download?key=" + encodeURIComponent(linkData.key));
      if (dlResp.ok) {
        var dl = await dlResp.json();
        newPhotos.push({ id: linkData.id, url: dl.url });
      }
    }

    // Точечное обновление DOM попапа вместо refresh()
    _updatePopupAfterUpload(placeId, newPhotos);
  } catch (err) {
    console.error(err);
    showToast("Ошибка при добавлении фото.", "error");
  } finally {
    _mmUploadPlaceId = null;
  }
});

// Добавляет загруженные фото в открытый попап/sidebar edit без refresh()
function _updatePopupAfterUpload(placeId, newPhotos) {
  if (!newPhotos.length) return;

  // Sidebar edit path: обновляем _currentPlaces + перерисовываем edit panel
  if (_editingPlaceId) {
    var p = _currentPlaces.find(x => x.id === Number(placeId));
    if (p) {
      if (!p.media) p.media = [];
      for (var ph of newPhotos) p.media.push(ph);
      renderEditPhotos(p);
    }
    return;
  }

  var popup = document.querySelector(".maplibregl-popup-content .mm-popup");
  if (!popup) return;

  // Ищем или создаём контейнер для фото
  var photosContainer = popup.querySelector("div[style*='flex-wrap']");
  if (!photosContainer) {
    photosContainer = document.createElement("div");
    photosContainer.style.cssText = "margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;";
    // Вставляем после кнопки «Добавить фото» или перед кнопкой комментариев
    var addBtnEl = popup.querySelector(".mm-add-photo-btn");
    if (addBtnEl && addBtnEl.parentElement) {
      addBtnEl.parentElement.after(photosContainer);
    } else {
      var commentsBtn = popup.querySelector(".mm-comments-btn");
      if (commentsBtn) {
        popup.insertBefore(photosContainer, commentsBtn);
      } else {
        popup.appendChild(photosContainer);
      }
    }
  }

  // Добавляем новые миниатюры (через DOM API — без innerHTML, без XSS-рисков)
  for (var i = 0; i < newPhotos.length; i++) {
    var ph = newPhotos[i];
    var imgEl = document.createElement("img");
    imgEl.src = ph.url;
    imgEl.setAttribute("data-full", ph.url);
    imgEl.className = "mm-photo-thumb";
    imgEl.style.cssText = "width:60px;height:60px;object-fit:cover;border-radius:6px;cursor:pointer;";

    var delBtn = document.createElement("button");
    delBtn.className = "mm-del-media-btn";
    delBtn.setAttribute("data-media-id", String(ph.id));
    delBtn.title = "Удалить";
    delBtn.style.cssText = "position:absolute;top:2px;right:2px;border:none;background:rgba(0,0,0,0.55);color:#fff;border-radius:9999px;width:18px;height:18px;cursor:pointer;";
    delBtn.textContent = "\u00d7";

    var div = document.createElement("div");
    div.style.cssText = "position:relative;width:60px;height:60px;";
    div.appendChild(imgEl);
    div.appendChild(delBtn);
    photosContainer.appendChild(div);
  }

  // Обновляем кнопку «Добавить фото»
  var addBtn = popup.querySelector(".mm-add-photo-btn");
  if (addBtn) {
    var have = Number(addBtn.getAttribute("data-have") || "0") + newPhotos.length;
    addBtn.setAttribute("data-have", String(have));
    if (have >= 12 && addBtn.parentElement) {
      addBtn.parentElement.style.display = "none";
    }
  }
}

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

      // Метка: новая точка или жалобы на approved-точку
      const label = p.moderation_status === "approved"
        ? '<span style="color:#C44B3F;font-weight:500;">\u26A0 Жалобы</span>'
        : '<span style="color:#6B8F7F;">Новая точка</span>';

      // Обрезаем описание до 100 символов для превью
      const notePreview = p.note && p.note.length > 100
        ? p.note.slice(0, 100) + "..."
        : p.note || "";

      // Превью фотографий
      const photos = (p.media || []).map(m =>
        `<img src="${escapeHtml(m.url)}" data-full="${escapeHtml(m.url)}" alt="фото"
          class="mm-photo-thumb"
          style="width:60px;height:60px;object-fit:cover;border-radius:4px;cursor:pointer;" />`
      ).join("");
      const photosHtml = photos
        ? `<div style="display:flex;gap:4px;margin-top:4px;">${photos}</div>`
        : "";

      // Жалобы на эту точку
      const reports = Array.isArray(p.reports) ? p.reports : [];
      const reportsHtml = reports.map((r, i) => {
        const who = r.user_login || r.username || `user#${r.user_id}`;
        const cat = escapeHtml(r.category_label || r.category);
        const comm = r.comment ? ": " + escapeHtml(r.comment) : "";
        const text = `Жалоба от @${escapeHtml(who)}: ${cat}${comm}`;
        // сворачиваем если текст длинный (>80 символов)
        const isLong = text.length > 80;
        const rid = `report-${p.id}-${i}`;
        return isLong
          ? `<div class="mm-report-line collapsed" id="${rid}">${text}</div>` +
            `<button class="mm-report-toggle" onclick="var el=document.getElementById('${rid}');if(el.classList.contains('collapsed')){el.classList.remove('collapsed');this.textContent='свернуть'}else{el.classList.add('collapsed');this.textContent='развернуть'}">развернуть</button>`
          : `<div class="mm-report-line">${text}</div>`;
      }).join("");

      return `
        <div style="padding:8px 0;border-bottom:1px solid #D6CFC5;overflow:hidden;">
          <div style="font-weight:500;overflow-wrap:break-word;word-break:break-word;">${escapeHtml(title)} <span style="font-size:12px;font-weight:400;margin-left:6px;">${label}</span></div>
          <div style="font-size:12px;color:#6B8F7F;overflow-wrap:break-word;word-break:break-word;">${escapeHtml(author)} \u00B7 ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</div>
          ${notePreview ? `<div style="font-size:12px;margin-top:2px;overflow-wrap:break-word;word-break:break-word;">${escapeHtml(notePreview)}</div>` : ""}
          ${reportsHtml}
          ${photosHtml}
          <div style="margin-top:6px;display:flex;gap:6px;">
            <button class="btn" style="font-size:12px;padding:2px 10px;"
              onclick="showPlaceOnMap(${p.id},${p.lon},${p.lat},${p.group_id})">На карте</button>
            <button class="btn btn-primary" style="font-size:12px;padding:2px 10px;"
              onclick="moderatePlace(${p.id},'approved')">Одобрить</button>
            <button class="btn" style="font-size:12px;padding:2px 10px;border-color:#C44B3F;color:#A33D33;"
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
  pendingCommentId = null; // showPlaceOnMap не открывает комментарии — сбрасываем
  map.flyTo({ center: [lon, lat], zoom: 16 });
  // Fallback: если карта уже на месте, flyTo не вызовет moveend
  setTimeout(() => {
    if (pendingPopupPlaceId !== null) refresh();
  }, 800);
  // Страховка: сбросить pending через 5 секунд если попап так и не открылся
  setTimeout(() => {
    if (pendingPopupPlaceId === placeId) {
      pendingPopupPlaceId = null;
      pendingPopupGroupId = null;
    }
  }, 5000);
}

/** Показать кратковременное уведомление внизу экрана
 * @param {string} msg — текст
 * @param {"info"|"error"|"success"} [type="info"] — тип (цвет)
 * @param {number} [duration] — ms, по умолчанию 2500 (error = 4000)
 */
function showToast(msg, type, duration) {
  const colors = { info: "#142E28", error: "#C44B3F", success: "#1B6B52" };
  const bg = colors[type] || colors.info;
  const ms = duration || (type === "error" ? 4000 : 2500);
  const el = document.createElement("div");
  el.textContent = msg.replace(/\.$/, "");
  el.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:${bg};color:#FAF6F0;padding:10px 24px;border-radius:10px;z-index:20000;font-size:14px;pointer-events:none;max-width:calc(100vw - 32px);text-align:center;box-shadow:0 8px 24px rgba(20,46,40,0.25);opacity:1;transition:opacity 0.3s;`;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; }, ms - 300);
  setTimeout(() => el.remove(), ms);
}

/** Копировать ссылку на точку в буфер обмена */
async function sharePlace(placeId) {
  // Закрываем dropdown
  document.querySelectorAll(".mm-popup-dropdown.open").forEach(el => el.classList.remove("open"));
  const url = `${location.origin}/?place=${placeId}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast("Ссылка скопирована");
  } catch {
    // fallback для HTTP или старых браузеров
    prompt("Скопируйте ссылку:", url);
  }
}

/** Попытка открыть точку из share-ссылки */
async function tryOpenSharedPlace() {
  if (!_pendingSharePlaceId) return;
  try {
    const resp = await apiFetch(`/v1/places/${encodeURIComponent(_pendingSharePlaceId)}`);
    if (resp.ok) {
      const data = await resp.json();
      _pendingSharePlaceId = null;
      history.replaceState(null, "", location.pathname);
      showPlaceOnMap(data.id, data.lon, data.lat, data.group_id);
    } else if (resp.status === 403) {
      if (accessToken) {
        // Залогинен, но нет доступа к группе — ретрай бесполезен
        showToast("У вас нет доступа к этой точке");
        _pendingSharePlaceId = null;
        history.replaceState(null, "", location.pathname);
      } else {
        // Не залогинен — возможно после логина доступ появится
        showToast("Войдите, чтобы увидеть эту точку");
      }
    } else if (resp.status === 404) {
      showToast("Точка не найдена");
      _pendingSharePlaceId = null;
      history.replaceState(null, "", location.pathname);
    } else {
      // другая ошибка — тихий сброс
      _pendingSharePlaceId = null;
      history.replaceState(null, "", location.pathname);
    }
  } catch (e) {
    console.error("Ошибка загрузки shared place:", e);
  }
}

let _moderating = false;
async function moderatePlace(placeId, status) {
  if (_moderating) return;
  _moderating = true;
  try {
    const resp = await apiFetch(`/v1/moderation/places/${placeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!resp.ok) {
      showToast("Ошибка модерации (код " + resp.status + ").", "error");
      return;
    }
    // обновляем очередь и карту
    loadModerationQueue();
    refresh();
  } catch (e) {
    console.error(e);
    showToast("Ошибка сети при модерации.", "error");
  } finally {
    _moderating = false;
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
  if (!newText) { showToast("Текст не может быть пустым.", "error"); return; }

  _editSaving = true;
  try {
    const resp = await apiFetch(`/v1/comments/${commentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: newText }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      let msg;
      if (data.detail === "edit_time_expired") msg = "Время редактирования истекло (1 час).";
      else if (resp.status === 422) msg = "Текст слишком длинный (макс. 1000 символов).";
      else msg = "Ошибка: " + (data.detail || resp.status);
      showToast(msg, "error");
      if (data.detail === "edit_time_expired" && _commentsPlaceId) await loadComments(_commentsPlaceId);
      return;
    }
    if (_commentsPlaceId) await loadComments(_commentsPlaceId);
  } catch (e) {
    console.error(e);
    showToast("Ошибка сети.", "error");
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
  if (!accessToken) { showToast("Сначала войдите.", "error"); return; }
  if (_commentSubmitting) return;

  const input = document.getElementById("comment-input");
  const statusEl = document.getElementById("comment-status");
  const text = (input?.value || "").trim();

  if (!text) {
    if (statusEl) { statusEl.innerText = "Введите текст комментария."; statusEl.style.color = "#A33D33"; }
    return;
  }

  _commentSubmitting = true;
  if (statusEl) { statusEl.innerText = "Отправка..."; statusEl.style.color = ""; }

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
      // Pydantic 422 возвращает detail как массив — обрабатываем отдельно
      if (resp.status === 422) {
        if (statusEl) { statusEl.innerText = "Текст слишком длинный (макс. 1000 символов)."; statusEl.style.color = "#A33D33"; }
        return;
      }
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
        "user_blocked": "Комментирование недоступно.",
      };
      if (statusEl) { statusEl.innerText = messages[msg] || `Ошибка: ${msg}`; statusEl.style.color = "#A33D33"; }
      return;
    }

    const result = await resp.json().catch(() => ({}));
    const newCommentId = result.comment?.id || null;

    if (input) input.value = "";
    if (statusEl) { statusEl.innerText = ""; statusEl.style.color = ""; }

    // Сбрасываем режим ответа
    cancelReply();

    // Проверяем, что модалка не была закрыта пока ждали ответ
    if (_commentsPlaceId === placeId) {
      await loadComments(placeId, newCommentId);
      updateCommentsCountInPopup(placeId);
    }
  } catch (e) {
    console.error(e);
    if (statusEl) { statusEl.innerText = "Ошибка сети."; statusEl.style.color = "#A33D33"; }
  } finally {
    _commentSubmitting = false;
  }
}

let _commentDeleting = false;
async function deleteComment(commentId) {
  // Закрываем меню
  document.querySelectorAll(".mm-popup-dropdown.open").forEach(el => el.classList.remove("open"));

  if (_commentDeleting) return;
  if (!await mmConfirm("Удалить комментарий?", { confirmText: "Удалить", isDanger: true })) return;

  _commentDeleting = true;
  const placeId = _commentsPlaceId;
  try {
    const resp = await apiFetch(`/v1/comments/${commentId}`, { method: "DELETE" });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      showToast("Ошибка: " + (data.detail || resp.status), "error");
      return;
    }
    if (placeId && _commentsPlaceId === placeId) {
      await loadComments(placeId);
      updateCommentsCountInPopup(placeId);
    }
  } catch (e) {
    console.error(e);
    showToast("Ошибка сети.", "error");
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
  btn.textContent = `${pluralRu(count, "Комментарий", "Комментария", "Комментариев")} (${count})`;
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
      let typeText;
      if (n.type === "reply_to_comment") {
        typeText = `<b>${esc(actor)}</b> — ответ на ваш комментарий к <b>"${esc(placeTitle)}"</b>`;
      } else {
        typeText = `<b>${esc(actor)}</b> — новый комментарий к вашей точке <b>"${esc(placeTitle)}"</b>`;
      }

      return `
        <div class="notif-item notif-item--unread" onclick="goToNotification(${n.place_id}, ${n.comment_id != null ? n.comment_id : "null"}, ${n.id}, ${n.place_group_id != null ? n.place_group_id : "null"}, ${n.place_lat != null ? n.place_lat : "null"}, ${n.place_lon != null ? n.place_lon : "null"})">
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
    showToast("Ошибка сети.", "error");
  }
}

/** Перейти к точке из уведомления */
async function goToNotification(placeId, commentId, notifId, groupId, lat, lon) {
  // Помечаем прочитанным
  if (notifId) markNotificationRead(notifId);

  // Закрываем модалку уведомлений
  closeFriendRequestsModal();

  if (!placeId) {
    showToast("Точка была удалена.", "info");
    return;
  }

  // Перелетаем к точке
  pendingPopupPlaceId = placeId;
  pendingPopupGroupId = groupId || null;
  pendingCommentId = commentId || null;

  // Координаты: из маркера на карте или из данных уведомления
  const marker = markersByPlaceId[placeId];
  let center;
  if (marker) {
    const lngLat = marker.getLngLat();
    center = [lngLat.lng, lngLat.lat];
  } else if (lat != null && lon != null) {
    center = [lon, lat];
  } else {
    // Нет ни маркера, ни координат — обновим карту, дадим одну попытку открыть попап;
    // после завершения refresh сбросим pending, т.к. без flyTo повторных попыток не будет
    refresh().finally(() => {
      if (pendingPopupPlaceId === placeId) {
        pendingPopupPlaceId = null;
        pendingPopupGroupId = null;
        pendingCommentId = null;
      }
    });
    return;
  }

  map.flyTo({ center, zoom: Math.max(map.getZoom(), 16) });
  // Fallback: если карта уже на месте или перелёт долгий
  setTimeout(() => {
    if (pendingPopupPlaceId !== null) refresh();
  }, 2000);
  // Страховка: сбросить pending через 5 секунд если попап так и не открылся
  setTimeout(() => {
    if (pendingPopupPlaceId === placeId) {
      pendingPopupPlaceId = null;
      pendingPopupGroupId = null;
      pendingCommentId = null;
    }
  }, 5000);
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

let _submittingReport = false;
async function submitReport() {
  if (!_reportPlaceId) return;
  if (!accessToken) { showToast("Сначала войдите.", "error"); return; }

  const statusEl = document.getElementById("report-status");
  const selected = document.querySelector('input[name="report-category"]:checked');
  const category = selected ? selected.value : "other";
  const comment = (document.getElementById("report-comment")?.value || "").trim() || null;

  // Для категории «Другое» комментарий обязателен
  if (category === "other" && !comment) {
    if (statusEl) { statusEl.innerText = "Для категории «Другое» укажите комментарий."; statusEl.style.color = "#A33D33"; }
    return;
  }

  if (_submittingReport) return;
  _submittingReport = true;

  if (statusEl) { statusEl.innerText = "Отправка..."; statusEl.style.color = ""; }

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
        "place_not_approved": "Точка не одобрена.",
        "comment_too_long": "Комментарий слишком длинный (макс. 1000 символов).",
        "invalid_category": "Некорректная категория.",
      };
      if (statusEl) { statusEl.innerText = messages[msg] || `Ошибка: ${msg}`; statusEl.style.color = "#A33D33"; }
      return;
    }

    closeReportModal();
    refresh();
  } catch (e) {
    console.error(e);
    if (statusEl) { statusEl.innerText = "Ошибка сети."; statusEl.style.color = "#A33D33"; }
  } finally {
    _submittingReport = false;
  }
}

// Делегированный обработчик для кнопок с data-action (защита от XSS в onclick)
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  const name = btn.dataset.name || "";
  const userId = btn.dataset.userId ? +btn.dataset.userId : null;

  if (action === "remove-friend" && userId) confirmRemoveFriend(userId, name);
  if (action === "block-user" && userId) confirmBlockUser(userId, name);
  if (action === "decline-block") {
    const requestId = btn.dataset.requestId ? +btn.dataset.requestId : null;
    if (requestId && userId) declineAndBlockUser(requestId, userId, name);
  }
  if (action === "remove-member") {
    const groupId = btn.dataset.groupId ? +btn.dataset.groupId : null;
    if (groupId && userId) removeLayerMember(groupId, userId, name);
  }
});

// Закрытие dropdown-меню по клику вне (все dropdown теперь используют .open)
document.addEventListener("click", (e) => {
  document.querySelectorAll(".mm-popup-dropdown.open").forEach(dd => {
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
  const list = _adminUsersList || [];
  const q = (document.getElementById("admin-search")?.value || "").trim().toLowerCase();
  if (!q) {
    renderAdminUsers(list);
    return;
  }
  const filtered = list.filter(u =>
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
      ? `<span style="font-size:12px;color:#1B6B52;font-weight:500;">Админ</span>`
      : `<select ${disabled} style="font-size:12px;padding:2px 6px;border-radius:6px;border:1px solid #C5B9A8;width:100%;"
          onchange="changeUserRole(${u.id}, this.value)">${options}</select>`;

    return `
      <div style="padding:6px 0;border-bottom:1px solid #D6CFC5;">
        <div style="font-weight:500;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(u.login || "—")}</div>
        <div style="font-size:11px;color:#6B8F7F;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(u.email || "нет email")}</div>
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
      showToast("Ошибка: " + (data.detail || resp.status), "error");
      loadAdminUsers(); // откатываем select к реальному значению
      return;
    }
    // обновляем список
    loadAdminUsers();
  } catch (e) {
    console.error(e);
    showToast("Ошибка сети.", "error");
  }
}

initAuthFromStorage();

// периодически обновляем счетчик уведомлений и список друзей
setInterval(async () => {
  if (!accessToken) return;
  try {
    await refreshUserSnapshot();
    updateNotifBadge();
    updateModerationBadge();

    // C13: проверить роль, скрыть/показать таб модерации
    const isMod = currentUser && (currentUser.role === "admin" || currentUser.role === "moderator");
    const tabBtnMod = document.getElementById("tab-btn-moderation");
    if (tabBtnMod) tabBtnMod.style.display = isMod ? "" : "none";
    // Если текущий таб = moderation и роль user → переключиться на layers
    if (!isMod && _currentTab === "moderation") {
      _currentTab = "layers";
      switchTab("layers");
    }

    // Панель администратора
    const adminPanel = document.getElementById("admin-panel");
    if (adminPanel) {
      adminPanel.style.display = (currentUser && currentUser.role === "admin") ? "" : "none";
    }

    refreshFriendsUI();
    renderGroupLayersUI();
    populateAddGroupSelect();
    await loadFriendRequestsListsSafe();
    maybeRefreshSearchResults();
  } catch (e) { /* ignore */ }
}, 8000);

function maybeRefreshSearchResults() {
  // Не перезапускаем поиск автоматически — пользователь сам нажмёт «Найти».
  // Автообновление вызывало мерцание результатов каждые 8 секунд.
}

map.on("load", async () => {
  await refresh();
  // Обработка share-ссылки: ?place=123
  const urlParams = new URLSearchParams(location.search);
  const sp = urlParams.get("place");
  if (sp) {
    _pendingSharePlaceId = sp;
    await tryOpenSharedPlace();
  }
});
let _refreshTimer = null;
map.on("moveend", () => {
  clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(refresh, 300);
});

// --- Layer destructive actions ---
let _leavingLayer = false;
async function leaveLayer(groupId, placeCount) {
  if (_leavingLayer) return;
  if (!accessToken) { showToast("Сначала войдите.", "error"); return; }
  const pc = Number(placeCount) || 0;
  const msg = pc > 0
    ? `В слое ${pc} ${pluralRu(pc, "точка", "точки", "точек")}. Они останутся в слое, но вы потеряете к ним доступ. Выйти?`
    : "Точно выйти из слоя?";
  if (!await mmConfirm(msg, { confirmText: "Выйти", isDanger: true })) return;
  _leavingLayer = true;
  try {
    const resp = await apiFetch(`/v1/groups/${groupId}/leave`, { method: "POST" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      showToast("Не удалось выйти: " + (data.detail || resp.status), "error");
      return;
    }
    if (_layerCardsPanelGroupId === groupId) closeLayerCardsPanel();
    await refreshUserSnapshot();
    if (selectedGroupLayerIds.has(groupId)) selectedGroupLayerIds.delete(groupId);
    renderGroupLayersUI();
    populateAddGroupSelect();
    closeLayersModal();
    refresh();
  } catch (e) {
    console.error(e);
    showToast("Ошибка сети.", "error");
  } finally {
    _leavingLayer = false;
  }
}

let _deletingLayer = false;
async function deleteLayer(groupId) {
  if (_deletingLayer) return;
  if (!accessToken) { showToast("Сначала войдите.", "error"); return; }
  let name = `слой ${groupId}`;
  try {
    const g = ((currentUser && currentUser.groups) || []).find(x => x.id === groupId);
    if (g && (g.name || g.title)) name = g.name || g.title;
  } catch (_) {}

  if (!await mmConfirm(`Точно хотите удалить слой "${name}"? Все точки этого слоя будут удалены.`, { confirmText: "Удалить", isDanger: true })) return;
  _deletingLayer = true;
  try {
    const resp = await apiFetch(`/v1/groups/${groupId}`, { method: "DELETE" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      showToast("Не удалось удалить слой: " + (data.detail || resp.status), "error");
      return;
    }
    if (_layerCardsPanelGroupId === groupId) closeLayerCardsPanel();
    await refreshUserSnapshot();
    if (selectedGroupLayerIds.has(groupId)) selectedGroupLayerIds.delete(groupId);
    renderGroupLayersUI();
    populateAddGroupSelect();
    closeLayersModal();
    refresh();
  } catch (e) {
    console.error(e);
    showToast("Ошибка сети.", "error");
  } finally {
    _deletingLayer = false;
  }
}

// ===================== Панель карточек слоя =====================

let _layerCardsPanelGroupId = null;

/** Открыть/закрыть панель с карточками точек слоя (toggle) */
async function openLayerCardsPanel(groupId) {
  // Toggle: повторный клик закрывает
  if (_layerCardsPanelGroupId === groupId) {
    closeLayerCardsPanel();
    return;
  }

  const panel = document.getElementById("layer-cards-panel");
  const titleEl = document.getElementById("layer-cards-title");
  const listEl = document.getElementById("layer-cards-list");
  if (!panel || !listEl) return;

  // Определяем название слоя
  const g = ((currentUser && currentUser.groups) || []).find(x => x.id === groupId);
  const layerName = (personalGroupId && groupId === personalGroupId)
    ? "Личная карта"
    : (g ? (g.name || `Слой ${groupId}`) : `Слой ${groupId}`);
  if (titleEl) titleEl.textContent = layerName;

  _layerCardsPanelGroupId = groupId;
  listEl.innerHTML = '<div class="hint" style="text-align:center;padding:20px;">Загрузка…</div>';
  panel.style.display = "";
  document.querySelector(".app")?.classList.add("layer-panel-open");

  try {
    const resp = await apiFetch(`/v1/places/feed?group_ids=${groupId}&bbox=-180,-90,180,90`);
    if (!resp.ok) {
      listEl.innerHTML = '<div class="hint" style="text-align:center;padding:20px;">Ошибка загрузки.</div>';
      return;
    }
    const data = await resp.json().catch(() => ({}));
    const places = Array.isArray(data.items) ? data.items : [];

    // Проверяем что панель всё ещё открыта для этого слоя (мог закрыть пока шёл запрос)
    if (_layerCardsPanelGroupId !== groupId) return;

    if (places.length === 0) {
      listEl.innerHTML = '<div class="hint" style="text-align:center;padding:20px;">В этом слое пока нет точек.</div>';
      return;
    }

    listEl.innerHTML = places.map(p => {
      const title = escapeHtml(p.title || `${Number(p.lat).toFixed(5)}, ${Number(p.lon).toFixed(5)}`);
      const note = p.note ? escapeHtml(p.note) : "";
      const author = escapeHtml(p.user_login || "");
      const media = Array.isArray(p.media) ? p.media : [];
      const thumb = media.length > 0 ? media[0].url : null;
      const thumbHtml = thumb
        ? `<img class="layer-place-card-thumb" src="${escapeHtml(thumb)}" loading="lazy" />`
        : "";
      return `<div class="layer-place-card" onclick="flyToPlace(${p.id}, ${p.lon}, ${p.lat})">
        <div style="display:flex;gap:10px;">
          ${thumbHtml}
          <div style="min-width:0;flex:1;">
            <div class="layer-place-card-title">${title}</div>
            ${note ? `<div class="layer-place-card-note">${note}</div>` : ""}
            ${author ? `<div class="layer-place-card-author">${author}</div>` : ""}
          </div>
        </div>
      </div>`;
    }).join("");
  } catch (e) {
    console.error(e);
    if (_layerCardsPanelGroupId === groupId) {
      listEl.innerHTML = '<div class="hint" style="text-align:center;padding:20px;">Ошибка сети.</div>';
    }
  }
}

function closeLayerCardsPanel() {
  _layerCardsPanelGroupId = null;
  const panel = document.getElementById("layer-cards-panel");
  if (panel) panel.style.display = "none";
  document.querySelector(".app")?.classList.remove("layer-panel-open");
}

/** Обновить панель карточек если открыта (без toggle) */
function refreshLayerCardsPanel() {
  if (_layerCardsPanelGroupId !== null) {
    const gid = _layerCardsPanelGroupId;
    _layerCardsPanelGroupId = null; // сброс чтобы openLayerCardsPanel не сделал toggle
    openLayerCardsPanel(gid);
  }
}

/** Перелететь к точке и открыть попап */
function flyToPlace(placeId, lon, lat) {
  pendingPopupPlaceId = placeId;
  // Гарантируем включение группы в feed-запрос (если видимость слоя выключена)
  pendingPopupGroupId = _layerCardsPanelGroupId || null;
  // padding.top сдвигает точку в нижнюю часть карты — попап не вылезает за header
  map.flyTo({ center: [lon, lat], zoom: 16, padding: { top: 220 } });
  // Fallback: если карта уже на месте, flyTo не вызовет moveend
  setTimeout(() => {
    if (pendingPopupPlaceId !== null) refresh();
  }, 800);
  // Страховка: сбросить pending через 5 секунд если попап так и не открылся
  setTimeout(() => {
    if (pendingPopupPlaceId === placeId) {
      pendingPopupPlaceId = null;
      pendingPopupGroupId = null;
    }
  }, 5000);
}
