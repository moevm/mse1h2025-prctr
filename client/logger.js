export function log_client_action(action) {
    chrome.storage.local.get(['extension_logs'], (result) => {
        const logs = result.extension_logs ? JSON.parse(result.extension_logs) : [];
        const time_act = new Date().toISOString();
        logs.push({ time_act, action });
        chrome.storage.local.set({ 'extension_logs': JSON.stringify(logs) }, () => {
            if (chrome.runtime.lastError) {
                console.error('Ошибка при сохранении логов:', chrome.runtime.lastError);
            }
        });
    });
}
