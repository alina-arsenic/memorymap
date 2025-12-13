const API_BASE = ""; // тот же origin (http://localhost:8000)
const LS_TOKEN = "mm_token";

let accessToken = null;
let currentUser = null; // объект из /v1/me
let currentMarkers = [];       // ссылки на Marker, чтобы их удалять

let tempMarker = null; // временный жёлтый маркер
let tempCoords = null; // { lng, lat } последнего ПКМ

async function apiFetch(path, { method = "GET", headers = {}, body = null } = {}) {
  const h = { ...headers };
  if (accessToken) h["Authorization"] = "Bearer " + accessToken;
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: h,
    body,
  });
  return resp;
}

function createPin(isMine, overrideColor) {
const color = overrideColor || (isMine ? "#10b981" : "#3b82f6"); // зелёный свои, синий чужие

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

  // если токена нет — сразу UI в "гость"
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

  if (userTitle) userTitle.innerText = `Привет, ${nick}!`;
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
    alert("Неверный логин или пароль.");
    return;
  }

  const data = await resp.json();
  accessToken = data.access_token;
  localStorage.setItem(LS_TOKEN, accessToken);

  await loadMe();
  refresh();
}

async function uiRegister() {
  const login = (document.getElementById("login-input").value || "").trim();
  const password = document.getElementById("password-input").value || "";

  if (!login || !password) {
    alert("Введите логин и пароль.");
    return;
  }

  if (password.length < 8) {
    alert("Пароль должен быть не короче 8 символов.");
    return;
  }

  const resp = await fetch(`${API_BASE}/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login, password }),
  });

  if (resp.status === 409) {
    alert("Логин занят.");
    return;
  }
  if (!resp.ok) {
    alert("Ошибка регистрации.");
    return;
  }

  // сразу логиним
  await uiLogin();
}

function uiLogout() {
  accessToken = null;
  currentUser = null;
  localStorage.removeItem(LS_TOKEN);

  // вернуть верхнюю надпись
  const userTitle = document.getElementById("user-title");
  if (userTitle) userTitle.innerText = "Пользователь";

  // UI в "гость"
  applyAuthUI(false);

  // tg блоки спрячем
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
    if (tgCode) tgCode.innerText = `Отправьте боту:\n/link ${data.code}`;

    // ждём привязку (без перезагрузки страницы)
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

    // 1) просим пресайн для загрузки
    const presignResp = await apiFetch("/v1/media/presign-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mime, ext }),
    });
    if (!presignResp.ok) {
    throw new Error("presign-upload failed: " + presignResp.status);
    }
    const u = await presignResp.json(); // { key, url, expires_in }

    // 2) заливаем файл в MinIO
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

// жёлтый пин
const el = createPin(false, "#facc15"); // жёлтый цвет

tempMarker = new maplibregl.Marker({ element: el, anchor: "bottom" })
    .setLngLat([tempCoords.lng, tempCoords.lat])
    .addTo(map);

const status = document.getElementById("web-add-status");
if (status) {
    status.innerText = "Временная точка выбрана.";
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
      response = await fetch(`${API_BASE}/v1/places?group_id=1&bbox=${bbox}`);
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
      const el = createPin(p.isMine);

      const who = p.isMine
          ? "Моя точка"
          : (p.user_login ? p.user_login : (p.username ? ("@" + p.username) : "Аноним"));

      const displayTitle =
      p.title && p.title.trim()
          ? p.title
          : `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;

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

      // очень важно: экранируем кавычки, иначе атрибут data-initial сломается
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
  });

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

initAuthFromStorage();
map.on("load", refresh);
map.on("moveend", refresh);
