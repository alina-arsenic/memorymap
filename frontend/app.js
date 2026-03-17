const API_BASE = ""; // тот же origin (http://localhost:8000)
const LS_TOKEN = "mm_token";

let accessToken = null;
let currentUser = null;  // объект из /v1/me
let currentMarkers = []; // ссылки на Marker, чтобы их удалять
let markersByPlaceId = {}; // {place_id: Marker} — для открытия попапа из панели модерации
let pendingPopupPlaceId = null; // placeId для открытия попапа после refresh

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

/** Переключиться на форму входа */
function showLoginForm() {
  const login = document.getElementById("login-form");
  const reg = document.getElementById("register-form");
  const verify = document.getElementById("verify-form");
  if (login) login.style.display = "";
  if (reg) reg.style.display = "none";
  if (verify) verify.style.display = "none";
}

/** Переключиться на форму регистрации */
function showRegisterForm() {
  const login = document.getElementById("login-form");
  const reg = document.getElementById("register-form");
  const verify = document.getElementById("verify-form");
  if (login) login.style.display = "none";
  if (reg) reg.style.display = "";
  if (verify) verify.style.display = "none";
}

function applyAuthUI(isAuthed) {
  const loginForm = document.getElementById("login-form");
  const registerForm = document.getElementById("register-form");
  const verifyForm = document.getElementById("verify-form");
  const logoutBtn = document.getElementById("logout-btn");
  const authedOnly = document.getElementById("authed-only");

  if (isAuthed) {
    if (loginForm) loginForm.style.display = "none";
    if (registerForm) registerForm.style.display = "none";
    if (verifyForm) verifyForm.style.display = "none";
  } else {
    showLoginForm();
  }
  const deleteBtn = document.getElementById("delete-account-btn");
  if (logoutBtn) logoutBtn.style.display = isAuthed ? "" : "none";
  if (deleteBtn) deleteBtn.style.display = isAuthed ? "" : "none";
  if (authedOnly) authedOnly.style.display = isAuthed ? "" : "none";


  const notifBtn = document.getElementById("notif-btn");
  const notifBadge = document.getElementById("notif-badge");
  if (notifBtn) notifBtn.style.display = isAuthed ? "" : "none";
  if (!isAuthed) {
    if (notifBadge) { notifBadge.innerText = "0"; notifBadge.style.display = "none"; }
    closeFriendRequestsModal(true);
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
  const login = (document.getElementById("login-input").value || "").trim();
  const password = document.getElementById("login-password-input").value || "";

  if (!login || !password) {
    alert("Введите логин и пароль.");
    return;
  }

  const resp = await fetch(`${API_BASE}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login, password }),
  });

  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    if (resp.status === 403 && errData.detail === "email_not_verified") {
      alert("Email не подтверждён. Проверьте почту или зарегистрируйтесь заново.");
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
}

// email, на который отправлен код (запоминаем для verify/resend)
let _pendingVerifyEmail = null;

async function uiRegister() {
  const login = (document.getElementById("reg-login-input").value || "").trim();
  const email = (document.getElementById("reg-email-input").value || "").trim();
  const password = document.getElementById("reg-password-input").value || "";

  if (!login || !password || !email) {
    alert("Заполните логин, email и пароль.");
    return;
  }

  if (password.length < 8) {
    alert("Пароль должен быть не короче 8 символов.");
    return;
  }

  const resp = await fetch(`${API_BASE}/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login, password, email }),
  });

  if (resp.status === 409) {
    const data = await resp.json().catch(() => ({}));
    if (data.detail === "email_taken") {
      alert("Этот email уже зарегистрирован.");
    } else {
      alert("Логин занят.");
    }
    return;
  }
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    if (data.detail === "invalid_email") {
      alert("Некорректный формат email.");
    } else {
      alert("Ошибка регистрации.");
    }
    return;
  }

  // показываем форму подтверждения email
  _pendingVerifyEmail = email;
  document.getElementById("register-form").style.display = "none";
  document.getElementById("verify-form").style.display = "";
  document.getElementById("verify-email-display").innerText = email;
  document.getElementById("verify-status").innerText = "";
}

async function uiVerifyEmail() {
  const code = (document.getElementById("verify-code-input").value || "").trim();
  const statusEl = document.getElementById("verify-status");

  if (!code || !_pendingVerifyEmail) {
    statusEl.innerText = "Введите код из письма.";
    return;
  }

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

  // email подтверждён — скрываем форму верификации, показываем логин
  _pendingVerifyEmail = null;
  document.getElementById("verify-form").style.display = "none";
  document.getElementById("login-form").style.display = "";
  document.getElementById("verify-code-input").value = "";

  alert("Email подтверждён! Теперь войдите в аккаунт.");
}

async function uiResendCode() {
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
    statusEl.innerText = "Не удалось отправить код.";
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

  const n = (currentUser && typeof currentUser.friend_requests_inbox_count === "number")
    ? currentUser.friend_requests_inbox_count
    : 0;

  badge.innerText = String(n);
  badge.style.display = n > 0 ? "" : "none";
}

