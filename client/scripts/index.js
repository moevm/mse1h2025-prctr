import { buttonsStatesSave, deleteFiles, getCurrentDateString, showModalNotify } from "./common.js";
import { logClientAction, checkAndCleanLogs, clearLogs } from "./logger.js";

const noPatronymicCheckbox = document.querySelector('#no_patronymic_checkbox');
const permissionsStatus = document.querySelector('#permissions-status');
const startDate = document.querySelector('#start-date');
const recordTime = document.querySelector('#record-time')

let timerInterval = null;
let startTime = null;
let server_connection = false;
chrome.storage.local.set({'server_connection': server_connection});

const inputElements = {
	group: document.querySelector('#group_input'),
	name: document.querySelector('#name_input'),
	surname: document.querySelector('#surname_input'),
	patronymic: document.querySelector('#patronymic_input'),
	link: document.querySelector('#link_input')
};

const buttonElements = {
	permissions: document.querySelector('.record-section__button_permissions'),
	start: document.querySelector('.record-section__button_record-start'),
	stop: document.querySelector('.record-section__button_record-stop'),
	upload: document.querySelector('.record-section__button_upload'),
    help: document.querySelector('.help-button'),
};

if (!server_connection) {
    buttonElements.upload.style.display = 'None';
    buttonElements.permissions.style.width = '368px';
}

const bStates = {
	'needPermissions': {
		permissions: 1,
		start: 0,
		stop: 0,
		upload: 0
	},
	'readyToRecord': {
		permissions: 0,
		start: 1,
		stop: 0,
		upload: 0
	},
	'recording': {
		permissions: 0,
		start: 0,
		stop: 1,
		upload: 0
	},
	'readyToUpload': {
		permissions: 0,
		start: 0,
		stop: 0,
		upload: 1
	},
	'failedUpload': {
		permissions: 1,
		start: 0,
		stop: 0,
		upload: 1
	}
}

const validationRules = {
    group: {
        regex: /^\d{4}$/, 
        message: "Группа должна содержать ровно 4 цифры. Пример: '1234'"
    },
    name: {
        regex: /^[A-ZА-ЯЁ][a-zа-яёA-ZА-ЯЁ-]*$/,
        message: "Имя должно начинаться с заглавной буквы и содержать только русские/латинские буквы и тире. Пример: 'Иван'"
    },
    surname: {
        regex: /^[A-ZА-ЯЁ][a-zа-яёA-ZА-ЯЁ-]*$/,
        message: "Фамилия должна начинаться с заглавной буквы и содержать только русские/латинские буквы и тире. Пример: 'Иванов'"
    },
    patronymic: {
        regex: /^[A-ZА-ЯЁ][a-zа-яёA-ZА-ЯЁ-]*$/,
        message: "Отчество должно начинаться с заглавной буквы и содержать только русские/латинские буквы и тире. Пример: 'Иванович'"
    },
    link: {
        regex: /.+/,
        message: "Ссылка на комнату не должна быть пустой."
    }
};

buttonElements.help.addEventListener('click', () => {
    const url = chrome.runtime.getURL('pages/help.html');

    chrome.tabs.query({}, (tabs) => {
        const existingTab = tabs.find(tab => tab.url === url);
        if (existingTab) {
            chrome.tabs.update(existingTab.id, { active: true });
        } else {
            chrome.tabs.create({ url });
        }
    });
});

function validateInput(input) {
    const rule = validationRules[input.id.replace('_input', '')];
    const messageElement = input.nextElementSibling;

    input.classList.remove('input-valid', 'input-invalid');
    messageElement.classList.remove('message-error');
    input.dataset.emptyChecked = '';

    if (!input.value.trim()) {
        messageElement.textContent = rule.message;
        return;
    }

    if (!rule.regex.test(input.value)) {
        messageElement.textContent = rule.message;
        input.classList.add('input-invalid');
        messageElement.classList.add('message-error');
    } else {
        messageElement.textContent = "";
        input.classList.add('input-valid');
    }
}

function handleFocus(event) {
    const input = event.target;
    const rule = validationRules[input.id.replace('_input', '')];
    const messageElement = input.nextElementSibling;
    
    if (!input.value.trim()) {
        messageElement.textContent = rule.message;
        input.classList.remove('input-valid', 'input-invalid');
        messageElement.classList.remove('message-error');
        input.dataset.emptyChecked = '';
    }
}

function handleBlur(event) {
    const input = event.target;
    const messageElement = input.nextElementSibling;
    
    if (!input.value.trim()) {
        messageElement.textContent = "";
    } else {
        validateInput(input);
    }
}

