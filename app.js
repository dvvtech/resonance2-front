const CLOCK_SYNC_SAMPLE_COUNT = 10;
const CLOCK_SYNC_REFRESH_MS = 15000;
const PLAYBACK_SYNC_INTERVAL_MS = 250;
const HARD_SEEK_THRESHOLD_SECONDS = 0.15;
const SOFT_CORRECTION_THRESHOLD_SECONDS = 0.04;
const FINE_CORRECTION_THRESHOLD_SECONDS = 0.01;
const MAX_PLAYBACK_RATE_DELTA = 0.035;
const BACKEND_STORAGE_KEY = "resonance2:v2:backend-base-url";
const DEFAULT_BACKEND_BASE_URL = "https://api.cloud-platform.pro/resonance/";

const elements = {
    backendUrlInput: document.getElementById("backendUrlInput"),
    connectBackendButton: document.getElementById("connectBackendButton"),
    createRoomButton: document.getElementById("createRoomButton"),
    roomIdInput: document.getElementById("roomIdInput"),
    joinRoomButton: document.getElementById("joinRoomButton"),
    shareLinkInput: document.getElementById("shareLinkInput"),
    copyLinkButton: document.getElementById("copyLinkButton"),
    trackUrlInput: document.getElementById("trackUrlInput"),
    setTrackButton: document.getElementById("setTrackButton"),
    readyButton: document.getElementById("readyButton"),
    audioPlayer: document.getElementById("audioPlayer"),
    connectionState: document.getElementById("connectionState"),
    currentRoom: document.getElementById("currentRoom"),
    clockOffsetText: document.getElementById("clockOffsetText"),
    rttText: document.getElementById("rttText"),
    outputLatencyText: document.getElementById("outputLatencyText"),
    driftText: document.getElementById("driftText"),
    syncModeText: document.getElementById("syncModeText"),
    playbackState: document.getElementById("playbackState"),
    backendState: document.getElementById("backendState"),
    statusText: document.getElementById("statusText"),
};

const audio = elements.audioPlayer;

let backendBaseUrl = "";
let connection = null;
let currentRoomId = "";
let currentTrackUrl = "";
let latestRoomState = null;
let suppressPlayerEventsUntil = 0;
let pendingSeekTime = null;
let audioPrimed = false;
let autoplayHintShown = false;
let clockOffsetMs = 0;
let lastRttMs = null;
let audioOutputLatencyMs = 0;
let playbackSyncHandle = null;
let clockSyncHandle = null;
let pendingCommandHandle = null;
let lastPlayAttemptMs = 0;

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

function setSyncMode(message) {
    elements.syncModeText.textContent = message;
}

function setReadyState(isReady) {
    audioPrimed = isReady;
    elements.readyButton.textContent = isReady ? "Устройство готово" : "Готов слушать";
}

function suppressPlayerEvents(ms = 350) {
    suppressPlayerEventsUntil = Date.now() + ms;
}

function playerEventsSuppressed() {
    return Date.now() < suppressPlayerEventsUntil;
}

function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function normalizeTime(value) {
    const numeric = Number(value);
    if (Number.isNaN(numeric) || !Number.isFinite(numeric)) {
        return 0;
    }

    return Math.max(0, numeric);
}

function ensureTrailingSlash(url) {
    return url.endsWith("/") ? url : `${url}/`;
}

function normalizeBackendBaseUrl(rawValue) {
    const trimmedValue = (rawValue || "").trim();
    const fallback = DEFAULT_BACKEND_BASE_URL;

    if (!trimmedValue) {
        return fallback;
    }

    return ensureTrailingSlash(new URL(trimmedValue, window.location.origin).toString());
}

function getQueryParam(name) {
    return new URLSearchParams(window.location.search).get(name) || "";
}

function resolveBackendBaseUrl() {
    return normalizeBackendBaseUrl(
        getQueryParam("backend") || window.localStorage.getItem(BACKEND_STORAGE_KEY) || DEFAULT_BACKEND_BASE_URL,
    );
}

function getHubUrl() {
    return new URL("musicHubV2", backendBaseUrl).toString();
}

function getEstimatedServerNowMs() {
    return Date.now() + clockOffsetMs;
}

function getAudioServerNowMs() {
    return Date.now() + clockOffsetMs + audioOutputLatencyMs;
}

function detectAudioOutputLatency() {
    try {
        var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) return;
        var ctx = new AudioContextCtor();
        var latencyMs = 0;
        if ("outputLatency" in ctx) {
            latencyMs += ctx.outputLatency * 1000;
        }
        if ("baseLatency" in ctx) {
            latencyMs += ctx.baseLatency * 1000;
        }
        audioOutputLatencyMs = latencyMs;
        ctx.close();
    } catch {}
}

