import { deleteFilesFromTempList } from "./common.js";
import { log_client_action } from "./logger.js";

const startRecordButton = document.querySelector('.record-section__button_record-start');
const stopRecordButton = document.querySelector('.record-section__button_record-stop');
const uploadButton = document.querySelector('.upload_button');

const inputElements = {
	group: document.querySelector('#group_input'),
	name: document.querySelector('#name_input'),
	surname: document.querySelector('#surname_input'),
	patronymic: document.querySelector('#patronymic_input')
};

function saveInputValues() {
	chrome.storage.local.set({
		'inputElementsValue': {
			group: inputElements.group.value,
			name: inputElements.name.value,
			surname: inputElements.surname.value,
			patronymic: inputElements.patronymic.value
		}
	});
	log_client_action('Input values saved');
}

async function checkAndCleanLogs() {
	const now = new Date();
	const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

	const lastRecord = await chrome.storage.local.get('lastRecordTime');
	const lastRecordTime = lastRecord.lastRecordTime ? new Date(lastRecord.lastRecordTime) : null;

	if (!lastRecordTime || lastRecordTime < oneDayAgo) {
		const logsResult = await chrome.storage.local.get('extension_logs');
		if (logsResult.extension_logs) {
			const logs = JSON.parse(logsResult.extension_logs);
			const cleanedLogs = logs.filter(log => {
				const logTime = new Date(log.time_act);
				return (now - logTime) <= 24 * 60 * 60 * 1000;
			});

			await chrome.storage.local.set({
				'extension_logs': JSON.stringify(cleanedLogs)
			});
		}
	}
}


window.addEventListener('load', async () => {
	log_client_action('Popup opened');

	await checkAndCleanLogs();
	log_client_action('Old logs cleaned due to 24-hour inactivity');

	let inputValues = await chrome.storage.local.get('inputElementsValue');
	inputValues = inputValues.inputElementsValue || {};
	for (const [key, value] of Object.entries(inputValues)) {
		inputElements[key].value = value;
	}

	Object.values(inputElements).forEach(input => {
		input.addEventListener('input', saveInputValues);
	});
});

async function startRecCallback() {
	startRecordButton.setAttribute('disabled', '');
	stopRecordButton.removeAttribute('disabled');
	saveInputValues();

	//TODO привести к формату JSON
	const browserFingerprint = {
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

	log_client_action({
		action: 'Start recording initiated',
		browserFingerprint: browserFingerprint
	});


	await chrome.storage.local.set({
		'lastRecordTime': new Date().toISOString()
	});

	const formData = new FormData();
	formData.append('group', inputElements.group.value);
	formData.append('name', inputElements.name.value);
	formData.append('surname', inputElements.surname.value);
	formData.append('patronymic', inputElements.patronymic.value);

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

		chrome.storage.local.set({'session_id': sessionId}, () => {
			console.log('session_id успешно сохранён!');
			log_client_action(`Session initialized with ID: ${sessionId}`);
		});

	} catch (error) {
		console.error("Ошибка инициализации сессии", error);
		log_client_action(`Session initialization failed: ${error.message}`);
		startRecordButton.removeAttribute('disabled');
		stopRecordButton.setAttribute('disabled', '');
		return;
	}

	// После успешной инициализации сессии отправляем сообщение для начала записи
	await chrome.runtime.sendMessage({
		action: "startRecord"
	});
	log_client_action('Start recording message sent');
}

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

uploadButton.addEventListener('click', async () => {
	console.log("Отправка...");
	const fileNames = await chrome.storage.local.get('fileNames')['fileNames'];
	if (!fileNames || !fileNames.screen || !fileNames.camera) {
		console.log('Один или оба файла не найдены!');
		return;
	}

	const rootDirectory = await navigator.storage.getDirectory();

	const screenFileHandle = await rootDirectory.getFileHandle(fileNames.screen, { create: false });
	const cameraFileHandle = await rootDirectory.getFileHandle(fileNames.camera, { create: false });

	const screenFile = await screenFileHandle.getFile();
	const cameraFile = await cameraFileHandle.getFile();

	if (!screenFile || !cameraFile) {
		console.log('Один или оба файла не найдены!');
		return;
	}

	const username = inputElements.name.value;
	const formData = new FormData();
	formData.append('screen_file', screenFile);  // Файл экрана
	formData.append('camera_file', cameraFile);  // Файл камеры
	formData.append('username', username);
	formData.append('start', startRecordTime);
	formData.append('end', finishRecordTime);

	fetch('http://127.0.0.1:5000/upload', {
		method: 'POST',
		mode: 'cors',
		body: formData,
	})
		.then(res => {
			if (res.ok) {
				return res.json();
			}
			return Promise.reject(`Ошибка при загрузке файлов: ${res.status}`);
		})
		.then(async () => {
			console.log('Файлы успешно загружены');
			await deleteFilesFromTempList();
			chrome.alarms.get('dynamicCleanup', (alarm) => {
				if (alarm) {
					chrome.alarms.clear('dynamicCleanup');
				}
			});
		})
		.catch(err => {
			console.log(err);
		});
});