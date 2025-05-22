import { logClientAction } from "./logger.js";

export async function deleteFilesFromTempList() {
    const tempFiles = (await chrome.storage.local.get('tempFiles'))['tempFiles'] || [];
    if (tempFiles.length > 0) {
        const root = await navigator.storage.getDirectory();
        logClientAction({ action: "Start delete temporary files", fileCount: tempFiles.length });
        for (const file of tempFiles) {
            try {
                await root.removeEntry(file);
                logClientAction({ action: "Delete temp file", fileName: file });
            } catch (e) {
                console.log(e);
                logClientAction({ action: "Fail to delete temp file", fileName: file, error: String(e) });
            }
        }
        chrome.storage.local.remove('tempFiles');
    }
}

export async function showModalNotify(messages, title = "Уведомление", showOnActiveTab = false, mediaIntependent=false) {
    chrome.runtime.sendMessage({ action: "closePopup" });

    logClientAction({ action: "showModalNotify", showOnActiveTab});

    if (!Array.isArray(messages)) {
        messages = [messages];
    }

    if (showOnActiveTab) {
        try {
            return await sendModalNotifyToActiveTab(messages, title);
        } catch (error) {
            // console.warn('[sendModalNotifyToActiveTab] Ошибка отправки сообщения:', error.message);
            logClientAction({ action: "sendModalNotifyToActiveTab", error: error.message});
            const blockedErrors = [
                'Receiving end does not exist',
                'Could not establish connection',
                'No matching service worker',
                'The message port closed before a response was received.'
            ];

            const isBlocked = blockedErrors.some(e => error.message.includes(e));
            if (isBlocked) {
                // console.warn('[showModalNotify] Модальное уведомление не доступно на текущей вкладке. Открываем media.html');
                logClientAction({ action: "showModalNotify", info: "Modal notification is not available on the current tab. Open media.html."});
                return await showModalNotify(messages, title, false, mediaIntependent);
            }
            throw error;
        }
    } else {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({
                action: "gotoMediaTab",
                mediaExtensionUrl: chrome.runtime.getURL("pages/media.html") }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error('Error send gotoMediaTab', chrome.runtime.lastError.message);
                        logClientAction({ action: "Error send gotoMediaTab", message: chrome.runtime.lastError.message});
                    }
                    else {
                        // console.log('Response gotoMediaTab', response);
                        logClientAction({ action: "Response gotoMediaTab", response});
                    }
                });

            if (!mediaIntependent) {
                const existingOverlay = document.getElementById('custom-modal-overlay');
                if (existingOverlay) existingOverlay.remove();

                const overlay = document.createElement('div');
                overlay.id = 'custom-modal-overlay';

                const modal = document.createElement('div');
                modal.id = 'custom-modal';

                modal.innerHTML = `
                    <h2>${title}</h2>
                    <div class="modal-content">
                        ${messages.map(msg => `<p>${msg}</p>`).join('')}
                    </div>
                    <button id="modal-close-btn">Хорошо. Я прочитал(а).</button>
                `;

                modal.querySelector('#modal-close-btn').addEventListener('click', () => {
                    overlay.remove();
                    document.body.style.overflow = '';
                    resolve();
                });

                document.body.style.overflow = 'hidden';
                overlay.appendChild(modal);
                document.body.appendChild(overlay);
            } else {
                
                chrome.runtime.sendMessage({
                    type: "showModalNotifyOnMedia",
                    messages: messages,
                    title: title
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        logClientAction({ action: "showModalNotifyOnMedia", error: chrome.runtime.lastError.message});
                        return reject(new Error(chrome.runtime.lastError.message));
                    }
    
                    if (typeof response === 'undefined') {
                        logClientAction({ action: "showModalNotifyOnMedia", error: "Media didn't respond"});
                        return reject(new Error("Media не ответил"));
                    }
    
                    logClientAction({ action: "showModalNotifyOnMedia"});
    
                    resolve(response);
                });
            }
        });
    }
}

function sendModalNotifyToActiveTab(messages, title) {
    return new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (chrome.runtime.lastError) {
                logClientAction({ action: "sendModalNotifyToActiveTab", error: chrome.runtime.lastError.message});
                return reject(new Error(chrome.runtime.lastError.message));
            }

            const tab = tabs[0];
            if (!tab || !tab.id) {
                logClientAction({ action: "sendModalNotifyToActiveTab", error: "Active tab not found"})
                return reject(new Error('Активная вкладка не найдена'));
            }

            chrome.tabs.sendMessage(tab.id, {
                type: 'showModalNotifyOnActiveTab',
                title,
                messages
            }, (response) => {
                if (chrome.runtime.lastError) {
                    logClientAction({ action: "showModalNotifyOnActiveTab", error: chrome.runtime.lastError.message});
                    return reject(new Error(chrome.runtime.lastError.message));
                }

                if (typeof response === 'undefined') {
                    logClientAction({ action: "showModalNotifyOnActiveTab", error: "Content script didn't respond"});
                    return reject(new Error('Контент-скрипт не ответил'));
                }

                logClientAction({ action: "showModalNotifyOnActiveTab"});

                resolve(response);
            });
        });
    });
}

export function buttonsStatesSave(state) {
	chrome.storage.local.set({'bState': state});
    logClientAction({ action: "Save buttons states"});
}

export async function deleteFiles() {
    await deleteFilesFromTempList();
    chrome.alarms.get('dynamicCleanup', (alarm) => {
        if (alarm) {
            chrome.alarms.clear('dynamicCleanup');
        }
        logClientAction({ action: "Delete temp files succeeds" });    
    });
}

export function getCurrentDateString(date) {
    logClientAction({ action: "Generate current date string" });
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T` + 
    `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}
