import { showModalNotify, waitForNotificationSuppression } from './common.js';
import { deleteFilesFromTempList, buttonsStatesSave } from "./common.js";
import { logClientAction, flushLogs } from './logger.js';

var streams = {
    screen: null,
    microphone: null,
    camera: null,
    combined: null
};

var recorders = {
    combined: null,
    camera: null
};

var combinedPreview = document.querySelector('.combined__preview');
var cameraPreview = document.querySelector('.camera__preview');

var previewButton = document.getElementById('preview-toggle-btn');
var isRecording = false;
var isPreviewEnabled = false;

var rootDirectory = null;
var combinedFileName = null;
var cameraFileName = null;
var combinedFileHandle = null;
var cameraFileHandle = null;
var combinedWritableStream = null;
var cameraWritableStream = null;
var forceTimeout = null;
var startTime = undefined;
var endTime = undefined;

var server_connection = undefined;
var notifications_flag = true;
var invalidStop = false;

var metadata = {
    screen: {
        session_client_start: undefined,
        session_client_end: undefined,
        session_client_duration: undefined,
        session_client_mime: undefined,
        session_client_resolution: undefined,
        session_client_size: undefined // MB
    },
    camera: {
        session_client_start: undefined,
        session_client_end: undefined,
        session_client_duration: undefined,
        session_client_mime: undefined,
        session_client_resolution: undefined,
        session_client_size: undefined // MB
    }
};

const stopStreams = () => {
    Object.entries(streams).forEach(([stream, value]) => {
        if (value) {
            value.getTracks().forEach(track => track.stop());
            streams[stream] = null;
        }
    });
    logClientAction({ action: "Stop streams" });
};

function generateObjectId() {
    const bytes = new Uint8Array(12);
    const timestamp = Math.floor(Date.now() / 1000);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, timestamp, false);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(bytes.subarray(4));
    } else {
      for (let i = 4; i < 12; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    logClientAction({ action: "Generate ObjectId" });

    return Array.from(bytes)
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
}

function getBrowserFingerprint() {
    const fingerprint = {
        browserVersion: navigator.userAgent.match(/Chrome\/([0-9.]+)/)?.[1] || 'unknown',
        userAgent: navigator.userAgent,
        language: navigator.language || navigator.userLanguage || 'unknown',
        cpuCores: navigator.hardwareConcurrency || 'unknown',
        screenResolution: `${window.screen.width}x${window.screen.height}`,
        availableScreenResolution: `${window.screen.availWidth}x${window.screen.availHeight}`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
        timestamp: new Date().toISOString(),
        cookiesEnabled: navigator.cookieEnabled ? 'yes' : 'no',
        windowSize: `${window.innerWidth}x${window.innerHeight}`,
        doNotTrack: navigator.doNotTrack || window.doNotTrack || 'unknown'
    };

    logClientAction({ action: "Get browser fingerprint", fingerprint});

    return fingerprint;
}

async function clearLogs() {
    await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "clearLogs" }, (response) => {
            if (response.success) {
                //ЗДЕСЬ НЕ НАДО ЛОГГИРОВАТЬ
                //logClientAction({ action: "Clear logs" });
                console.log("Логи очищены перед завершением");
            } else {
                //logClientAction({ action: "Error while clearing logs", error: response.error });
                // console.error("Ошибка очистки логов:", response.error);
            }
            resolve();
        });
    });
}

const getDifferenceInTime = (date1, date2) => {
    const diff = Math.abs(Math.floor(date2.getTime() / 1000) - Math.floor(date1.getTime() / 1000)); // ms
    const totalSeconds = Math.floor(diff);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    // Для удобного представления
    const formattedHours = String(hours).padStart(2, '0');
    const formattedMinutes = String(minutes).padStart(2, '0');
    const formattedSeconds = String(seconds).padStart(2, '0');

    logClientAction({ action: "Calculate difference in time" });
    return `${formattedHours}:${formattedMinutes}:${formattedSeconds}`;
};

const setMetadatasRecordOn = () => {
    metadata.screen.session_client_start = getCurrentDateString(startTime);
    metadata.screen.session_client_mime = recorders.combined.mimeType;
    const [screenVideoTrack] = streams.screen.getVideoTracks();
    const screenSettings = screenVideoTrack.getSettings();
    metadata.screen.session_client_resolution = `${screenSettings.width}×${screenSettings.height}`;
    metadata.camera.session_client_start = getCurrentDateString(startTime);
    metadata.camera.session_client_mime = recorders.camera.mimeType;
    const [cameraVideoTrack] = streams.camera.getVideoTracks();
    const cameraSettings = cameraVideoTrack.getSettings();
    metadata.camera.session_client_resolution = `${cameraSettings.width}×${cameraSettings.height}`;
    logClientAction({ action: "Set metadata record on" });
};

const setMetadatasRecordOff = async () => {
    metadata.screen.session_client_end = getCurrentDateString(endTime);
    metadata.screen.session_client_duration = getDifferenceInTime(endTime, startTime);
    metadata.camera.session_client_end = getCurrentDateString(endTime);
    metadata.camera.session_client_duration = getDifferenceInTime(endTime, startTime);
    const screenFile = await combinedFileHandle.getFile();
    metadata.screen.session_client_size = (screenFile.size / 1000000).toFixed(3);
    const cameraFile = await cameraFileHandle.getFile();
    metadata.camera.session_client_size = (cameraFile.size / 1000000).toFixed(3);
    logClientAction({ action: "Set metadata record off" });
};

