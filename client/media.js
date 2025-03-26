import { showVisualCue } from './common.js';
import {deleteFilesFromTempList} from "./common.js";
import { log_client_action } from './logger.js';

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
    log_client_action('All streams stopped')
};

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
};

async function getMediaDevices() {
    return new Promise(async (resolve, reject) => {
        try {
            chrome.desktopCapture.chooseDesktopMedia(['screen'], async (streamId) => {
                if (!streamId) {
                    log_client_action('User canceled screen selection');
                    console.error('Пользователь отменил выбор экрана');
                    reject('Пользователь отменил выбор экрана');
                    return;
                }
                try {
                    streams.screen = await navigator.mediaDevices.getUserMedia({
                        video: {
                            mandatory: {
                                chromeMediaSource: 'desktop',
                                chromeMediaSourceId: streamId
                            }
                        },
                    });

                    if (!streams.screen || streams.screen.getVideoTracks().length === 0) {
                        log_client_action('Screen permission denied');
                        throw new Error('Не удалось получить видеопоток с экрана');
                    }

                    let micPermissionDenied = false;
                    let camPermissionDenied = false;

                    try {
                        streams.microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
                        log_client_action('Microphone access granted');
                    } catch (micError) {
                        if (micError.name === 'NotAllowedError') {
                            micPermissionDenied = true;
                            log_client_action('Microphone permission denied: NotAllowedError');
                        } else {
                            log_client_action('Microphone permission denied');
                            alert('Ошибка при доступе к микрофону: ' + micError.message);
                            stopStreams();
                            reject(micError);
                            return;
                        }
                    }

                    try {
                        streams.camera = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                        log_client_action('Camera access granted');
                    } catch (camError) {
                        if (camError.name === 'NotAllowedError') {
                            log_client_action('Camera permission denied: NotAllowedError');
                            camPermissionDenied = true;
                        } else {
                            log_client_action('Camera permission denied');
                            alert('Ошибка при доступе к камере: ' + camError.message);
                            stopStreams();
                            reject(camError);
                            return;
                        }
                    }

                    if (micPermissionDenied || camPermissionDenied) {
                        stopStreams();
                        const extensionId = chrome.runtime.id;
                        const settingsUrl = `chrome://settings/content/siteDetails?site=chrome-extension://${extensionId}`;

                        alert('Не предоставлен доступ к камере или микрофону.\n' +
                            'Сейчас откроется вкладка с настройками доступа для этого расширения.\n' +
                            'Пожалуйста, убедитесь, что камера и микрофон разрешены.');

                        chrome.tabs.create({url: settingsUrl});

                        chrome.tabs.getCurrent((tab) => {
                            if (tab && tab.id) {
                                chrome.tabs.remove(tab.id);
                            }
                        });
                        log_client_action('Redirecting to permission settings');
                        reject('Доступ к устройствам не предоставлен');
                        return;
                    }

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

                    recorders.combined = new MediaRecorder(streams.combined, { mimeType: 'video/mp4; codecs="avc1.64001E, opus"' });
                    log_client_action('Combined recorder initialized');
                    recorders.camera = new MediaRecorder(streams.camera, { mimeType: 'video/mp4; codecs="avc1.64001E"' });
                    log_client_action('Camera recorder initialized');

                    recorders.combined.ondataavailable = async (event) => {
                        if (event.data.size > 0 && combinedWritableStream) {
                            log_client_action(`Combined data available: ${event.data.size} bytes`);
                            await combinedWritableStream.write(event.data);
                        }
                    };

                    recorders.camera.ondataavailable = async (event) => {
                        if (event.data.size > 0 && cameraWritableStream) {
                            log_client_action(`Camera data available: ${event.data.size} bytes`);
                            await cameraWritableStream.write(event.data);
                        }
                    };
                  
                    resolve();
                } catch (error) {
                    console.error('Ошибка при захвате:', error);
                    stopStreams();
                    reject(error);
                }
            });
        } catch (error) {
            reject(error);
        }
    });
}

async function cleanup() {
    if (forceTimeout) clearTimeout(forceTimeout);
    stopStreams();
    combinedPreview.srcObject = null;
    cameraPreview.srcObject = null;
    recorders.combined = null;
    recorders.camera = null;
    console.log('Все потоки и запись остановлены.');
    log_client_action('cleanup_completed');
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
        log_client_action(`file_saved: ${name}`);
    } catch (error) {
        console.error(`Ошибка при сохранении файла ${name}:`, error);
        log_client_action(`file_save_error: ${name} - ${error.message}`);
    }
}

