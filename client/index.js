import { buttonsStatesSave } from "./common.js";
import { log_client_action } from "./logger.js";

const startRecordButton = document.querySelector('.record-section__button_record-start');
const stopRecordButton = document.querySelector('.record-section__button_record-stop');
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
	upload: document.querySelector('.record-section__button_upload')
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
	log_client_action('Input values saved');
}

function formatDateTime(date) {
    return date.toLocaleString('ru-RU', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

function updateStartDateDisplay(dateStr) {
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
    }

    try {
        const camPermission = await navigator.permissions.query({ name: 'camera' });
        camStatus = camPermission.state === 'granted' ? '✓ Камера' : '✗ Камера';
    } catch (e) {
        console.log('Camera permission check failed:', e);
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
    }

    permissionsStatus.textContent = `${micStatus} | ${camStatus} | ${screenStatus}`;
}

async function checkAndCleanLogs() {
	const now = new Date();
	const delTime = 24 * 60 * 60 * 1000;
	const timeAgo = new Date(now.getTime() - delTime);

	const lastRecord = await chrome.storage.local.get('lastRecordTime');
	const lastRecordTime = lastRecord.lastRecordTime ? new Date(lastRecord.lastRecordTime) : null;

	if (!lastRecordTime || lastRecordTime < timeAgo) {
		const logsResult = await chrome.storage.local.get('extension_logs');
		if (logsResult.extension_logs) {
			const logs = JSON.parse(logsResult.extension_logs);
			const cleanedLogs = logs.filter(log => {
				const logTime = new Date(log.time_act);
				return (now - logTime) <= delTime;
			});

			await chrome.storage.local.set({
				'extension_logs': JSON.stringify(cleanedLogs)
			});
		}
	}
}

function savePatronymic() {
    chrome.storage.local.set({
        'savedPatronymic': inputElements.patronymic.value
    });
}

noPatronymicCheckbox.addEventListener('change', async () => {
    if (noPatronymicCheckbox.checked) {
        savePatronymic();
        inputElements.patronymic.value = '';
        inputElements.patronymic.disabled = true;
        inputElements.patronymic.nextElementSibling.textContent = "";
        inputElements.patronymic.style.backgroundColor = "#DCDCDC";
    } else {
        let storedData = await chrome.storage.local.get('savedPatronymic');
        inputElements.patronymic.value = storedData.savedPatronymic || "";
        inputElements.patronymic.disabled = false;
        inputElements.patronymic.style.backgroundColor = "";
        validateInput(inputElements.patronymic);
    }
    saveInputValues();
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
}

window.addEventListener('load', async () => {
	log_client_action('Popup opened');

	await checkAndCleanLogs();
	log_client_action('Old logs cleaned due to 24-hour inactivity');

    let inputValues = await chrome.storage.local.get('inputElementsValue');
    inputValues = inputValues.inputElementsValue || {};    
    for (const [key, value] of Object.entries(inputValues)) {
        if (key === 'noPatronymicChecked') {
            noPatronymicCheckbox.checked = value;
            if (value) {
                inputElements.patronymic.value = "";
                inputElements.patronymic.setAttribute('disabled', '');
                inputElements.patronymic.nextElementSibling.textContent = "";
                inputElements.patronymic.style.backgroundColor = "#DCDCDC";
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
	chrome.runtime.sendMessage({action: 'getPermissions'});
});

buttonElements.upload.addEventListener('click', async () => {
    if (!server_connection) return;
	const files = (await chrome.storage.local.get('fileNames'))['fileNames'];
	if (!files) {
		buttonsStatesSave('needPermissions');
		updateButtonsStates();
	}
	chrome.runtime.sendMessage({action: 'uploadVideoMedia'});
});

async function startRecCallback() {
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
        console.warn("Невозможно начать запись: есть ошибки или незаполненные поля.");
        return;
    }

    startRecordButton.setAttribute('disabled', '');
    stopRecordButton.removeAttribute('disabled');
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
        formData: formData
    });
    log_client_action('Start recording message sent');
}

chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "disableButtons") {
        startRecordButton.removeAttribute('disabled');
        stopRecordButton.setAttribute('disabled', '');
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
    stopRecordButton.setAttribute('disabled', '');
    startRecordButton.removeAttribute('disabled');
    log_client_action('Stop recording initiated');

    await chrome.runtime.sendMessage({
        action: "stopRecord"
    });

    log_client_action('Stop recording message sent');
}

startRecordButton.addEventListener('click', startRecCallback);
stopRecordButton.addEventListener('click', stopRecCallback);

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