async function checkOpenedPopup() {
    let a = await chrome.runtime.getContexts({contextTypes: ['POPUP']});
    const isPopupOpen = a.length > 0;
    logClientAction({ action: "Check if popup is open", popupOpen: isPopupOpen.toString() });
    return isPopupOpen;
}

async function sendButtonsStates(state) {
    if (state === 'readyToUpload' && !server_connection) {
        state = 'needPermissions';
        logClientAction({ action: "Update buttons states due to missing server connection" });
    }
    if (await checkOpenedPopup()) chrome.runtime.sendMessage({action: 'updateButtonStates', state: state}, (response) => {
        if (chrome.runtime.lastError) {
            logClientAction(`Message with state: ${state} failed. Error: ${chrome.runtime.lastError.message}`);
            buttonsStatesSave(state);
        } else {
            logClientAction(`Message with state: ${state} sent successfully`);
        }
    });
    else {
        buttonsStatesSave(state);
        logClientAction(`sendButtonsStates ${state} else`);
    }
}

async function setupMultiScreenRecording(initialStreamId, displays) {
    logClientAction({ action: "Starting multi-screen recording setup", displaysCount: displays.length });
    const firstStream = await navigator.mediaDevices.getUserMedia({
        video: {
            mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: initialStreamId,
                maxWidth: displays[0].bounds.width,
                maxHeight: displays[0].bounds.height,
                frameRate: 15
            }
        }
    });
    logClientAction({ action: "Primary screen stream obtained", streamId: initialStreamId });
    const streamsList = [ firstStream ];
    // streamId меняется, поэтому будем проверять по label
    const chosenLabels = [
        firstStream.getVideoTracks()[0].label
    ];
    logClientAction({ action: "Primary screen added", label: chosenLabels[0] });
    for (let i = 1; i < displays.length; i++) {
        let added = false;
        while (!added) {
            logClientAction({ action: "Requesting additional screen", screenIndex: i });
            const sid = await new Promise(resolve =>
                chrome.desktopCapture.chooseDesktopMedia(['screen'], resolve)
            );
            if (!sid) {
                logClientAction({ action: "User canceled additional screen selection", screenIndex: i });
                throw new Error('Пользователь отменил выбор дополнительного экрана');
            }

            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: sid,
                        maxWidth: displays[i].bounds.width,
                        maxHeight: displays[i].bounds.height,
                        frameRate: 15
                    }
                }
            });
            logClientAction({ action: "Additional screen stream obtained", screenIndex: i, streamId: sid });
            const track = stream.getVideoTracks()[0];
            const label = track.label;

            if (chosenLabels.includes(label)) {
                logClientAction({ action: "Duplicate screen detected", screenIndex: i, label });
                stream.getTracks().forEach(t => t.stop());
                await showModalNotify(
                    "Этот монитор вы уже выбрали. Пожалуйста, укажите другой.",
                    "Выбор монитора"
                );
                continue;
            }

            chosenLabels.push(label);
            streamsList.push(stream);
            added = true;
            logClientAction({ action: "Additional screen added", screenIndex: i, label });
        }
    }

    const scale = 1;
    const totalWidth = displays.reduce((sum,d)=>sum + d.bounds.width, 0) * scale;
    const maxHeight  = Math.max(...displays.map(d=>d.bounds.height)) * scale;
    const canvas = document.createElement('canvas');
    canvas.width  = totalWidth;
    canvas.height = maxHeight;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    logClientAction({ action: "Canvas created", dimensions: { width: totalWidth, height: maxHeight } });
    const videos = streamsList.map(strm => {
        const v = document.createElement('video');
        v.srcObject = strm;
        v.play();
        return v;
    });
    logClientAction({ action: "Video elements created", count: videos.length });
    (function draw() {
        ctx.clearRect(0,0,canvas.width,canvas.height);
        let x = 0;
        for (let idx = 0; idx < videos.length; idx++) {
            const w = displays[idx].bounds.width * scale;
            const h = displays[idx].bounds.height * scale;
            ctx.drawImage(videos[idx], x, 0, w, h);
            x += w;
        }
        requestAnimationFrame(draw);
    })();
    logClientAction({ action: "Canvas drawing started" });
    const multiStream = canvas.captureStream(15);
    logClientAction({
        action: "Canvas stream created for multi-monitor",
        screens: streamsList.length,
        streamInfo: {
            width: canvas.width,
            height: canvas.height,
            fps: 15
        }
    });
    return multiStream;
}

let previousDisplayCount = 0;
let displayCheckInterval;
function startDisplayMonitoring(screenStream, checkInterval = 2000) {
    logClientAction({
        action: "Starting display monitoring",
        interval: checkInterval,
        initialDisplayCount: previousDisplayCount
    });
    checkDisplays(screenStream);
    displayCheckInterval = setInterval(() => {
        checkDisplays(screenStream);
    }, checkInterval);
}

function stopDisplayMonitoring() {
    if (displayCheckInterval) {
        clearInterval(displayCheckInterval);
        logClientAction({ action: "Display monitoring stopped" });
    }
}

async function checkDisplays(screenStream) {
    try {
        logClientAction({ action: "Checking displays status" });
        const displays = await new Promise(res => chrome.system.display.getInfo(res));
        if (displays.length < previousDisplayCount && previousDisplayCount > 0) {
            logClientAction({
                action: "Display disconnected",
                previousCount: previousDisplayCount,
                currentCount: displays.length,
                message
            });
            console.warn(`Экран отключен! Было: ${previousDisplayCount}, стало: ${displays.length}`);
            handleScreenDisconnected(screenStream);
        }
        previousDisplayCount = displays.length;
    } catch (error) {
        console.error('Ошибка при проверке экранов:', error);
    }
}