const getCurrentDateString = (date) => {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T` + 
    `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

const getAvailableDiskSpace = async () => {
    const estimate = await navigator.storage.estimate();
    return estimate.quota - estimate.usage;
};

async function addFileToTempList(fileName) {
    const tempFiles = (await chrome.storage.local.get('tempFiles'))['tempFiles'] || [];
    if (!tempFiles.includes(fileName)) {
        tempFiles.push(fileName);
    }
    chrome.storage.local.set({'tempFiles': tempFiles});
}

const beforeUnloadHandler = (event) => {
    event.preventDefault();
    event.returnValue = true;
};

window.addEventListener('beforeunload', beforeUnloadHandler);

// Функция для отправки видео на сервер после завершения записи
async function uploadVideo(combinedFile, cameraFile) {
    chrome.storage.local.get(['session_id', 'extension_logs'], async ({ session_id, extension_logs }) => {
        if (!session_id) {
            console.error("Session ID не найден в хранилище");
            log_client_action('upload_error: no_session_id');
            return;
        }

        const formData = new FormData();
        formData.append("id", session_id);
        formData.append("screen_video", combinedFile, combinedFileName);
        formData.append("camera_video", cameraFile, cameraFileName);
        await setMetadatasRecordOff();
        formData.append("metadata", JSON.stringify(metadata));

        if (extension_logs) {
            let logsToSend;
            if (typeof extension_logs === "string") {
                try {
                    logsToSend = JSON.parse(extension_logs);
                } catch (e) {
                    console.error("Ошибка парсинга логов:", e);
                    logsToSend = [{ error: "Invalid logs", raw_data: extension_logs }];
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
        }
        //TODO log_client_action('upload_successful'); не попадает в logs

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
                log_client_action('upload_successful');
            })
            .then(async () => {
                await deleteFilesFromTempList();
                chrome.alarms.get('dynamicCleanup', (alarm) => {
                    if (alarm) {
                        chrome.alarms.clear('dynamicCleanup');
                    }
                    log_client_action('Delete tempfiles successful');
                });
            })
            .catch(error => {
                console.error("Ошибка при отправке видео на сервер:", error);
                log_client_action(`upload_error: ${error.message}`);
            })
            .finally(async () => {
                await new Promise((resolve) => {
                    chrome.runtime.sendMessage({ action: "clearLogs" }, (response) => {
                        if (response.success) {
                            console.log("Логи очищены перед завершением");
                        } else {
                            console.error("Ошибка очистки логов:", response.error);
                        }
                        resolve();
                    });
                });
            });
    });
}

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    if (message.action === 'stopRecording') {
        log_client_action('Stop recording command received');
        if (recorders.combined || recorders.camera) {
            window.removeEventListener('beforeunload', beforeUnloadHandler);
            stopRecord();
        }
    }
    else if (message.action === 'startRecording' && !recorders.combined) {
        log_client_action('Start recording command received');
        try {
            await getMediaDevices();
            await startRecord();
        } catch (error) {
            alert(error);
            console.log(error);
        }
    }
});

function stopRecord() {
    setMetadatasRecordOn();
    endTime = new Date();
    const stopPromises = [];

    if (recorders.combined) {
        stopPromises.push(new Promise((resolve) => {
            recorders.combined.onstop = async () => {
                if (combinedWritableStream) {
                    await combinedWritableStream.close();
                    await handleFileSave(combinedFileHandle, combinedFileName);
                }
                resolve();
            };
            recorders.combined.stop();
        }));
    }

    if (recorders.camera) {
        stopPromises.push(new Promise((resolve) => {
            recorders.camera.onstop = async () => {
                if (cameraWritableStream) {
                    await cameraWritableStream.close();
                    await handleFileSave(cameraFileHandle, cameraFileName);
                }
                resolve();
            };
            recorders.camera.stop();
        }));
    }


    // Ждем завершения обоих рекордеров, затем вызываем uploadVideo() и cleanup()
    Promise.all(stopPromises).then(async () => {
        await uploadVideo(await combinedFileHandle.getFile(), await cameraFileHandle.getFile());
        cleanup();
    }).catch(error => {
        console.error("Ошибка при остановке записи:", error);
        cleanup();
    });
    showVisualCue(["Запись завершена. Файл будет сохранен и загружен на сервер."], "Окончание записи");
    log_client_action('Recording stopping');
}

async function startRecord() {
    if (getAvailableDiskSpace() < 2600000000) {
        console.log('На диске недостаточно места!');
        log_client_action('start_record_error: insufficient_space');
        return;
    }
    if (!combinedPreview.srcObject || !cameraPreview.srcObject) {
        console.log('Выдайте разрешения');
        log_client_action('start_record_error: no_permissions');
        return;
    }

    rootDirectory = await navigator.storage.getDirectory();
    log_client_action('Root directory accessed');
    startTime = new Date();
    let startRecordTime = getCurrentDateString(startTime);

    combinedFileName = `proctoring_screen_${startRecordTime}.mp4`;
    cameraFileName = `proctoring_camera_${startRecordTime}.mp4`;

    try {
        combinedFileHandle = await rootDirectory.getFileHandle(combinedFileName, {create: true});
        combinedWritableStream = await combinedFileHandle.createWritable();
        log_client_action(`Combined file handle created: ${combinedFileName}`);

        cameraFileHandle = await rootDirectory.getFileHandle(cameraFileName, {create: true});
        cameraWritableStream = await cameraFileHandle.createWritable();
        log_client_action(`Camera file handle created: ${cameraFileName}`);

        await Promise.all([
            addFileToTempList(combinedFileName),
            addFileToTempList(cameraFileName)
        ]);
        log_client_action('Files added to temp list');

        chrome.storage.local.set({
            'fileNames': {
                screen: combinedFileName,
                camera: cameraFileName
            }
        });

        await chrome.runtime.sendMessage({
            action: 'scheduleCleanup',
            delayMinutes: 245
        });
        log_client_action('File names saved to storage');

        forceTimeout = setTimeout(() => {
            console.log('Запись принудительно завершена спустя 4 часа!');
            stopRecord();
            log_client_action('recording_force_stopped');
        }, 14400000);
        
        startTime = new Date();
        recorders.combined.start(5000);
        recorders.camera.start(5000);
        console.log('Запись начата');
        log_client_action('recording_started');
    } catch (error) {
        console.error('Ошибка при запуске записи:', error);
        log_client_action('recording_stopped');
        cleanup();
    }
    showVisualCue(["Началась запись экрана. Убедитесь, что ваше устройство работает корректно."], "Начало записи");
}