function saveInputValues() {
    chrome.storage.local.set({
        'inputElementsValue': {
            group: inputElements.group.value,
            name: inputElements.name.value,
            surname: inputElements.surname.value,
            patronymic: inputElements.patronymic.value,
            noPatronymicChecked: noPatronymicCheckbox.checked,
            link: inputElements.link.value
        }
    });
    logClientAction({ action: "Save input values" });
}

function formatDateTime(date) {
    logClientAction({action: "formatDateTime", date});
    return date.toLocaleString('ru-RU', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

function updateStartDateDisplay(dateStr) {
    logClientAction({ action: "updateStartDateDisplay", dateStr});
    startDate.textContent = dateStr || '-';
}

function updateRecordTimer() {
    if (!startTime) return;

    const now = new Date();
    const diffMs = now - startTime;

    const seconds = Math.floor((diffMs / 1000) % 60);
    const minutes = Math.floor((diffMs / 1000 / 60) % 60);
    const hours = Math.floor(diffMs / 1000 / 60 / 60);

    const timeStr = `${hours.toString().padStart(2, '0')}:` +
        `${minutes.toString().padStart(2, '0')}:` +
        `${seconds.toString().padStart(2, '0')}`;

    recordTime.textContent = timeStr;
}

// Проверка разрешений камеры, микрофона, экрана
async function updatePermissionsStatus() {
    let micStatus = '✗ Микрофон';
    let camStatus = '✗ Камера';
    let screenStatus = '✗ Экран';

    try {
        const micPermission = await navigator.permissions.query({ name: 'microphone' });
        micStatus = micPermission.state === 'granted' ? '✓ Микрофон' : '✗ Микрофон';
    } catch (e) {
        console.log('Microphone permission check failed:', e);
        logClientAction({ action: 'Microphone permission check failed:', e});
    }

    try {
        const camPermission = await navigator.permissions.query({ name: 'camera' });
        camStatus = camPermission.state === 'granted' ? '✓ Камера' : '✗ Камера';
    } catch (e) {
        console.log('Camera permission check failed:', e);
        logClientAction({ action: 'Camera permission check failed:', e});
    }

    try {
        const response = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'getScreenCaptureStatus' }, (response) => {
                resolve(response);
            });
        });

        if (response?.active) {
            screenStatus = '✓ Экран';
        }
    } catch (e) {
        console.log('Screen status check failed:', e);
        logClientAction({ action: 'Screen status check failed:', e});
    }

    permissionsStatus.textContent = `${micStatus} | ${camStatus} | ${screenStatus}`;

    logClientAction("updatePermissionsStatus" + `${micStatus} | ${camStatus} | ${screenStatus}`)
}

function savePatronymic() {
    chrome.storage.local.set({
        'savedPatronymic': inputElements.patronymic.value
    });
    logClientAction({ action: "Save patronymic value" });
}

noPatronymicCheckbox.addEventListener('change', async () => {
    if (noPatronymicCheckbox.checked) {
        savePatronymic();
        inputElements.patronymic.value = '';
        inputElements.patronymic.disabled = true;
        inputElements.patronymic.nextElementSibling.textContent = "";
        inputElements.patronymic.style.backgroundColor = "#f7c2ae";
        inputElements.patronymic.style.opacity = 0.5;
        inputElements.patronymic.placeholder = "";

        inputElements.patronymic.classList.remove('input-valid', 'input-invalid');
        inputElements.patronymic.dataset.emptyChecked = '';
    } else {
        let storedData = await chrome.storage.local.get('savedPatronymic');
        inputElements.patronymic.value = storedData.savedPatronymic || "";
        inputElements.patronymic.disabled = false;
        inputElements.patronymic.style.backgroundColor = "";
        inputElements.patronymic.placeholder = "Введите отчество";
        inputElements.patronymic.style.opacity = 1;
        validateInput(inputElements.patronymic);
    }
    saveInputValues();
    logClientAction({ action: "Toggle no patronymic checkbox", checked: noPatronymicCheckbox.checked });
});

document.querySelectorAll('input').forEach(input => {
    input.setAttribute('autocomplete', 'off');
});