async function handleScreenDisconnected(screenStream) {
    logClientAction({ action: "Handling screen disconnection" });
    stopDisplayMonitoring();
    const videoTracks = screenStream.getVideoTracks();
    if (videoTracks.length > 0 && videoTracks[0].readyState !== 'ended') {
        // Принудительно останавливаем трек
        logClientAction({
            action: "Forcibly stopping video track",
            trackId: videoTracks[0].id,
            trackLabel: videoTracks[0].label
        });
        videoTracks[0].stop();
    }
    await showModalNotify("Беспроводной экран был отключен", "Запись остановлена");
    stopRecord();
    logClientAction({ action: "Recording stopped due to screen disconnection" });
}

async function getMediaDevices() {
    return new Promise(async (resolve, reject) => {
        let streamLossSource = null;
        try {
            logClientAction({ action: "Request screen media" });
            await showModalNotify(["Пожалуйста, предоставьте доступ к экрану, микрофону и камере. " +
                        "Не отключайте эти разрешения до окончания записи. " +
                        "Это необходимо для корректной работы системы прокторинга."],
                        "Разрешения для прокторинга");



            chrome.desktopCapture.chooseDesktopMedia(['screen'], async (streamId) => {
                if (!streamId) {
                    logClientAction({ action: "User cancels screen selection" });
                    console.error('Пользователь отменил выбор экрана');
                    reject('Пользователь отменил выбор экрана');
                    await showModalNotify(["Пользователь отменил выбор экрана!", "Выдайте заново разрешения в расширении во всплывающем окне по кнопке Разрешения."], "Ошибка");
                    return;
                }

                const displays = await new Promise(res => chrome.system.display.getInfo(res));

                if (displays.length > 1) {
                    try {
                        const multiStream = await setupMultiScreenRecording(streamId, displays);
                        streams.screen = multiStream;
                    } catch (err) {
                        console.error("Multi‑screen setup failed, fallback to single:", err);
                    }
                }

                try {
                    logClientAction({ action: "User grants screen access" });


                    startDisplayMonitoring(streams.screen);
                    if (!streams.screen) {
                        console.log("multiscreen didn't work");
                        streams.screen = await navigator.mediaDevices.getUserMedia({
                            video: {
                                mandatory: {
                                    chromeMediaSource: 'desktop',
                                    chromeMediaSourceId: streamId,
                                    width: {
                                        ideal: 1920,
                                        max: Math.min(2560, screen.width),
                                        min: Math.min(1440, screen.width)
                                    },
                                    height: {
                                        ideal: 1080,
                                        max: Math.min(1440, screen.height),
                                        min: Math.min(810, screen.height)
                                    },
                                    frameRate: { ideal: 20, max: 20, min: 15 }
                                }
                            }
                        });
                    }

                    if (!streams.screen || streams.screen.getVideoTracks().length === 0) {
                        logClientAction({ action: "Screen stream not available" });
                        throw new Error('Не удалось получить видеопоток с экрана');
                    }

                    chrome.runtime.sendMessage({ type: 'screenCaptureStatus', active: true });

                    let micPermissionDenied = false;
                    let camPermissionDenied = false;

                    try {
                        streams.microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
                        logClientAction({ action: "User grants microphone access" });
                    } catch (micError) {
                        if (micError.name === 'NotAllowedError') {
                            micPermissionDenied = true;
                            logClientAction({ action: "Microphone permission denied", error: "NotAllowedError" });
                            await showModalNotify("Ошибка при доступе к микрофону: NotAllowedError", "Ошибка");
                        } else {
                            logClientAction({ action: "Microphone permission denied" });
                            //alert('Ошибка при доступе к микрофону: ' + micError.message);
                            await showModalNotify('Ошибка при доступе к микрофону: ' + micError.message, "Ошибка");
                            stopStreams();
                            reject(micError);
                            return;
                        }
                    }

                    try {
                        streams.camera = await navigator.mediaDevices.getUserMedia({ 
                            video: {
                                width: { ideal: 320 },
                                height: { ideal: 240 },
                                frameRate: { ideal: 17, max: 17, min: 15 }
                            }, 
                            audio: false 
                        });
                        logClientAction({ action: "User grants camera access" });
                    } catch (camError) {
                        if (camError.name === 'NotAllowedError') {
                            logClientAction({ action: "Camera permission denied", error: "NotAllowedError" });
                            await showModalNotify("Ошибка при доступе к камере: NotAllowedError", "Ошибка");
                            camPermissionDenied = true;
                        } else {
                            logClientAction({ action: "Camera permission denied" });
                            //alert('Ошибка при доступе к камере: ' + camError.message);
                            await showModalNotify('Ошибка при доступе к камере: ' + camError.message, "Ошибка");
                            stopStreams();
                            reject(camError);
                            return;
                        }
                    }

                    if (micPermissionDenied || camPermissionDenied) {
                        stopStreams();
                        const extensionId = chrome.runtime.id;
                        const settingsUrl = `chrome://settings/content/siteDetails?site=chrome-extension://${extensionId}`;

                        logClientAction({ action: "Prompt permission settings" });

                        // alert('Не предоставлен доступ к камере или микрофону.\n' +
                        //     'Сейчас откроется вкладка с настройками доступа для этого расширения.\n' +
                        //     'Пожалуйста, убедитесь, что камера и микрофон разрешены.');
                        await showModalNotify(['Не предоставлен доступ к камере или микрофону.',
                            'Сейчас откроется вкладка с настройками доступа для этого расширения.',
                            'Пожалуйста, убедитесь, что камера и микрофон разрешены, а затем нажмите во всплывающем окне расширения кнопку Разрешения.']);

                        const mediaExtensionUrl = chrome.runtime.getURL("pages/media.html");

                        // Закрытие вкладки media.html c открытием вкладки с настройками разрешений расширения
                        chrome.runtime.sendMessage({
                            action: 'closeTabAndOpenTab',
                            mediaExtensionUrl: mediaExtensionUrl,
                            settingsUrl: settingsUrl
                        });

                        logClientAction({ action: "Redirect to permission settings" });
                        reject('Доступ к устройствам не предоставлен');
                        return;
                    }

                    // Обработка потери доступа
                    streams.camera.oninactive = async function () {
                        if (streamLossSource) return;
                        streamLossSource = 'camera';
                        logClientAction('Camera stream inactive');

                        if (!recorders.combined && !recorders.camera) return;

                        if (recorders.combined.state === 'inactive' && recorders.camera.state === 'inactive') {
                            await sendButtonsStates('needPermissions');
                            await showModalNotify(["Разрешение на камеру отозвано.",
                                "Дайте доступ заново в расширении во всплывающем окне по кнопке Разрешения."], "Доступ к камере потерян!");
                            stopStreams();
                        } else {
                            stopDuration();
                            await sendButtonsStates('needPermissions');
                            await showModalNotify(["Текущие записи завершатся. Чтобы продолжить запись заново, выдайте разрешения во всплывающем окне по кнопке Разрешения и начните запись."], "Доступ к камере потерян!");
                            invalidStop = true;
                            stopRecord();
                        }
                    };

                    streams.screen.getVideoTracks()[0].onended = async function () {
                        chrome.runtime.sendMessage({ type: 'screenCaptureStatus', active: false });
                        if (streamLossSource) return;
                        streamLossSource = 'screen';
                        logClientAction('Screen stream ended');

                        if (!recorders.combined || recorders.combined.state === 'inactive') {
                            await sendButtonsStates('needPermissions');
                            await showModalNotify(["Разрешение на захват экрана отозвано.", 
                                "Дайте доступ заново в расширении во всплывающем окне по кнопке Разрешения."], "Доступ к экрану потерян!");
                            stopStreams();
                        } else {
                            stopDuration();
                            await sendButtonsStates('needPermissions');
                            await showModalNotify(["Текущие записи завершатся. Чтобы продолжить запись заново, выдайте разрешения в расширении во всплывающем окне по кнопке Разрешения и начните запись."], "Доступ к экрану потерян!");
                            invalidStop = true;
                            stopRecord();
                        }
                    };

                    streams.microphone.getAudioTracks()[0].onended = async function () {
                        if (streamLossSource) return;
                        streamLossSource = 'microphone';
                        logClientAction('Microphone stream ended');

                        if (!recorders.combined || recorders.combined.state === 'inactive') {
                            await sendButtonsStates('needPermissions');
                            await showModalNotify(["Разрешение на микрофон отозвано.", 
                                "Дайте доступ заново в расширении во всплывающем окне по кнопке Разрешения."], "Доступ к микрофону потерян!");
                            stopStreams();
                        } else {
                            stopDuration();
                            await sendButtonsStates('needPermissions');
                            await showModalNotify(["Текущие записи завершатся. Чтобы продолжить запись заново, выдайте разрешения в расширении во всплывающем окне по кнопке Разрешения и начните запись."], "Доступ к микрофону потерян!");
                            invalidStop = true;
                            stopRecord();
                        }
                    };

                    streams.combined = new MediaStream([
                        streams.screen.getVideoTracks()[0],
                        streams.microphone.getAudioTracks()[0]
                    ]);

                    combinedPreview.srcObject = streams.combined;
                    cameraPreview.srcObject = streams.camera;

                    combinedPreview.onloadedmetadata = function () {
                        combinedPreview.width = combinedPreview.videoWidth > 1280 ? 1280 : combinedPreview.videoWidth;
                        combinedPreview.height = combinedPreview.videoHeight > 720 ? 720 : combinedPreview.videoHeight;
                    };

                    cameraPreview.onloadedmetadata = function () {
                        cameraPreview.width = 320;
                        cameraPreview.height = 240;
                    };

                    cameraPreview.style.display = 'block';
                    combinedPreview.style.display = 'block';

                    combinedPreview.muted = false;

                    recorders.combined = new MediaRecorder(streams.combined, {
                        mimeType: 'video/mp4; codecs="avc1.64001E, opus"',
                        audioBitsPerSecond: 128_000,
                        videoBitsPerSecond: 500_000,
                    });
                    logClientAction({ action: "Create combined recorder" });
                    
                    recorders.camera = new MediaRecorder(streams.camera, { 
                        mimeType: 'video/mp4; codecs="avc1.64001E"',
                        videoBitsPerSecond: 700_000
                    });
                    logClientAction({ action: "Create camera recorder" });

                    recorders.combined.ondataavailable = async (event) => {
                        if (event.data.size > 0 && combinedWritableStream) {
                            logClientAction({ action: "Combined data available", bytes: event.data.size });
                            await combinedWritableStream.write(event.data);
                        }
                    };

                    recorders.camera.ondataavailable = async (event) => {
                        if (event.data.size > 0 && cameraWritableStream) {
                            logClientAction({ action: "Camera data available", bytes: event.data.size });
                            await cameraWritableStream.write(event.data);
                        }
                    };

                    resolve();
                } catch (error) {
                    logClientAction({ action: "Error during screen capture setup", error: error.message });
                    stopStreams();
                    reject(error);
                }
            });
        } catch (error) {
            logClientAction({ action: "General error in getMediaDevices", error: error.message });
            reject(error);
        }
    });
}

