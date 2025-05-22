import { buttonsStatesSave } from "./common.js";
import { logClientAction, checkAndCleanLogs, clearLogs } from "./logger.js";

const noPatronymicCheckbox = document.querySelector('#no_patronymic_checkbox');
const permissionsStatus = document.querySelector('#permissions-status');
const startDate = document.querySelector('#start-date');
const recordTime = document.querySelector('#record-time')

let timerInterval = null;
let startTime = null;
let server_connection = true;
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

    const { tempFiles: files } = await chrome.storage.local.get('tempFiles');
    if (!files || !files.length) {
        buttonsStatesSave('needPermissions');
        updateButtonsStates();
        return;
    }

    logClientAction({ action: "Send message", messageType: "uploadVideo" });

    chrome.runtime.sendMessage({
        action: "uploadVideo",
        activateMediaTab: false
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
        console.log('Received stopRecordSignal');

        clearInterval(timerInterval);

        chrome.storage.local.get(['timeStr'], (result) => {
            const timeStr = result.timeStr;
            recordTime.textContent = timeStr;
            sendResponse({status: 'stopRecordSignalProcessed'});
        });

        sendResponse({status: 'stopRecordSignalProcessed'});
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