async function updateButtonsStates() {
	let bState = (await chrome.storage.local.get('bState'))['bState'];
	if (!bState) {
		bState = 'needPermissions';
	}
	Object.entries(bStates[bState]).forEach(function([key, state]) {
		if (state === 0) {
			buttonElements[key].classList.add('record-section__button_inactive');
			buttonElements[key].setAttribute('disabled', true);
			buttonElements[key].classList.remove(`record-section__button_inprogress`);
			buttonElements[key].classList.remove(`record-section__button_active_${key}`);
		}
		else if (state === 1) {
			buttonElements[key].classList.add(`record-section__button_active_${key}`);
			buttonElements[key].removeAttribute('disabled');
			buttonElements[key].classList.remove('record-section__button_inactive');
			buttonElements[key].classList.remove('record-section__button_inprogress');
		}
		else if (state === 2) {
			buttonElements[key].classList.add(`record-section__button_inprogress`);
			buttonElements[key].classList.remove(`record-section__button_active_${key}`);
			buttonElements[key].classList.remove('record-section__button_inactive');
			buttonElements[key].setAttribute('disabled', true);
		}
	});
    logClientAction({ action: "Update button states" });
}

window.addEventListener('load', async () => {
	logClientAction({ action: "Open popup" });

	await checkAndCleanLogs();
	logClientAction('Old logs cleaned due to 24-hour inactivity');

    let inputValues = await chrome.storage.local.get('inputElementsValue');
    inputValues = inputValues.inputElementsValue || {};    
    for (const [key, value] of Object.entries(inputValues)) {
        if (key === 'noPatronymicChecked') {
            noPatronymicCheckbox.checked = value;
            if (value) {
                inputElements.patronymic.value = "";
                inputElements.patronymic.setAttribute('disabled', '');
                inputElements.patronymic.nextElementSibling.textContent = "";
                inputElements.patronymic.style.backgroundColor = "#f7c2ae";
                inputElements.patronymic.style.opacity = 0.5;
                inputElements.patronymic.placeholder = "";
            }
        } else {
            const input = inputElements[key];
            input.value = value;
            if (value.trim()) { 
                validateInput(input);
            } else {
                input.nextElementSibling.textContent = "";
            }
        }
    }

    Object.values(inputElements).forEach(input => {
        input.addEventListener('input', () => {
            input.value = input.value.trim()
            validateInput(input);
            saveInputValues();
        });
        input.addEventListener('focus', handleFocus);
        input.addEventListener('blur', handleBlur);
    });

	updateButtonsStates();
    
    updatePermissionsStatus();
    setInterval(updatePermissionsStatus, 2000); // Обновление каждые 2 секунды

    chrome.storage.local.get(['lastRecordTime', 'bState', 'timeStr'], (result) => {
        if (result.lastRecordTime) {
            startTime = new Date(result.lastRecordTime);
            updateStartDateDisplay(formatDateTime(startTime));

            if (result.bState === 'recording') {
                updateRecordTimer();

                if (timerInterval) {
                    clearInterval(timerInterval);
                }

                timerInterval = setInterval(updateRecordTimer, 1000);
            } else if (result.timeStr) {
                recordTime.textContent = result.timeStr;
            } else {
                recordTime.textContent = '-';
            }
        } else {
            updateStartDateDisplay('-');
            recordTime.textContent = '-';
        }
    });
});

buttonElements.permissions.addEventListener('click', () => {
    logClientAction({ action: "Click permissions button" });
    chrome.runtime.sendMessage({
        action: "getPermissions",
        activateMediaTab: true
    });
    logClientAction({ action: "Send message", messageType: "getPermissions" });
});

buttonElements.upload.addEventListener('click', async () => {
    logClientAction({ action: "Click upload button" });
    if (!server_connection) return;
	const files = (await chrome.storage.local.get('tempFiles'))['tempFiles'];
	if (!files) {
		buttonsStatesSave('needPermissions');
		updateButtonsStates();
	}
    logClientAction({ action: "Start uploading video" });
	uploadVideo()
    .then(() => {
        buttonsStatesSave('needPermissions');
        updateButtonsStates();
        //await showModalNotify(["Запись успешно отправлена на сервер."], "Запись отправлена");
    })
    .catch(() => {
        buttonsStatesSave('failedUpload');
        updateButtonsStates();
    });
});

