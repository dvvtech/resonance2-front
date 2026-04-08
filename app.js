const DRIFT_THRESHOLD_SECONDS = 0.3;
const DRIFT_SYNC_INTERVAL_MS = 4000;

const elements = {
    createRoomButton: document.getElementById("createRoomButton"),
    roomIdInput: document.getElementById("roomIdInput"),
    joinRoomButton: document.getElementById("joinRoomButton"),
    shareLinkInput: document.getElementById("shareLinkInput"),
    copyLinkButton: document.getElementById("copyLinkButton"),
    trackUrlInput: document.getElementById("trackUrlInput"),
    setTrackButton: document.getElementById("setTrackButton"),
    playButton: document.getElementById("playButton"),
    pauseButton: document.getElementById("pauseButton"),
    seekInput: document.getElementById("seekInput"),
    seekButton: document.getElementById("seekButton"),
    audioPlayer: document.getElementById("audioPlayer"),
    connectionState: document.getElementById("connectionState"),
    currentRoom: document.getElementById("currentRoom"),
    playbackState: document.getElementById("playbackState"),
    statusText: document.getElementById("statusText"),
};

const audio = elements.audioPlayer;
const connection = new signalR.HubConnectionBuilder()
    .withUrl("/musicHub")
    .withAutomaticReconnect()
    .build();

let currentRoomId = "";
let currentTrackUrl = "";
let pendingSeekTime = null;
let pendingShouldPlay = false;
let suppressPlayerEventsUntil = 0;
let driftSyncHandle = null;

function setStatus(message) {
    if (message) {
        elements.statusText.textContent = message;
    }
}

function setConnectionState(message) {
    elements.connectionState.textContent = message;
}

function setPlaybackState(message) {
    elements.playbackState.textContent = message;
}

function suppressPlayerEvents(ms = 350) {
    suppressPlayerEventsUntil = Date.now() + ms;
}

function playerEventsSuppressed() {
    return Date.now() < suppressPlayerEventsUntil;
}

function getRoomIdFromLocation() {
    const pathMatch = window.location.pathname.match(/^\/room\/([^/]+)$/i);
    if (pathMatch?.[1]) {
        return decodeURIComponent(pathMatch[1]).trim().toUpperCase();
    }

    const roomId = new URLSearchParams(window.location.search).get("room");
    return roomId ? roomId.trim().toUpperCase() : "";
}

function buildShareLink(roomId) {
    return `${window.location.origin}/room/${encodeURIComponent(roomId)}`;
}

function updateRoomUi(roomId) {
    elements.currentRoom.textContent = roomId || "-";
    elements.roomIdInput.value = roomId || "";
    elements.shareLinkInput.value = roomId ? buildShareLink(roomId) : "";

    if (roomId) {
        window.history.replaceState({}, "", `/room/${encodeURIComponent(roomId)}`);
    } else if (window.location.pathname !== "/") {
        window.history.replaceState({}, "", "/");
    }

    updateButtons();
}

function updateButtons() {
    const hasRoom = Boolean(currentRoomId);
    const hasTrack = Boolean(currentTrackUrl);

    elements.copyLinkButton.disabled = !hasRoom;
    elements.setTrackButton.disabled = !hasRoom;
    elements.playButton.disabled = !hasRoom || !hasTrack;
    elements.pauseButton.disabled = !hasRoom || !hasTrack;
    elements.seekButton.disabled = !hasRoom || !hasTrack;
}

function normalizeTime(value) {
    const numeric = Number(value);
    if (Number.isNaN(numeric) || !Number.isFinite(numeric)) {
        return 0;
    }

    return Math.max(0, numeric);
}

function setAudioSource(trackUrl) {
    const nextTrackUrl = (trackUrl || "").trim();

    if (currentTrackUrl === nextTrackUrl) {
        return false;
    }

    currentTrackUrl = nextTrackUrl;
    suppressPlayerEvents();

    if (!currentTrackUrl) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        return true;
    }

    audio.src = currentTrackUrl;
    audio.load();
    return true;
}