function hideMutePreviews() {
    cameraPreview.style.display = 'none';
    combinedPreview.style.display = 'none';
    combinedPreview.muted = true;

    logClientAction({ action: "Hide and mute previews" });
}

previewButton.addEventListener('click', () => {
    if (!isRecording) {
        logClientAction({ action: "Ignore preview toggle click - not recording" });
        return;
    }

    combinedPreview.muted = true;

    isPreviewEnabled = !isPreviewEnabled;

    const displayValue = isPreviewEnabled ? 'block' : 'none';
    cameraPreview.style.display = displayValue;
    combinedPreview.style.display = displayValue;

    logClientAction(isPreviewEnabled ? { action: "Enable preview mode" } : { action: "Disable preview mode" });

    updatePreviewButton();
});

function updatePreviewButton() {
    if (!isRecording) {
        previewButton.disabled = true;
        previewButton.textContent = 'Включить';
        previewButton.classList.remove('enabled', 'disabled');
        logClientAction({ action: "Update preview button - not recording" });
        return;
    }

    previewButton.disabled = false;
    previewButton.textContent = isPreviewEnabled ? 'Выключить' : 'Включить';
    previewButton.classList.toggle('enabled', !isPreviewEnabled);
    previewButton.classList.toggle('disabled', isPreviewEnabled);

    logClientAction({ action: "Update preview button", previewEnabled: isPreviewEnabled.toString() });
}