function updateMetrics(driftSeconds = null) {
    elements.clockOffsetText.textContent = `${clockOffsetMs.toFixed(1)} ms`;
    elements.rttText.textContent = lastRttMs === null ? "-" : `${lastRttMs.toFixed(0)} ms`;
    elements.outputLatencyText.textContent = audioOutputLatencyMs > 0 ? `${audioOutputLatencyMs.toFixed(1)} ms` : "-";
    elements.driftText.textContent = driftSeconds === null ? "-" : `${(driftSeconds * 1000).toFixed(0)} ms`;
    elements.backendState.textContent = backendBaseUrl;
}

function updateButtons() {
    const hasRoom = Boolean(currentRoomId);
    elements.copyLinkButton.disabled = !hasRoom;
    elements.setTrackButton.disabled = !hasRoom;
}

function getRoomIdFromLocation() {
    return getQueryParam("room").trim().toUpperCase();
}

function buildShareLink(roomId) {
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("room", roomId);

    if (backendBaseUrl !== DEFAULT_BACKEND_BASE_URL) {
        url.searchParams.set("backend", backendBaseUrl);
    }

    return url.toString();
}

function updateHistory() {
    const url = new URL(window.location.href);
    url.search = "";

    if (currentRoomId) {
        url.searchParams.set("room", currentRoomId);
    }

    if (backendBaseUrl !== DEFAULT_BACKEND_BASE_URL) {
        url.searchParams.set("backend", backendBaseUrl);
    }

    window.history.replaceState({}, "", url.toString());
}

function updateRoomUi(roomId) {
    elements.currentRoom.textContent = roomId || "-";
    elements.roomIdInput.value = roomId || "";
    elements.shareLinkInput.value = roomId ? buildShareLink(roomId) : "";
    updateButtons();
    updateHistory();
}

async function copyText(text) {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
    }

    const fallbackInput = document.createElement("input");
    fallbackInput.value = text;
    fallbackInput.setAttribute("readonly", "");
    fallbackInput.style.position = "fixed";
    fallbackInput.style.top = "-1000px";
    document.body.appendChild(fallbackInput);
    fallbackInput.select();
    fallbackInput.setSelectionRange(0, fallbackInput.value.length);

    try {
        return document.execCommand("copy");
    } finally {
        document.body.removeChild(fallbackInput);
    }
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
        audio.playbackRate = 1;
        return true;
    }

    audio.src = currentTrackUrl;
    audio.load();
    return true;
}

function seekAudio(timeInSeconds) {
    const nextTime = normalizeTime(timeInSeconds);

    if (!audio.src) {
        pendingSeekTime = nextTime;
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
        return false;
    }

    if (!audioPrimed) {
        if (!autoplayHintShown) {
            setStatus('На этом устройстве нажмите "Готов слушать", чтобы браузер разрешил воспроизведение.');
            autoplayHintShown = true;
        }

        return false;
    }

    try {
        suppressPlayerEvents(500);
        await audio.play();
        autoplayHintShown = false;
        return true;
    } catch {
        setReadyState(false);
        setStatus('Браузер заблокировал autoplay. Нажмите "Готов слушать" на этом устройстве.');
        return false;
    }
}

function normalizePendingCommand(rawCommand) {
    if (!rawCommand) {
        return null;
    }

    return {
        type: rawCommand.type || "",
        executeAtUnixMs: Number(rawCommand.executeAtUnixMs) || 0,
        positionSeconds: normalizeTime(rawCommand.positionSeconds),
        isPlayingAfterExecution: Boolean(rawCommand.isPlayingAfterExecution),
        version: Number(rawCommand.version) || 0,
    };
}

function normalizeRoomState(rawState) {
    return {
        roomId: rawState.roomId || "",
        trackUrl: (rawState.trackUrl || "").trim(),
        isPlaying: Boolean(rawState.isPlaying),
        positionSeconds: normalizeTime(rawState.positionSeconds),
        referenceServerTimeUnixMs: Number(rawState.referenceServerTimeUnixMs) || 0,
        serverNowUnixMs: Number(rawState.serverNowUnixMs) || 0,
        version: Number(rawState.version) || 0,
        pendingCommand: normalizePendingCommand(rawState.pendingCommand),
    };
}

