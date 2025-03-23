export function log_client_action(data) {
    chrome.storage.local.get(['extension_logs'], (result) => {
        const logs = result.extension_logs ? JSON.parse(result.extension_logs) : [];
        const time_act = new Date().toISOString();

        const logEntry = typeof data === 'string'
            ? { time_act, action: data }
            : { time_act, ...data };

        logs.push(logEntry);
        chrome.storage.local.set({ 'extension_logs': JSON.stringify(logs) }, () => {
            if (chrome.runtime.lastError) {
                console.error('Ошибка при сохранении логов:', chrome.runtime.lastError);
            }
        });
    });
}