async function cleanup() {
    if (forceTimeout) clearTimeout(forceTimeout);
    stopStreams();
    combinedPreview.srcObject = null;
    cameraPreview.srcObject = null;
    recorders.combined = null;
    recorders.camera = null;
    invalidStop = false;
    console.log('Все потоки и запись остановлены.');
    logClientAction({ action: "Complete cleanup" });
}

async function handleFileSave(handle, name) {
    try {
        const file = await handle.getFile();
        const url = URL.createObjectURL(file);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.click();
        console.log(`Файл ${name} сохранен`);
        logClientAction({ action: "Save file", fileName: name });
    } catch (error) {
        console.error(`Ошибка при сохранении файла ${name}:`, error);
        logClientAction({ action: "Fail to save file", fileName: name, error: error.message });
    }
}

const getCurrentDateString = (date) => {
    logClientAction({ action: "Generate current date string" });
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T` + 
    `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

const getFormattedDateString = (date) => {
    logClientAction({ action: "Generate human-readable date string" });

    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();

    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${hours}:${minutes}:${seconds}, ${day}.${month}.${year}`;
};

const getAvailableDiskSpace = async () => {
    const estimate = await navigator.storage.estimate();
    const freeSpace = estimate.quota - estimate.usage;
    logClientAction({ action: "Check available disk space", freeSpace });
    return freeSpace;
};

async function addFileToTempList(fileName) {
    const tempFiles = (await chrome.storage.local.get('tempFiles'))['tempFiles'] || [];
    if (!tempFiles.includes(fileName)) {
        logClientAction({ action: "Add file to temp list", fileName });
        tempFiles.push(fileName);
    } else {
        logClientAction({ action: "File already exists in temp list", fileName });
    }
    return chrome.storage.local.set({'tempFiles': tempFiles});
}

// системное ограничение браузера позволяет выводить пользовательское уведомление только после алерта (в целях безопасности)
const beforeUnloadHandler = (event) => {
    logClientAction({ action: "Trigger beforeunload warning" });
    // TODO
    // showVisualCueAsync(["Не закрывайте вкладку расширения при записи!", 
    //     "Не обновляйте вкладку расширения при записи!",
    //     "Не закрывайте браузер при записи!", 
    //     "При закрытии или обновлении вкладки расширения (речь не о всплывающем окне расширения), а также закрытии самого браузера запись будет прервана!"], "Внимание!");
    event.preventDefault();
    event.returnValue = true;
};

window.addEventListener('beforeunload', beforeUnloadHandler);

window.addEventListener('unload', () => {
    logClientAction({ action: "Tab media.html unload - save state as needPermissions" });
    buttonsStatesSave('needPermissions');
})

window.addEventListener('load', () => {
    logClientAction({ action: "Load media.html tab" });
    Object.values(streams).some(async (stream) => {
        if (stream === null) {
            logClientAction({ action: "Some stream is null - request permissions" });
            await sendButtonsStates('needPermissions');
            return true;
        }
    });
});

// Функция для отправки видео на сервер после завершения записи
async function uploadVideo() {
    chrome.storage.local.get(['session_id', 'extension_logs'], async ({ session_id, extension_logs }) => {
        if (!session_id) {
            console.error("Session ID не найден в хранилище");
            logClientAction({ action: `Upload fails due to missing session ID ${session_id}` });
            return;
        }

        const files = (await chrome.storage.local.get('tempFiles'))['tempFiles'] || [];
        if (!files.length) {
            logClientAction("Ошибка при поиске записей");
            throw new Error(`Ошибка при поиске записей`);
        }

        const formData = new FormData();

        for (const filename of files) {
            if (filename.includes('screen')) {
                formData.append('screen_video', await (await rootDirectory.getFileHandle(filename, {create: false})).getFile(), filename);
            } else {
                formData.append('camera_video', await (await rootDirectory.getFileHandle(filename, {create: false})).getFile(), filename);
            }
        }
        
        formData.append("id", session_id);

        await setMetadatasRecordOff();
        formData.append("metadata", JSON.stringify(metadata));

        logClientAction({ action: "Prepare upload payload", sessionId: session_id, fileNames: [combinedFileName, cameraFileName] });

        if (extension_logs) {
            let logsToSend;
            if (typeof extension_logs === "string") {
                try {
                    logsToSend = JSON.parse(extension_logs);
                } catch (e) {
                    console.error("Ошибка парсинга логов:", e);
                    logsToSend = [{ error: "Invalid logs", raw_data: extension_logs }];
                    logClientAction({ action: "Parse logs error", error: e.message });
                }
            } else {
                logsToSend = extension_logs;
            }

            const logsBlob = new Blob([JSON.stringify(logsToSend, null, 2)], { type: 'application/json' });
            formData.append("logs", logsBlob, "extension_logs.json");

            const logsFileName = `extension_logs_${session_id}_${getCurrentDateString(new Date())}.json`;
            const url = URL.createObjectURL(logsBlob);
            const link = document.createElement('a');
            link.href = url;
            link.download = logsFileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);

            logClientAction({ action: "Download logs file", fileName: logsFileName });
        }

        logClientAction({ action: "Send upload request", sessionId: session_id, messageType: "upload_video" });

        fetch('http://127.0.0.1:5000/upload_video', {
            method: "POST",
            body: formData,
        })
            .then(async (response) => {
                if (!response.ok) {
                    throw new Error(`Ошибка при загрузке видео: ${response.status}`);
                }
                const result = await response.json();
                console.log("Видео успешно отправлено:", result);
                logClientAction({ action: "Upload video succeeds", sessionId: session_id });
            })
            .then(async () => {
                await deleteFilesFromTempList();
                chrome.alarms.get('dynamicCleanup', (alarm) => {
                    if (alarm) {
                        chrome.alarms.clear('dynamicCleanup');
                    }
                    logClientAction({ action: "Delete temp files succeeds" });
                });
            })
            .catch(async (error) => {
                console.error("Ошибка при отправке видео на сервер:", error);
                await sendButtonsStates('failedUpload');
                logClientAction({ action: "Upload video fails", error: error.message, sessionId: session_id });
            })
            .finally(async () => {
                await clearLogs();
                logClientAction({ action: "Clear logs after upload video" });
            });
    });
}

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    if (message.action === 'stopRecording') {
        logClientAction({ action: "Receive message", messageType: "stopRecording" });
        if (recorders.combined || recorders.camera) {
            window.removeEventListener('beforeunload', beforeUnloadHandler);
            stopRecord();
            await sendButtonsStates('readyToUpload');
        }
    }
    else if (message.action === 'getPermissionsMedia') {
        logClientAction({ action: "Receive message", messageType: "getPermissionsMedia" });
        server_connection = (await chrome.storage.local.get('server_connection'))['server_connection'];
        getMediaDevices()
        .then(async () => {
            logClientAction({ action: "Get media devices success" });
            await sendButtonsStates('readyToRecord');
            await showModalNotify(["Разрешения получены. Теперь вы можете начать запись.",
                "Для удобства уведомление о доступе к вашему экрану можно скрыть или передвинуть. НЕЛЬЗЯ НАЖИМАТЬ НА «Закрыть доступ».",
                "НЕЛЬЗЯ ОБНОВЛЯТЬ, ЗАКРЫВАТЬ СЛУЖЕБНУЮ ВКЛАДКУ во время записи! НЕЛЬЗЯ ЗАКРЫВАТЬ БРАУЗЕР во время записи!",
                "Предпросмотр будет отключен. Его можно включить по кнопке на служебной вкладке расширения. По умолчанию звук выключен и включается в плеере.",
                "Во всплывающем окне расширения прокторинга можно найти статистику начала, продолжительности записи, а также разрешений.",
                "В случае потери разрешений запись будет прервана и ее необходимо будет начать заново.",
                "Расширение сообщит Вам обо всем необходимом. Удачной работы!",
                "",
                "Нажмите на кнопку «Начать запись» во всплывающем окне " +
                "расширения прокторинга, когда будете готовы.",],
                "Готово к записи");
        })
        .catch(async () => {
            logClientAction({ action: "Get media devices failed" });
            await sendButtonsStates('needPermissions');
        });
    }
    else if (message.action === 'startRecording') {
        logClientAction({ action: "Receive message", messageType: "startRecording" });

        const formData = new FormData();
        formData.append('group', message.formData.group || '');
        formData.append('name', message.formData.name || '');
        formData.append('surname', message.formData.surname || '');
        formData.append('patronymic', message.formData.patronymic || '');
        formData.append('link', message.formData.link || '');

        function formDataToObject(formData) {
            const obj = {};
            for (const [key, value] of formData.entries()) {
                obj[key] = value;
            }
            return obj;
        }

        logClientAction({
            action: "Receive startRecording formData",
            formData: formDataToObject(formData),
        });

        if (server_connection) {
            await initSession(formData);
        } else {
            getBrowserFingerprint()

            await chrome.storage.local.set({ 'lastRecordTime': new Date().toISOString() });

            const sessionId = generateObjectId();
            await chrome.storage.local.set({ 'session_id': sessionId });
            logClientAction({ action: "Generate session ID locally", sessionId });
        }

        startRecord()
        .then(async () => {
            logClientAction({ action: "Start recording succeeds" });
            await sendButtonsStates('recording');
            // После остановки записи ждём либо подтверждения подавления, либо, по истечении таймаута, выполняем уведомление
            waitForNotificationSuppression().then(async (suppress) => {
                if (!suppress) {
                    await showModalNotify(
                        ["Запись экрана, микрофона и камеры началась. " +
                        "Не отключайте разрешения этим элементам до окончания записи.",
                        "Чтобы завершить запись, нажмите кнопку «Остановить запись» во всплывающем окне расширения прокторинга."],
                        "Идёт запись",
                        true
                    );
                }
            });
        })
        .catch(async (error) => {
            // В startRecord есть свой обработчик ошибок
            await sendButtonsStates('needPermissions');
            await showModalNotify(["Ошибка при запуске записи:", error], "Ошибка");
        });
    }
    else if (message.action === 'uploadVideoMedia') {
        logClientAction('Start uploading command received');
        uploadVideo()
        .then(async () => {
            await sendButtonsStates('needPermissions');
            await showModalNotify(["Запись успешно отправлена на сервер."], "Запись отправлена");
        })
        .catch(async () => {
            await sendButtonsStates('failedUpload');
        });
    }
});


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'suppressModalNotifyAT') {
        notifications_flag = false;
        console.log('notifications_flag = ', notifications_flag);
        logClientAction(`notifications_flag = ${notifications_flag}`)
    }
});

async function initSession(formData) {
    getBrowserFingerprint()

    await chrome.storage.local.set({
        'lastRecordTime': new Date().toISOString()
    });

    try {
        const response = await fetch('http://127.0.0.1:5000/start_session', {
            method: 'POST',
            mode: 'cors',
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Сервер вернул ${response.status}`);
        }

        const result = await response.json();
        const sessionId = result.id;

        await chrome.storage.local.set({ 'session_id': sessionId });

        console.log('session_id успешно сохранён!');
        logClientAction({ action: "Save session ID from server", sessionId });
    } catch (error) {
        console.error("Ошибка инициализации сессии", error);
        await showModalNotify(["Ошибка инициализации сессии", error.message], "Ошибка")
        logClientAction({ action: "Session initialization failed", error: error.message });
        // startRecordButton.removeAttribute('disabled');
		// stopRecordButton.setAttribute('disabled', '');
        throw error;
    }
}