async function startRecCallback() {
    logClientAction({ action: "Click start record button" });
    let allValid = true;
    Object.values(inputElements).forEach(input => {
        if (input !== inputElements.patronymic || !noPatronymicCheckbox.checked) {
            validateInput(input);
            const valueIsEmpty = !input.value.trim();
            const hasInvalidClass = input.classList.contains('input-invalid');

            if (valueIsEmpty) {
                allValid = false;

                // Если еще не была проверка на пустоту — пометить
                if (!input.dataset.emptyChecked) {
                    input.classList.add('input-invalid');
                    const rule = validationRules[input.id.replace('_input', '')];
                    input.nextElementSibling.textContent = rule.message;
                    input.nextElementSibling.classList.add('message-error');
                    input.dataset.emptyChecked = 'true';
                }
            } else if (hasInvalidClass) {
                allValid = false;
            }
        }
    });
    if (!allValid) {
        logClientAction({ action: "Block recording due to validation errors" });
        return;
    }

    buttonElements.start.setAttribute('disabled', '');
    buttonElements.stop.removeAttribute('disabled');
    saveInputValues();

    const now = new Date();
    startTime = now;
    updateStartDateDisplay(formatDateTime(now));

    updateRecordTimer();

    if (timerInterval) {
        clearInterval(timerInterval);
    }

    timerInterval = setInterval(updateRecordTimer, 1000);

    const formData = {
        group: inputElements.group.value,
        name: inputElements.name.value,
        surname: inputElements.surname.value,
        patronymic: noPatronymicCheckbox.checked ? "Без_отчества" : inputElements.patronymic.value.trim(),
        link: inputElements.link.value
    };

    chrome.runtime.sendMessage({
        action: "startRecord",
        formData: formData,
        activateMediaTab: false
    });
    logClientAction({ action: "Send message", messageType: "startRecord" });
}

chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "disableButtons") {
        buttonElements.start.removeAttribute('disabled');
        buttonElements.stop.setAttribute('disabled', '');
        logClientAction({ action: "Receive message", messageType: "disableButtons" });
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'stopRecordSignal') {
        clearInterval(timerInterval);
        chrome.storage.local.get(['timeStr'], (result) => {
            const timeStr = result.timeStr;
            recordTime.textContent = timeStr;
            sendResponse({status: 'stopRecordSignalProcessed'});
        });
        return true;
    }
});

async function stopRecCallback() {
    logClientAction({ action: "Click stop record button" });
	buttonElements.stop.setAttribute('disabled', '');
	buttonElements.start.removeAttribute('disabled');
	await chrome.runtime.sendMessage({
		action: "stopRecord",
        activateMediaTab: false
	});
    logClientAction({ action: "Send message", messageType: "stopRecord" });
}

buttonElements.start.addEventListener('click', startRecCallback);
buttonElements.stop.addEventListener('click', stopRecCallback);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'updateButtonStates') {
        chrome.storage.local.set({ bState: message.state }, () => {
            updateButtonsStates();
            sendResponse({ status: 'success' });
        });
        return true;
    }
    return false;
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "closePopup") {
        window.close();
        logClientAction({ action: "Receive message", messageType: "updateButtonStates" });
    }
});

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
        const rootDirectory = await navigator.storage.getDirectory();

        for (const filename of files) {
            if (filename.includes('screen')) {
                formData.append('screen_video', await (await rootDirectory.getFileHandle(filename, {create: false})).getFile(), filename);
            } else {
                formData.append('camera_video', await (await rootDirectory.getFileHandle(filename, {create: false})).getFile(), filename);
            }
        }
        
        formData.append("id", session_id);
        const metadata = (await chrome.storage.local.get('metadata'))['metadata'] || {};
        formData.append("metadata", metadata);

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

        const eventSource = new EventSource(`http://127.0.0.1:5000/progress/${session_id}`);

        const steps = 7;

        eventSource.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            if (data.step == steps) {
                logClientAction({ action: "Data transfer completed" });
                eventSource.close();
                await showModalNotify([`Статус: ${data.message}`,
                    `Отправка завершена на 100 %`], "Записи успешно отправлены", true, true);
            } else {
                await showModalNotify([`Статус: ${data.message}`,
                    `Отправка завершена на ${data.step * Math.floor(100 / steps)} %`], "Идёт отправка...", true, true);
            }
        };
        
        // Срабатывает когда не удаётся установить соединение с источником событий
        // TODO Наполнить err полезной информацией
        eventSource.onerror = async (err) => {
            logClientAction({ action: `An error occurred while trying to connect to the server: ${JSON.stringify(err)}` });
            eventSource.close();
            await showModalNotify([`Произошла ошибка при попытке соединения с сервером!`,
                "Попробуйте отправить запись ещё раз!",
                "Свяжитесь с преподавателем, если не удалось отправить три раза!",
            ], 'Ошибка при соединении', true, true);
        };

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
                await deleteFiles();
                await clearLogs();
                logClientAction({ action: "Clear logs after upload video" });
            })
            .catch(error => {
                console.error("Ошибка при отправке видео на сервер:", error);
                buttonsStatesSave('failedUpload');
                updateButtonsStates();
                logClientAction({ action: "Upload video fails", error: error.message, sessionId: session_id });
            });
    });
}