function promotePendingCommandIfDue() {
    if (!latestRoomState?.pendingCommand) {
        return false;
    }

    if (getAudioServerNowMs() + 2 < latestRoomState.pendingCommand.executeAtUnixMs) {
        return false;
    }

    latestRoomState = {
        ...latestRoomState,
        isPlaying: latestRoomState.pendingCommand.isPlayingAfterExecution,
        positionSeconds: latestRoomState.pendingCommand.positionSeconds,
        referenceServerTimeUnixMs: latestRoomState.pendingCommand.executeAtUnixMs,
        version: Math.max(latestRoomState.version, latestRoomState.pendingCommand.version),
        pendingCommand: null,
    };

    if (pendingCommandHandle) {
        window.clearTimeout(pendingCommandHandle);
        pendingCommandHandle = null;
    }

    return true;
}

function schedulePendingCommand() {
    if (pendingCommandHandle) {
        window.clearTimeout(pendingCommandHandle);
        pendingCommandHandle = null;
    }

    if (!latestRoomState?.pendingCommand) {
        return;
    }

    var delayMs = latestRoomState.pendingCommand.executeAtUnixMs - getAudioServerNowMs();

    if (delayMs <= 0) {
        if (promotePendingCommandIfDue()) {
            syncPlaybackToState(true);
        }

        return;
    }

    var BUSY_WAIT_MS = 5;

    if (delayMs <= BUSY_WAIT_MS) {
        var targetPerf = performance.now() + delayMs;
        while (performance.now() < targetPerf) {}
        if (promotePendingCommandIfDue()) {
            syncPlaybackToState(true);
        }

        return;
    }

    var coarseDelay = delayMs - BUSY_WAIT_MS;
    pendingCommandHandle = window.setTimeout(() => {
        var remaining = latestRoomState.pendingCommand.executeAtUnixMs - getAudioServerNowMs();
        if (remaining <= 0) {
            if (promotePendingCommandIfDue()) {
                syncPlaybackToState(true);
            }

            return;
        }

        var targetPerf = performance.now() + remaining;
        while (performance.now() < targetPerf) {}
        if (promotePendingCommandIfDue()) {
            syncPlaybackToState(true);
        }
    }, Math.max(0, coarseDelay));
}

function getTargetPlayback(state) {
    if (!state) {
        return { shouldPlay: false, targetTime: 0 };
    }

    if (!state.isPlaying) {
        return { shouldPlay: false, targetTime: state.positionSeconds };
    }

    const elapsedSeconds = Math.max(0, (getAudioServerNowMs() - state.referenceServerTimeUnixMs) / 1000);
    return {
        shouldPlay: true,
        targetTime: state.positionSeconds + elapsedSeconds,
    };
}

function syncPlaybackToState(forceHardSync = false) {
    if (!latestRoomState) {
        setSyncMode("Idle");
        updateMetrics(null);
        return;
    }

    promotePendingCommandIfDue();

    var desired = getTargetPlayback(latestRoomState);
    var currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    var driftSeconds = desired.targetTime - currentTime;

    updateMetrics(driftSeconds);

    if (!latestRoomState.trackUrl) {
        setPlaybackState("No track");
        setSyncMode("Waiting track");
        return;
    }

    if (!desired.shouldPlay) {
        if (!audio.paused && !audio.ended) {
            suppressPlayerEvents();
            audio.pause();
        }

        if (Math.abs(driftSeconds) > 0.1 || forceHardSync) {
            seekAudio(desired.targetTime);
        }

        audio.playbackRate = 1;
        setPlaybackState(`Paused @ ${desired.targetTime.toFixed(2)}s`);
        setSyncMode(latestRoomState.pendingCommand ? `Waiting ${latestRoomState.pendingCommand.type}` : "Paused");
        return;
    }

    if (audio.ended) {
        if (desired.targetTime < audio.duration - 0.5) {
            suppressPlayerEvents(600);
            audio.currentTime = desired.targetTime;
            void playLocalAudio();
        } else {
            setPlaybackState("Track ended");
            setSyncMode("Ended");
        }

        return;
    }

    if (Math.abs(driftSeconds) > HARD_SEEK_THRESHOLD_SECONDS || forceHardSync) {
        seekAudio(desired.targetTime);
        audio.playbackRate = 1;
        setSyncMode("Hard seek");
    } else if (Math.abs(driftSeconds) > SOFT_CORRECTION_THRESHOLD_SECONDS) {
        const rateDelta = clamp(driftSeconds * 0.18, -MAX_PLAYBACK_RATE_DELTA, MAX_PLAYBACK_RATE_DELTA);
        audio.playbackRate = 1 + rateDelta;
        setSyncMode(`Rate ${(audio.playbackRate).toFixed(3)}x`);
    } else if (Math.abs(driftSeconds) > FINE_CORRECTION_THRESHOLD_SECONDS) {
        const rateDelta = clamp(driftSeconds * 0.08, -0.015, 0.015);
        audio.playbackRate = 1 + rateDelta;
        setSyncMode("Fine correction");
    } else {
        audio.playbackRate = 1;
        setSyncMode("Locked");
    }

    setPlaybackState(`Playing @ ${desired.targetTime.toFixed(2)}s`);

    if (audio.paused && Date.now() - lastPlayAttemptMs > 800) {
        lastPlayAttemptMs = Date.now();
        void playLocalAudio();
    }
}

