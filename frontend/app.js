const API_BASE = ""; // тот же origin (http://localhost:8000)
const LS_TOKEN = "mm_token";

let accessToken = null;
let currentUser = null;  // объект из /v1/me
let currentMarkers = []; // ссылки на Marker, чтобы их удалять
let markersByPlaceId = {}; // {place_id: Marker} — для открытия попапа из панели модерации
let pendingPopupPlaceId = null; // placeId для открытия попапа после refresh

let tempMarker = null; // временный желтый маркер
let tempCoords = null; // { lng, lat } последнего ПКМ

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

function applyAuthUI(isAuthed) {
  const authForm = document.getElementById("auth-form");
  const logoutBtn = document.getElementById("logout-btn");
  const authedOnly = document.getElementById("authed-only");

  if (authForm) authForm.style.display = isAuthed ? "none" : "";
  if (logoutBtn) logoutBtn.style.display = isAuthed ? "" : "none";
  if (authedOnly) authedOnly.style.display = isAuthed ? "" : "none";

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
}

async function uiLogin() {
  const login = (document.getElementById("login-input").value || "").trim();
  const password = document.getElementById("password-input").value || "";

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
  const login = (document.getElementById("login-input").value || "").trim();
  const email = (document.getElementById("email-input").value || "").trim();
  const password = document.getElementById("password-input").value || "";

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
  document.getElementById("auth-form").style.display = "none";
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
  document.getElementById("auth-form").style.display = "";
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

  const loginInput = document.getElementById("login-input");
  const passInput = document.getElementById("password-input");
  if (loginInput) loginInput.value = "";
  if (passInput) passInput.value = "";

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

const body = {
  group_id: 1,
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

  if (!showPublic && !showMy) {
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

  let response;
  try {
      // все точки физически лежат в группе 1 (публичная группа)
      // передаём токен, чтобы бэкенд показал свои pending-точки
      response = await apiFetch(`/v1/places?group_id=1&bbox=${bbox}`);
  } catch (e) {
      console.error(e);
      setStatus("Ошибка соединения с API", true);
      return;
  }

  if (!response.ok) {
      console.error("Bad status:", response.status);
      setStatus("Ошибка API: " + response.status, true);
      return;
  }

  const data = await response.json();
  const items = data.items || [];

  const myUserId = currentUser?.id != null ? String(currentUser.id) : null;
  const filtered = [];

  for (const p of items) {
      const ownerUserId = p.user_id != null ? String(p.user_id) : null;
      const isMine = myUserId && ownerUserId && ownerUserId === myUserId;

      if (showPublic && showMy) {
      filtered.push({ ...p, isMine });
      } else if (showMy && !showPublic) {
      if (isMine) {
          filtered.push({ ...p, isMine: true });
      }
      } else if (showPublic && !showMy) {
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
map.on("load", refresh);
map.on("moveend", refresh);
