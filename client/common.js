export async function deleteFilesFromTempList() {
    const tempFiles = (await chrome.storage.local.get('tempFiles'))['tempFiles'] || [];
    if (tempFiles.length > 0) {
        const root = await navigator.storage.getDirectory();
        for (const file of tempFiles) {
            await root.removeEntry(file).catch((e) => {console.log(e)});
        }
        chrome.storage.local.remove('tempFiles');
    }
}

export function showVisualCue(messages, title = "Уведомление") {

    const existingOverlay = document.getElementById('custom-modal-overlay');
    if (existingOverlay) existingOverlay.remove();

    if (!Array.isArray(messages)) {
        messages = [messages];
    }

    const overlay = document.createElement('div');
    overlay.id = 'custom-modal-overlay';

    const modal = document.createElement('div');
    modal.id = 'custom-modal';

    modal.innerHTML = `
        <h2>${title}</h2>
    <div class="modal-content">
      ${messages.map(msg => `<p>${msg}</p>`).join('')}
    </div>
    <button id="modal-close-btn">
      Хорошо. Я прочитал(а).
    </button>`;

    document.body.style.overflow = 'hidden';

    modal.querySelector('#modal-close-btn').addEventListener('click', () => {
        overlay.remove();
        document.body.style.overflow = '';
    });

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
}

export function showGlobalVisualCue(messages, title) {
    chrome.tabs.query({
        active: true,
        currentWindow: true
    }, (tabs) => {
        tabs.forEach((tab) => {
            chrome.tabs.sendMessage(tab.id, {
                action: 'showModal',
                title: title,
                message: messages
            });
        });
    });
}

export function buttonsStatesSave(state) {
	chrome.storage.local.set({'bState': state});
}