function seekAudio(timeInSeconds) {
    const nextTime = normalizeTime(timeInSeconds);
    elements.seekInput.value = nextTime.toFixed(1);

    if (!audio.src) {
        return;
    }

    if (audio.readyState >= 1) {
        suppressPlayerEvents();

        try {
            audio.currentTime = nextTime;
            pendingSeekTime = null;
        } catch {
            pendingSeekTime = nextTime;
        }

        return;
    }

    pendingSeekTime = nextTime;
}

async function playLocalAudio() {
    if (!audio.src) {
        return;
    }

    pendingShouldPlay = true;

    try {
        suppressPlayerEvents(500);
        await audio.play();
    } catch {
        setStatus("Браузер заблокировал autoplay. Нажмите Play один раз на этом устройстве.");
    }
}

function applyRoomState(state, statusMessage = "") {
    if (!state) {
        return;
    }

    currentRoomId = state.roomId || currentRoomId;
    updateRoomUi(currentRoomId);

    const sourceChanged = setAudioSource(state.trackUrl);
    const targetTime = normalizeTime(state.currentTime);
    const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const drift = Math.abs(currentTime - targetTime);

    if (sourceChanged || drift > DRIFT_THRESHOLD_SECONDS || !state.isPlaying) {
        seekAudio(targetTime);
    } else {
        elements.seekInput.value = targetTime.toFixed(1);
    }

    if (state.isPlaying && state.trackUrl) {
        setPlaybackState(`Playing @ ${targetTime.toFixed(1)}s`);
        void playLocalAudio();
    } else {
        pendingShouldPlay = false;
        suppressPlayerEvents();
        audio.pause();
        setPlaybackState(`Paused @ ${targetTime.toFixed(1)}s`);
    }

    updateButtons();

    if (statusMessage) {
        setStatus(statusMessage);
    }
}

async function ensureConnection() {
    if (connection.state === signalR.HubConnectionState.Connected) {
        return;
    }

    if (connection.state === signalR.HubConnectionState.Connecting || connection.state === signalR.HubConnectionState.Reconnecting) {
        return;
    }

    setConnectionState("Connecting...");
    await connection.start();
    setConnectionState("Connected");
}

async function safeInvoke(methodName, ...args) {
    try {
        await ensureConnection();
        return await connection.invoke(methodName, ...args);
    } catch (error) {
        const message = error?.message || "Ошибка SignalR.";
        setStatus(message);
        throw error;
    }
}

function startDriftSync() {
    if (driftSyncHandle) {
        window.clearInterval(driftSyncHandle);
    }

    if (!currentRoomId) {
        driftSyncHandle = null;
        return;
    }

    driftSyncHandle = window.setInterval(async () => {
        if (!currentRoomId || connection.state !== signalR.HubConnectionState.Connected) {
            return;
        }

        try {
            const state = await connection.invoke("GetRoomState", currentRoomId);
            if (!state) {
                return;
            }

            const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
            const drift = Math.abs(currentTime - normalizeTime(state.currentTime));

            if (!state.isPlaying || drift > DRIFT_THRESHOLD_SECONDS) {
                applyRoomState(state, drift > DRIFT_THRESHOLD_SECONDS ? "Drift скорректирован по серверу." : "");
                return;
            }

            elements.seekInput.value = normalizeTime(state.currentTime).toFixed(1);
        } catch (error) {
            const message = error?.message || "Не удалось обновить состояние комнаты.";
            setStatus(message);
        }
    }, DRIFT_SYNC_INTERVAL_MS);
}

async function joinRoom(roomId) {
    const normalizedRoomId = (roomId || elements.roomIdInput.value).trim().toUpperCase();
    if (!normalizedRoomId) {
        setStatus("Укажите Room ID.");
        return;
    }

    await safeInvoke("JoinRoom", normalizedRoomId);
    currentRoomId = normalizedRoomId;
    updateRoomUi(currentRoomId);
    startDriftSync();
    setStatus(`Вы вошли в комнату ${normalizedRoomId}.`);
}

connection.on("RoomUpdated", (state) => {
    applyRoomState(state, `Комната ${state.roomId} синхронизирована.`);
});

