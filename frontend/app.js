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

async function initAuthFromStorage() {
  const saved = localStorage.getItem(LS_TOKEN);
  if (!saved) return;
  accessToken = saved;
  await loadMe(); // если токен протух — сбросим ниже
}

async function loadMe() {
  const info = document.getElementById("user-info");
  const authForm = document.getElementById("auth-form");
  const tgBtn = document.getElementById("tg-link-btn");
  const tgEl = document.getElementById("tg-link-code");

  const resp = await apiFetch("/v1/me");

  // НЕ АВТОРИЗОВАНЫ / ТОКЕН ПРОТУХ
  if (!resp.ok) {
    accessToken = null;
    currentUser = null;
    localStorage.removeItem(LS_TOKEN);

    if (info) info.innerText = "Не авторизованы";
    if (authForm) authForm.style.display = ""; // показываем форму
    if (tgBtn) tgBtn.style.display = "none";
    if (tgEl) tgEl.innerText = "";
    return;
  }

  // УСПЕШНО
  currentUser = await resp.json();

  const nick = currentUser.login || ("user#" + currentUser.id);
  if (info) {
    info.innerText = `Вы вошли как ${nick}`;
  }

  // прячем форму логина/регистрации
  if (authForm) authForm.style.display = "none";

  // Telegram статус
  if (currentUser.tg_id) {
    if (tgBtn) tgBtn.style.display = "none";
    if (tgEl) tgEl.innerText = `Привязан Telegram ID: ${currentUser.tg_id}`;
  } else {
    if (tgBtn) tgBtn.style.display = "";
    if (tgEl) tgEl.innerText = "Telegram не привязан.";
  }
}

async function uiLogin() {
  const login = document.getElementById("login-input").value.trim();
  const password = document.getElementById("password-input").value;
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
  const login = document.getElementById("login-input").value.trim();
  const password = document.getElementById("password-input").value;
  if (!login || !password) {
    alert("Введите логин и пароль.");
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
  // 1. убрать токен и пользователя
  accessToken = null;
  currentUser = null;
  localStorage.removeItem(LS_TOKEN);

  // 2. показать форму логина
  const authForm = document.getElementById("auth-form");
  if (authForm) authForm.style.display = "";

  // 3. обновить UI (user-info, tg-блоки и т.д.)
  loadMe();
}

async function startTelegramLink() {
  if (!accessToken) {
    alert("Сначала войдите.");
    return;
  }
  const el = document.getElementById("tg-link-code");
  el.innerText = "Генерирую код...";
  const resp = await apiFetch("/v1/me/telegram-link/start", { method: "POST" });
  if (!resp.ok) {
    el.innerText = "Ошибка генерации кода.";
    return;
  }
  const data = await resp.json();
  el.innerText = `Код: ${data.code}. Отправьте боту: /link ${data.code}`;
}

function fakeLogin() {
const v = document.getElementById("user-id-input").value.trim();
if (!v) {
    alert("Введи свой Telegram ID (узнать через /whoami в боте).");
    return;
}
currentUserId = v;
localStorage.setItem(LS_KEY, currentUserId);
document.getElementById("user-info").innerText =
    "Вы авторизованы как Telegram ID " + currentUserId +
    ". Точки, добавленные через бота, воспринимаются как ваши.";
refresh();
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

const title = titleInput ? titleInput.value.trim() : "";
const note = noteInput ? noteInput.value.trim() : "";
const files = photosInput && photosInput.files ? Array.from(photosInput.files) : [];

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
    title: title || null,
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
    e.originalEvent.preventDefault(); // убираем контекстное меню браузера
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
    status.innerText = "Временная точка выбрана. Заполните поля и нажмите «Добавить точку».";
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
        return `<img src="${safeUrl}"
                    data-full="${safeUrl}"
                    class="mm-photo-thumb"
                    style="width:60px;height:60px;object-fit:cover;border-radius:6px;cursor:pointer;margin-right:4px;margin-top:4px;" />`;
    }).join("");

    photosHtml = `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;">${thumbs}</div>`;
    }

    const popupHtml = `
    <div class="mm-popup">
        <div class="mm-popup-title">${displayTitle}</div>
        <div class="mm-popup-note">${p.note || ""}</div>
        <div style="margin-top:6px;font-size:11px;color:#6b7280;">${who}</div>
        ${deleteButtonHtml}
        ${photosHtml}
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

// Открытие фото в полноразмерном режиме
document.addEventListener("click", (e) => {
const img = e.target;
if (!img.classList || !img.classList.contains("mm-photo-thumb")) return;

const url = img.getAttribute("data-full") || img.src;

let modal = document.getElementById("mm-photo-modal");
if (!modal) {
    modal = document.createElement("div");
    modal.id = "mm-photo-modal";
    modal.className = "mm-photo-modal";
    modal.addEventListener("click", () => {
    modal.remove();
    });

    const bigImg = document.createElement("img");
    modal.appendChild(bigImg);

    document.body.appendChild(modal);
}

const bigImg = modal.querySelector("img");
bigImg.src = url;
});

initAuthFromStorage();
map.on("load", refresh);
map.on("moveend", refresh);