function stopDuration() {
    const durationMs = new Date() - startTime;

    const seconds = Math.floor((durationMs / 1000) % 60);
    const minutes = Math.floor((durationMs / 1000 / 60) % 60);
    const hours = Math.floor(durationMs / 1000 / 60 / 60);

    const timeStr = `${hours.toString().padStart(2, '0')}:` +
        `${minutes.toString().padStart(2, '0')}:` +
        `${seconds.toString().padStart(2, '0')}`;

    chrome.storage.local.set({
        'timeStr': timeStr
    }, function() {
        console.log('timeStr saved to storage');
        logClientAction("stopDuration timeStr saved to storage");
    });

    chrome.runtime.sendMessage({type: 'stopRecordSignal'}, function(response) {
        console.log('stopRecordSignal sent');
        logClientAction("stopDuration stopRecordSignal sent");
    });
}

async function stopRecord() {
    if (!invalidStop) stopDuration();
    chrome.runtime.sendMessage({ type: 'screenCaptureStatus', active: false });
  
    isRecording = false;
    isPreviewEnabled = false;
    hideMutePreviews();
    updatePreviewButton();

    setMetadatasRecordOn();
    endTime = new Date();
    const stopPromises = [];

    let combinedFileSize = 0;
    let cameraFileSize = 0;

    if (recorders.combined) {
        stopPromises.push(new Promise(async (resolve) => {
            recorders.combined.onstop = async () => {
                if (combinedWritableStream) {
                    await combinedWritableStream.close();
                    if (combinedFileHandle.getFile) {
                        const file = await combinedFileHandle.getFile();
                        combinedFileSize = file.size;
                    }
                    await handleFileSave(combinedFileHandle, combinedFileName);
                    logClientAction({ action: "Save recorded file", fileType: "screen", fileName: combinedFileName });
                }
                resolve();
            };
            if (recorders.combined.state === 'inactive') {
                if (combinedWritableStream) {
                    await combinedWritableStream.close();
                    await handleFileSave(combinedFileHandle, combinedFileName);
                }
                resolve();
            }
            else recorders.combined.stop();
        }));
    }

    if (recorders.camera) {
        stopPromises.push(new Promise(async (resolve) => {
            recorders.camera.onstop = async () => {
                if (cameraWritableStream) {
                    await cameraWritableStream.close();
                    if (cameraFileHandle.getFile) {
                        const file = await cameraFileHandle.getFile();
                        cameraFileSize = file.size;
                    }
                    await handleFileSave(cameraFileHandle, cameraFileName);
                    logClientAction({ action: "Save recorded file", fileType: "camera", fileName: cameraFileName });
                }
                resolve();
            };
            if (recorders.camera.state === 'inactive') {
                if (cameraWritableStream) {
                    await cameraWritableStream.close();
                    await handleFileSave(cameraFileHandle, cameraFileName);
                }
                resolve();
            }
            else recorders.camera.stop();
        }));
    }

    // Ждем завершения обоих рекордеров, затем вызываем uploadVideo() и cleanup()
    Promise.all(stopPromises).then(async () => {
        if (invalidStop) {
            // До этого уже вызывается функция
            await sendButtonsStates('needPermissions');
        } else {
            await sendButtonsStates('readyToUpload');
        }
        logClientAction({ action: "Recording stopped and files saved" });

        const duration = getDifferenceInTime(endTime, startTime);

        const stats = [
            `Начало записи: ${getFormattedDateString(startTime)}`,
            `Конец записи: ${getFormattedDateString(endTime)}`,
            `Длительность записи: ${duration}`,
            "Файлы записи экрана и камеры сохранены в папку загрузок по умолчанию.",
            "Файл записи экрана:",
            `${combinedFileName} (${(combinedFileSize / 1024 / 1024).toFixed(1)} MB)`,
            "Файл записи камеры:",
            `${cameraFileName} (${(cameraFileSize / 1024 / 1024).toFixed(1)} MB)`,
            "Файл с логами сохранен в папку загрузок по умолчанию."
        ];
        logClientAction(stats);
        // После остановки записи ждём либо подтверждения подавления, либо, по истечении таймаута, выполняем уведомление
        waitForNotificationSuppression().then(async (suppress) => {
            if (!suppress) {
                await showModalNotify(
                    stats,
                    "Запись завершена, статистика:",
                    true
                );
            }
        });
        if (server_connection && !invalidStop) {
            // После остановки записи ждём либо подтверждения подавления, либо, по истечении таймаута, выполняем уведомление
            waitForNotificationSuppression().then(async (suppress) => {
                if (!suppress) {
                    await showModalNotify(
                        ["Для отправки записи необходимо нажать кнопку «Отправить» во всплывающем окне расширения прокторинга."],
                        "Отправка записи",
                        true
                    );
                }
            });
        }

        cleanup();
        if (!server_connection) {
            await deleteFilesFromTempList();
            chrome.alarms.get('dynamicCleanup', (alarm) => {
                if (alarm) {
                    chrome.alarms.clear('dynamicCleanup');
                }
                logClientAction('Delete tempfiles successful');
            });
        }
    }).catch(error => {
        console.error("Ошибка при остановке записи:", error);
        logClientAction({ action: "Fail to stop recording", error: error.message });
        cleanup();
    });

    await delay(500);
    await flushLogs();
    await delay(100);
    if (!server_connection) {
        await downloadLogs();
    }

    //chrome.runtime.sendMessage({ action: "closePopup" });
    logClientAction('Recording stopping');
}