connection.on("TrackChanged", (state) => {
    elements.trackUrlInput.value = state.trackUrl || "";
    applyRoomState(state, "Трек обновлён для всех участников.");
});

connection.on("Play", (state) => {
    applyRoomState(state, "Сервер запустил воспроизведение.");
});

connection.on("Pause", (state) => {
    applyRoomState(state, "Сервер поставил воспроизведение на паузу.");
});

connection.on("Seek", (state) => {
    applyRoomState(state, "Сервер обновил позицию трека.");
});

connection.onreconnecting(() => {
    setConnectionState("Reconnecting...");
    setStatus("Связь переподключается...");
});

connection.onreconnected(async () => {
    setConnectionState("Connected");
    setStatus("Связь восстановлена.");

    if (currentRoomId) {
        try {
            await connection.invoke("JoinRoom", currentRoomId);
            startDriftSync();
        } catch (error) {
            const message = error?.message || "Не удалось заново войти в комнату.";
            setStatus(message);
        }
    }
});

connection.onclose(() => {
    setConnectionState("Disconnected");
});

audio.addEventListener("loadedmetadata", () => {
    if (pendingSeekTime !== null) {
        suppressPlayerEvents();
        audio.currentTime = pendingSeekTime;
        pendingSeekTime = null;
    }

    if (pendingShouldPlay) {
        void playLocalAudio();
    }
});

audio.addEventListener("play", async () => {
    if (playerEventsSuppressed() || !currentRoomId) {
        return;
    }

    await safeInvoke("Play", currentRoomId, normalizeTime(audio.currentTime));
});

audio.addEventListener("pause", async () => {
    if (playerEventsSuppressed() || !currentRoomId || audio.ended) {
        return;
    }

    await safeInvoke("Pause", currentRoomId);
});

audio.addEventListener("seeked", async () => {
    if (playerEventsSuppressed() || !currentRoomId || !audio.src) {
        return;
    }

    await safeInvoke("Seek", currentRoomId, normalizeTime(audio.currentTime));
});

elements.createRoomButton.addEventListener("click", async () => {
    const roomId = await safeInvoke("CreateRoom");
    await joinRoom(roomId);
    setStatus(`Комната ${roomId} создана.`);
});

elements.joinRoomButton.addEventListener("click", async () => {
    await joinRoom();
});

elements.copyLinkButton.addEventListener("click", async () => {
    if (!elements.shareLinkInput.value) {
        return;
    }

    await navigator.clipboard.writeText(elements.shareLinkInput.value);
    setStatus("Ссылка на комнату скопирована.");
});

elements.setTrackButton.addEventListener("click", async () => {
    const trackUrl = elements.trackUrlInput.value.trim();
    if (!currentRoomId) {
        setStatus("Сначала войдите в комнату.");
        return;
    }

    if (!trackUrl) {
        setStatus("Укажите URL трека.");
        return;
    }

    await safeInvoke("SetTrack", currentRoomId, trackUrl);
});

elements.playButton.addEventListener("click", async () => {
    if (!currentRoomId) {
        setStatus("Сначала войдите в комнату.");
        return;
    }

    await safeInvoke("Play", currentRoomId, normalizeTime(audio.currentTime));
});

elements.pauseButton.addEventListener("click", async () => {
    if (!currentRoomId) {
        setStatus("Сначала войдите в комнату.");
        return;
    }

    await safeInvoke("Pause", currentRoomId);
});

elements.seekButton.addEventListener("click", async () => {
    if (!currentRoomId) {
        setStatus("Сначала войдите в комнату.");
        return;
    }

    await safeInvoke("Seek", currentRoomId, normalizeTime(elements.seekInput.value));
});

void (async function initialize() {
    updateButtons();

    try {
        await ensureConnection();
        setStatus("Подключено. Создайте комнату или войдите по Room ID.");

        const roomIdFromLocation = getRoomIdFromLocation();
        if (roomIdFromLocation) {
            await joinRoom(roomIdFromLocation);
        }
    } catch (error) {
        const message = error?.message || "Не удалось подключиться к backend.";
        setConnectionState("Disconnected");
        setStatus(message);
    }
})();