function applyIncomingState(rawState, statusMessage = "") {
    const nextState = normalizeRoomState(rawState);
    if (latestRoomState && nextState.version < latestRoomState.version) {
        return;
    }

    latestRoomState = nextState;
    currentRoomId = nextState.roomId || currentRoomId;
    updateRoomUi(currentRoomId);
    elements.trackUrlInput.value = nextState.trackUrl || "";

    const sourceChanged = setAudioSource(nextState.trackUrl);

    if (nextState.pendingCommand?.type === "play" && !nextState.isPlaying && audio.src && audio.readyState >= 1) {
        seekAudio(nextState.pendingCommand.positionSeconds);
    }

    schedulePendingCommand();
    syncPlaybackToState(sourceChanged);

    if (statusMessage) {
        setStatus(statusMessage);
    }
}

async function primeDeviceForPlayback() {
    setReadyState(true);
    autoplayHintShown = false;

    if (!audio.src) {
        setStatus("Устройство готово. Трек можно запускать после его загрузки в комнату.");
        return;
    }

    const previousMuted = audio.muted;
    const previousTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;

    try {
        audio.muted = true;
        suppressPlayerEvents(700);
        await audio.play();
        await sleep(60);
        audio.pause();
        audio.currentTime = previousTime;
        setStatus("Устройство подготовлено к синхронному воспроизведению.");
    } catch {
        setReadyState(false);
        setStatus('Не удалось подготовить аудио. Нажмите "Готов слушать" ещё раз.');
        return;
    } finally {
        audio.muted = previousMuted;
    }

    syncPlaybackToState(true);
}

async function syncClock() {
    if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
        return;
    }

    const samples = [];

    for (let index = 0; index < CLOCK_SYNC_SAMPLE_COUNT; index += 1) {
        const clientSendUnixMs = Date.now();
        const response = await connection.invoke("SyncClock", clientSendUnixMs);
        const clientReceiveUnixMs = Date.now();
        const roundTripMs = clientReceiveUnixMs - clientSendUnixMs;
        const midpointServerMs = (Number(response.serverReceiveUnixMs) + Number(response.serverSendUnixMs)) / 2;
        const midpointClientMs = (clientSendUnixMs + clientReceiveUnixMs) / 2;

        samples.push({
            offsetMs: midpointServerMs - midpointClientMs,
            roundTripMs,
        });

        if (index < CLOCK_SYNC_SAMPLE_COUNT - 1) {
            await sleep(80);
        }
    }

    samples.sort((left, right) => left.roundTripMs - right.roundTripMs);
    const bestSamples = samples.slice(0, Math.max(1, Math.ceil(samples.length / 2)));
    clockOffsetMs = bestSamples.reduce((sum, sample) => sum + sample.offsetMs, 0) / bestSamples.length;
    lastRttMs = bestSamples[0].roundTripMs;
    updateMetrics(latestRoomState ? getTargetPlayback(latestRoomState).targetTime - (Number.isFinite(audio.currentTime) ? audio.currentTime : 0) : null);
}

function startClientLoops() {
    if (playbackSyncHandle) {
        window.clearInterval(playbackSyncHandle);
    }

    if (clockSyncHandle) {
        window.clearInterval(clockSyncHandle);
    }

    playbackSyncHandle = window.setInterval(() => {
        syncPlaybackToState(false);
    }, PLAYBACK_SYNC_INTERVAL_MS);

    clockSyncHandle = window.setInterval(() => {
        void syncClock();
    }, CLOCK_SYNC_REFRESH_MS);
}

function stopClientLoops() {
    if (playbackSyncHandle) {
        window.clearInterval(playbackSyncHandle);
        playbackSyncHandle = null;
    }

    if (clockSyncHandle) {
        window.clearInterval(clockSyncHandle);
        clockSyncHandle = null;
    }

    if (pendingCommandHandle) {
        window.clearTimeout(pendingCommandHandle);
        pendingCommandHandle = null;
    }
}

