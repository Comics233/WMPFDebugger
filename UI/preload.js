const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld(
    "wmpfDesktop",
    Object.freeze({
        getState: () => ipcRenderer.invoke("runtime:get-state"),
        start: (config) => ipcRenderer.invoke("runtime:start", config),
        stop: () => ipcRenderer.invoke("runtime:stop"),
        openDevTools: () => ipcRenderer.invoke("runtime:open-devtools"),
        refreshDevTools: () => ipcRenderer.invoke("runtime:refresh-devtools"),
        clearLogs: () => ipcRenderer.invoke("runtime:clear-logs"),
        copyText: (text) => ipcRenderer.invoke("app:copy", text),
        openDocs: (name) => ipcRenderer.invoke("app:open-docs", name),
        onState: (callback) => subscribe("runtime:state", callback),
        onLog: (callback) => subscribe("runtime:log", callback),
        onLogsCleared: (callback) => subscribe("runtime:logs-cleared", callback),
    }),
);