async function startRecord() {
    if (getAvailableDiskSpace() < 2600000000) {
        console.log('На диске недостаточно места!');
        logClientAction({ action: "Fail to start recording", reason: "Insufficient disk space" });
        return;
    }
    if (!combinedPreview.srcObject || !cameraPreview.srcObject) {
        console.log('Выдайте разрешения');
        logClientAction({ action: "Fail to start recording", reason: "Missing media permissions" });
        return;
    }

    rootDirectory = await navigator.storage.getDirectory();
    logClientAction({ action: "Access root directory" });

    startTime = new Date();

    let startRecordTime = getCurrentDateString(startTime);

    combinedFileName = `proctoring_screen_${startRecordTime}.mp4`;
    cameraFileName = `proctoring_camera_${startRecordTime}.mp4`;

    try {
        combinedFileHandle = await rootDirectory.getFileHandle(combinedFileName, {create: true});
        combinedWritableStream = await combinedFileHandle.createWritable();
        logClientAction({ action: "Create file handle", fileType: "screen", fileName: combinedFileName });

        cameraFileHandle = await rootDirectory.getFileHandle(cameraFileName, {create: true});
        cameraWritableStream = await cameraFileHandle.createWritable();
        logClientAction({ action: "Create file handle", fileType: "camera", fileName: cameraFileName });

        await addFileToTempList(combinedFileName);
        await addFileToTempList(cameraFileName);
        logClientAction('Files added to temp list');

        chrome.storage.local.set({
            'fileNames': {
                screen: combinedFileName,
                camera: cameraFileName
            }
        });
        logClientAction({ action: "Save fileNames to storage" });

        await chrome.runtime.sendMessage({
            action: 'scheduleCleanup',
            delayMinutes: 245
        });
        logClientAction({ action: "Send message", messageType: "scheduleCleanup" });

        forceTimeout = setTimeout(() => {
            console.log('Запись принудительно завершена спустя 4 часа!');
            stopRecord();
            logClientAction({ action: "Force stop recording after 4 hours" });
        }, 14400000);
        
        startTime = new Date();
        recorders.combined.start(5000);
        recorders.camera.start(5000);

        isRecording = true;
        isPreviewEnabled = false;
        hideMutePreviews();
        updatePreviewButton();


        console.log('Запись начата');
        logClientAction('recording_started');
        //chrome.runtime.sendMessage({ action: "closePopup" });
    } catch (error) {
        console.error('Ошибка при запуске записи:', error.message);
        logClientAction({ action: "Fail to start recording", error: error.message });
        cleanup();
        // Есть внешний обработчик ошибок
        // showVisualCue(["Ошибка при запуске записи:", error], "Ошибка");
        // await sendButtonsStates('needPermissions');
        throw error;
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadLogs() {
    try {
        const { extension_logs } = await chrome.storage.local.get('extension_logs');
        let logsToSave = [];

        if (extension_logs) {
            if (typeof extension_logs === "string") {
                try {
                    logsToSave = JSON.parse(extension_logs);
                } catch (e) {
                    console.error("Ошибка парсинга логов:", e);
                    logsToSave = [{ error: "Invalid logs", raw_data: extension_logs }];
                }
            } else {
                logsToSave = extension_logs;
            }
        }

        const logsFileName = `extension_logs_${getCurrentDateString(new Date())}.json`;
        const logsBlob = new Blob([JSON.stringify(logsToSave, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(logsBlob);

        console.log("URL создан для скачивания: ", url);

        const link = document.createElement('a');
        link.href = url;
        link.download = logsFileName;

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        URL.revokeObjectURL(url);

        console.log(`Логи сохранены локально: ${logsFileName}`);
        logClientAction(`logs_saved_locally: ${logsFileName}`);

        await clearLogs();
    } catch (error) {
        console.error("Ошибка при сохранении логов:", error);
        logClientAction(`logs_save_error: ${error.message}`);
    }
}