function refreshFriendsUI() {
  const listEl = document.getElementById("friends-list");
  if (!listEl) return;

  const friends = (currentUser && Array.isArray(currentUser.friends)) ? currentUser.friends : [];
  if (friends.length === 0) {
    listEl.innerHTML = `<div class="hint">Пока друзей нет.</div>`;
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
    return `
      <div class="list-item">
        <div class="meta">
          <div class="title">${title}</div>
          <div class="sub">${sub || ""}</div>
        </div>
        <div class="actions">
          <button class="btn btn-ghost btn-icon" title="Удалить из друзей" onclick="confirmRemoveFriend(${u.id}, '${escapeHtml(displayName)}')">✕</button>
        </div>
      </div>
    `;
  }).join("");
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

    // add selected friends as editors
    for (const uid of checked) {
      await apiFetch(`/v1/groups/${gid}/members`, {
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
    const addable = friends.filter(f => !memberIds.has(f.id));

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

    const addSection = (isOwner && !isPersonal) ? `
      <div class="divider" style="margin:12px 0;"></div>
      <div class="field-label">Добавить друга</div>
      <div style="display:flex;gap:8px;align-items:center;">
        <select id="layer-add-user" class="input" style="flex:1;">
          ${addFriendOptions || ""}
        </select>
        <select id="layer-add-role" class="input" style="width:140px;">
          <option value="editor">editor</option>
          <option value="viewer">viewer</option>
        </select>
        <button class="btn btn-primary" onclick="addLayerMember(${groupId})" ${addable.length ? "" : "disabled"}>Добавить</button>
      </div>
      <div class="hint" style="margin-top:6px;">Добавлять можно только друзей.</div>
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

  // опционально: очистка списков
  const inbox = document.getElementById("inbox-requests");
  const outbox = document.getElementById("outbox-requests");
  if (inbox) inbox.innerHTML = "";
  if (outbox) outbox.innerHTML = "";

  if (!silent) {
    // ничего
  }
}

async function loadFriendRequestsLists() {
  const inbox = document.getElementById("inbox-requests");
  const outbox = document.getElementById("outbox-requests");
  if (!inbox || !outbox) return;

  inbox.innerHTML = `<div class="hint">Загрузка…</div>`;
  outbox.innerHTML = `<div class="hint">Загрузка…</div>`;

  try {
    const [inResp, outResp] = await Promise.all([
      apiFetch("/v1/friends/requests?inbox=1&status=pending"),
      apiFetch("/v1/friends/requests?outbox=1&status=pending"),
    ]);

    const inData = await inResp.json().catch(() => ({}));
    const outData = await outResp.json().catch(() => ({}));

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

          return `
            <div class="list-item">
              <div class="meta">
                <div class="title">${title}</div>
                <div class="sub">${sub || ""}</div>
              </div>
              <div class="actions">
                <button class="btn btn-primary" onclick="acceptFriendRequest(${r.id})">Принять</button>
                <button class="btn" onclick="declineFriendRequest(${r.id})">Отклонить</button>
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

    // обновим счетчик (на случай если приняли с другого устройства)
    await refreshUserSnapshot();
    updateNotifBadge();
    refreshFriendsUI();
  } catch (e) {
    console.error(e);
    inbox.innerHTML = `<div class="hint">Ошибка сети.</div>`;
    outbox.innerHTML = `<div class="hint">Ошибка сети.</div>`;
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

  if (!showPublic && !showMy && extraSelected.length === 0) {
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

      // плашка «На модерации» для pending-точек
      const pendingBadge = isPending
        ? `<div style="margin-top:4px;padding:2px 8px;background:#f3f4f6;color:#6b7280;border-radius:9999px;font-size:11px;display:inline-block;">На модерации</div>`
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

      const popupHtml = `
        <div class="mm-popup">
          ${titleBlock}
          ${noteBlock}
          <div style="margin-top:6px;font-size:11px;color:#6b7280;">${who}</div>
          ${pendingBadge}
          ${moderationBtns}
          ${addBtnHtml}
          ${photosHtml}
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
    }
    pendingPopupPlaceId = null;
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

      return `
        <div style="padding:8px 0;border-bottom:1px solid #e5e7eb;">
          <div style="font-weight:500;">${esc(title)}</div>
          <div style="font-size:12px;color:#6b7280;">${esc(author)} · ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</div>
          ${notePreview ? `<div style="font-size:12px;margin-top:2px;">${esc(notePreview)}</div>` : ""}
          ${photosHtml}
          <div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap;">
            <button class="btn" style="font-size:12px;padding:2px 10px;"
              onclick="showPlaceOnMap(${p.id},${p.lon},${p.lat})">Показать на карте</button>
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
function showPlaceOnMap(placeId, lon, lat) {
  // закрываем любые открытые попапы
  currentMarkers.forEach(m => {
    const popup = m.getPopup();
    if (popup && popup.isOpen()) {
      popup.remove();
    }
  });

  // сохраняем id для открытия попапа после refresh (который вызовется при moveend)
  pendingPopupPlaceId = placeId;
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