function bindConnectionEvents(activeConnection) {
    activeConnection.on("RoomUpdated", (state) => {
        applyIncomingState(state, `Комната ${state.roomId} синхронизирована через v2.`);
    });

    activeConnection.on("StateChanged", (state) => {
        applyIncomingState(state, "Получено обновление состояния комнаты.");
    });

    activeConnection.onreconnecting(() => {
        setConnectionState("Reconnecting...");
        setStatus("Связь с backend переподключается...");
    });

    activeConnection.onreconnected(async () => {
        setConnectionState("Connected");
        setStatus("Связь восстановлена.");
        await syncClock();

        if (currentRoomId) {
            await activeConnection.invoke("JoinRoom", currentRoomId);
        }
    });

    activeConnection.onclose(() => {
        setConnectionState("Disconnected");
        setStatus("Соединение закрыто.");
        stopClientLoops();
    });
}

async function connectBackend() {
    backendBaseUrl = normalizeBackendBaseUrl(elements.backendUrlInput.value || resolveBackendBaseUrl());
    elements.backendUrlInput.value = backendBaseUrl;
    window.localStorage.setItem(BACKEND_STORAGE_KEY, backendBaseUrl);
    updateMetrics();
    updateHistory();
    stopClientLoops();

    if (connection) {
        try {
            await connection.stop();
        } catch {
            // Ignore reconnect cleanup failures.
        }
    }
var t = getHubUrl();
    connection = new signalR.HubConnectionBuilder()
        .withUrl(getHubUrl())
        .withAutomaticReconnect()
        .build();

    bindConnectionEvents(connection);

    setConnectionState("Connecting...");
    setStatus(`Подключение к ${getHubUrl()}...`);
    await connection.start();
    setConnectionState("Connected");
    setStatus("Backend подключён.");

    await syncClock();
    startClientLoops();

    if (currentRoomId) {
        await connection.invoke("JoinRoom", currentRoomId);
    }
}

async function ensureConnection() {
    if (connection && connection.state === signalR.HubConnectionState.Connected) {
        return;
    }

    await connectBackend();
}

async function safeInvoke(methodName, ...args) {
    try {
        await ensureConnection();
        return await connection.invoke(methodName, ...args);
    } catch (error) {
        const message = error?.message || "Ошибка SignalR v2.";
        setStatus(message);
        throw error;
    }
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
    setStatus(`Вы вошли в комнату ${normalizedRoomId}.`);
}

audio.addEventListener("loadedmetadata", () => {
    if (pendingSeekTime !== null) {
        suppressPlayerEvents();
        audio.currentTime = pendingSeekTime;
        pendingSeekTime = null;
    }

    syncPlaybackToState(true);
});

audio.addEventListener("play", async () => {
    if (playerEventsSuppressed() || !currentRoomId) {
        return;
    }

    setReadyState(true);
    await safeInvoke("Play", currentRoomId, normalizeTime(audio.currentTime));
});

audio.addEventListener("pause", async () => {
    if (playerEventsSuppressed() || !currentRoomId || audio.ended) {
        return;
    }

    await safeInvoke("Pause", currentRoomId);
});

audio.addEventListener("ended", async () => {
    if (playerEventsSuppressed() || !currentRoomId) {
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

elements.connectBackendButton.addEventListener("click", async () => {
    await connectBackend();
});

elements.createRoomButton.addEventListener("click", async () => {
    const roomId = await safeInvoke("CreateRoom");
    await joinRoom(roomId);
    setStatus(`Комната ${roomId} создана в v2.`);
});

elements.joinRoomButton.addEventListener("click", async () => {
    await joinRoom();
});

elements.copyLinkButton.addEventListener("click", async () => {
    if (!elements.shareLinkInput.value) {
        return;
    }

    const copied = await copyText(elements.shareLinkInput.value);
    setStatus(copied ? "Ссылка на v2-комнату скопирована." : "Не удалось скопировать ссылку автоматически.");
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

elements.readyButton.addEventListener("click", async () => {
    await primeDeviceForPlayback();
});

void (async function initialize() {
    setReadyState(false);
    detectAudioOutputLatency();
    updateButtons();

    backendBaseUrl = resolveBackendBaseUrl();
    elements.backendUrlInput.value = backendBaseUrl;
    updateMetrics();

    try {
        await connectBackend();
        const roomIdFromLocation = getRoomIdFromLocation();

        if (roomIdFromLocation) {
            await joinRoom(roomIdFromLocation);
        } else {
            setStatus("v2 клиент подключён. Создайте комнату или войдите по Room ID.");
        }
    } catch (error) {
        const message = error?.message || "Не удалось подключиться к backend v2.";
        setConnectionState("Disconnected");
        setStatus(message);
        stopClientLoops();
    }
})();
