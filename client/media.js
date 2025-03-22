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

var startRecordTime = null;
var finishRecordTime = null;

const stopStreams = () => {
    Object.entries(streams).forEach(([stream, value]) => {
        if (value) {
            value.getTracks().forEach(track => track.stop());
            streams[stream] = null;
        }
    });
};

async function getMediaDevices() {
    return new Promise(async (resolve, reject) => {
        try {
            chrome.desktopCapture.chooseDesktopMedia(['screen'], async (streamId) => {
                if (!streamId) {
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
                        throw new Error('Не удалось получить видеопоток с экрана');
                    }

                    let micPermissionDenied = false;
                    let camPermissionDenied = false;

                    try {
                        streams.microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
                    } catch (micError) {
                        if (micError.name === 'NotAllowedError') {
                            micPermissionDenied = true;
                        } else {
                            alert('Ошибка при доступе к микрофону: ' + micError.message);
                            stopStreams();
                            reject(micError);
                            return;
                        }
                    }

                    try {
                        streams.camera = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                    } catch (camError) {
                        if (camError.name === 'NotAllowedError') {
                            camPermissionDenied = true;
                        } else {
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

                        chrome.tabs.create({ url: settingsUrl });

                        chrome.tabs.getCurrent((tab) => {
                            if (tab && tab.id) {
                                chrome.tabs.remove(tab.id);
                            }
                        });

                        reject('Доступ к устройствам не предоставлен');
                        return;
                    }

                    streams.combined = new MediaStream([
                        streams.screen.getVideoTracks()[0],
                        streams.microphone.getAudioTracks()[0]
                    ]);

                    combinedPreview.srcObject = streams.combined;
                    cameraPreview.srcObject = streams.camera;

                    combinedPreview.onloadedmetadata = function() {
                        combinedPreview.width = combinedPreview.videoWidth > 1280 ? 1280 : combinedPreview.videoWidth;
                        combinedPreview.height = combinedPreview.videoHeight > 720 ? 720 : combinedPreview.videoHeight;
                    };

                    cameraPreview.onloadedmetadata = function() {
                        cameraPreview.width = 320;
                        cameraPreview.height = 240;
                    };

                    recorders.combined = new MediaRecorder(streams.combined, { mimeType: 'video/mp4; codecs="avc1.64001E, opus"' });
                    recorders.camera = new MediaRecorder(streams.camera, { mimeType: 'video/mp4; codecs="avc1.64001E"' });

                    recorders.combined.ondataavailable = async (event) => {
                        if (event.data.size > 0 && combinedWritableStream) {
                            await combinedWritableStream.write(event.data);
                        }
                    };

                    recorders.camera.ondataavailable = async (event) => {
                        if (event.data.size > 0 && cameraWritableStream) {
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
    if (forceTimeout) {
        clearTimeout(forceTimeout);
    }
    stopStreams();
    combinedPreview.srcObject = null;
    cameraPreview.srcObject = null;
    recorders.combined = null;
    recorders.camera = null;
    finishRecordTime = getCurrentDateString(new Date());
    console.log('Все потоки и запись остановлены.');
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
    } catch (error) {
        console.error(`Ошибка при сохранении файла ${name}:`, error);
    }
}

const getCurrentDateString = (date) => {
    return `${date.getDate()}-${date.getMonth()+1}-${date.getFullYear()}T${date.getHours()}-${date.getMinutes()}-${date.getSeconds()}`;
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
    chrome.storage.local.get('session_id', async ({ session_id }) => {
        if (!session_id) {
            console.error("Session ID не найден в хранилище");
            return;
        }
        const formData = new FormData();
        formData.append("id", session_id);
        formData.append("screen_video", combinedFile, combinedFileName);
        formData.append("camera_video", cameraFile, cameraFileName);

        try {
            const response = await fetch("http://127.0.0.1:5000/upload_video", {
                method: "POST",
                body: formData,
            });
            if (!response.ok) {
                throw new Error(`Ошибка при загрузке видео: ${response.status}`);
            }
            const result = await response.json();
            console.log("Видео успешно отправлено:", result);
        } catch (error) {
            console.error("Ошибка при отправке видео на сервер:", error);
        }
    });
}

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    if (message.action === 'stopRecording') {
        if (recorders.combined || recorders.camera) {
            window.removeEventListener('beforeunload', beforeUnloadHandler);
            stopRecord();
        }
    }
    else if (message.action === 'startRecording' && !recorders.combined) {
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

    visual_cues(["Запись завершена. Файл будет сохранен и загружен на сервер."], "Окончание записи");


    // Ждем завершения обоих рекордеров, затем вызываем uploadVideo() и cleanup()
    Promise.all(stopPromises).then(async () => {
        await uploadVideo(await combinedFileHandle.getFile(), await cameraFileHandle.getFile());
        cleanup();
    }).catch(error => {
        console.error("Ошибка при остановке записи:", error);
        cleanup();
    });
}

async function startRecord() {
    if (getAvailableDiskSpace() < 2600000000) {
        console.log('На диске недостаточно места!');
        return;
    }
    if (!combinedPreview.srcObject || !cameraPreview.srcObject) {
        console.log('Выдайте разрешения');
        return;
    }

    rootDirectory = await navigator.storage.getDirectory();
    startRecordTime = getCurrentDateString(new Date());

    combinedFileName = `proctoring_screen_${startRecordTime}.mp4`;
    cameraFileName = `proctoring_camera_${startRecordTime}.mp4`;

    try {
        combinedFileHandle = await rootDirectory.getFileHandle(combinedFileName, { create: true });
        combinedWritableStream = await combinedFileHandle.createWritable();

        cameraFileHandle = await rootDirectory.getFileHandle(cameraFileName, { create: true });
        cameraWritableStream = await cameraFileHandle.createWritable();

        await Promise.all([
            addFileToTempList(combinedFileName),
            addFileToTempList(cameraFileName)
        ]);

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

        forceTimeout = setTimeout(() => {
            console.log('Запись принудительно завершена спустя 4 часа!');
            stopRecord();
        }, 14400000);

        recorders.combined.start(5000);
        recorders.camera.start(5000);
        console.log('Запись начата');
    } catch (error) {
        console.error('Ошибка при запуске записи:', error);
        cleanup();
    }
    visual_cues(["Запись началась. Пожалуйста, убедитесь, что ваше устройство работает корректно."], "Начало записи");
}

function visual_cues(messages, title = "Уведомление") {
    let overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "100vw";
    overlay.style.height = "100vh";
    overlay.style.backgroundColor = "rgba(0, 0, 0, 0.5)";
    overlay.style.display = "flex";
    overlay.style.justifyContent = "center";
    overlay.style.alignItems = "center";
    overlay.style.zIndex = "1000";

    let modal = document.createElement("div");
    modal.style.backgroundColor = "white";
    modal.style.padding = "20px";
    modal.style.borderRadius = "10px";
    modal.style.boxShadow = "0 4px 8px rgba(0, 0, 0, 0.2)";
    modal.style.textAlign = "center";
    modal.style.minWidth = "300px";

    let header = document.createElement("h2");
    header.textContent = title;
    modal.appendChild(header);

    let messageContainer = document.createElement("div");
    if (!Array.isArray(messages)) {
        messages = [messages];
    }
    messages.forEach(msg => {
        let p = document.createElement("p");
        p.textContent = msg;
        messageContainer.appendChild(p);
    });
    modal.appendChild(messageContainer);

    let button = document.createElement("button");
    button.textContent = "Хорошо. Я прочитал(а).";
    button.style.marginTop = "15px";
    button.style.padding = "10px 20px";
    button.style.border = "none";
    button.style.backgroundColor = "#007BFF";
    button.style.color = "white";
    button.style.borderRadius = "5px";
    button.style.cursor = "pointer";
    button.onclick = function() {
        document.body.removeChild(overlay);
    };
    modal.appendChild(button);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
}
