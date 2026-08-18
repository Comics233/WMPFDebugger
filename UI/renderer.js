const desktop = window.wmpfDesktop;

const elements = {
    globalState: document.querySelector("#global-state"),
    globalStateText: document.querySelector("#global-state-text"),
    runtimeMessage: document.querySelector("#runtime-message"),
    endpointValue: document.querySelector("#endpoint-value"),
    copyEndpointButton: document.querySelector("#copy-endpoint-button"),
    guideButton: document.querySelector("#guide-button"),
    browserGuideButton: document.querySelector("#browser-guide-button"),
    form: document.querySelector("#control-form"),
    debugPort: document.querySelector("#debug-port"),
    cdpPort: document.querySelector("#cdp-port"),
    debugMain: document.querySelector("#debug-main"),
    debugFrida: document.querySelector("#debug-frida"),
    portError: document.querySelector("#port-error"),
    startButton: document.querySelector("#start-button"),
    stopButton: document.querySelector("#stop-button"),
    openDevToolsButton: document.querySelector("#open-devtools-button"),
    refreshDevToolsButton: document.querySelector("#refresh-devtools-button"),
    clearLogButton: document.querySelector("#clear-log-button"),
    backendCard: document.querySelector("#backend-card"),
    backendValue: document.querySelector("#backend-value"),
    backendMeta: document.querySelector("#backend-meta"),
    runtimeCard: document.querySelector("#runtime-card"),
    runtimeValue: document.querySelector("#runtime-value"),
    runtimeMeta: document.querySelector("#runtime-meta"),
    miniappCard: document.querySelector("#miniapp-card"),
    miniappValue: document.querySelector("#miniapp-value"),
    miniappMeta: document.querySelector("#miniapp-meta"),
    cdpCard: document.querySelector("#cdp-card"),
    cdpValue: document.querySelector("#cdp-value"),
    cdpMeta: document.querySelector("#cdp-meta"),
    workflowService: document.querySelector("#workflow-service"),
    workflowMiniapp: document.querySelector("#workflow-miniapp"),
    workflowConsole: document.querySelector("#workflow-console"),
    logViewport: document.querySelector("#log-viewport"),
    logList: document.querySelector("#log-list"),
    emptyLog: document.querySelector("#empty-log"),
    logCount: document.querySelector("#log-count"),
    toastRegion: document.querySelector("#toast-region"),
    filters: [...document.querySelectorAll("[data-filter]")],
};

const STORAGE_KEY = "wmpf-control-deck-config-v1";
const PHASE_LABELS = {
    idle: "系统待机",
    starting: "正在启动",
    running: "服务运行中",
    stopping: "正在停止",
    error: "运行异常",
};
const SOURCE_LABELS = {
    system: "SYSTEM",
    server: "SERVER",
    backend: "BACKEND",
    frida: "FRIDA",
    miniapp: "MINIAPP",
    cdp: "CDP",
};

let state = null;
let logs = [];
let activeFilter = "all";
let busy = false;

function setText(element, value) {
    element.textContent = String(value);
}

function setCard(card, valueElement, metaElement, tone, value, meta) {
    card.dataset.tone = tone;
    setText(valueElement, value);
    setText(metaElement, meta);
}

function setWorkflow(element, stepState) {
    element.dataset.stepState = stepState;
}

function getConfigFromForm() {
    return {
        debugPort: Number(elements.debugPort.value),
        cdpPort: Number(elements.cdpPort.value),
        debugMain: elements.debugMain.checked,
        debugFrida: elements.debugFrida.checked,
    };
}

function validateConfig(config) {
    for (const [label, value] of [
        ["调试端口", config.debugPort],
        ["CDP 端口", config.cdpPort],
    ]) {
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
            return `${label}必须是 1–65535 之间的整数`;
        }
    }
    if (config.debugPort === config.cdpPort) {
        return "调试端口和 CDP 端口不能相同";
    }
    return "";
}

function showValidationError(message) {
    elements.portError.hidden = !message;
    setText(elements.portError, message);
    elements.debugPort.setAttribute("aria-invalid", message ? "true" : "false");
    elements.cdpPort.setAttribute("aria-invalid", message ? "true" : "false");
}

function saveConfig(config) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
        // 本地偏好保存失败不应阻断调试流程。
    }
}

function restoreConfig() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (!saved || validateConfig(saved)) return;
        elements.debugPort.value = String(saved.debugPort);
        elements.cdpPort.value = String(saved.cdpPort);
        elements.debugMain.checked = Boolean(saved.debugMain);
        elements.debugFrida.checked = Boolean(saved.debugFrida);
    } catch {
        // 忽略损坏的本地配置，继续使用默认值。
    }
}

function showToast(title, message, tone = "success") {
    const toast = document.createElement("div");
    const content = document.createElement("div");
    const strong = document.createElement("strong");
    const detail = document.createElement("span");
    toast.className = "toast";
    toast.dataset.tone = tone;
    toast.setAttribute("role", tone === "error" ? "alert" : "status");
    setText(strong, title);
    setText(detail, message);
    content.append(strong, detail);
    toast.append(content);
    elements.toastRegion.append(toast);
    window.setTimeout(() => toast.remove(), 4000);
}

function readableError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/^Error invoking remote method '[^']+':\s*/i, "");
}

function isServiceActive() {
    return state && ["starting", "running", "stopping"].includes(state.phase);
}

function renderState(nextState) {
    state = nextState;
    const phase = state.phase || "idle";
    const active = isServiceActive();
    const ports = state.config || getConfigFromForm();
    const endpoint = `127.0.0.1:${ports.cdpPort}`;

    elements.globalState.dataset.state = phase;
    setText(elements.globalStateText, PHASE_LABELS[phase] || "状态未知");
    setText(elements.runtimeMessage, state.message || "等待启动调试服务");
    setText(elements.endpointValue, endpoint);

    if (active) {
        elements.debugPort.value = String(ports.debugPort);
        elements.cdpPort.value = String(ports.cdpPort);
        elements.debugMain.checked = Boolean(ports.debugMain);
        elements.debugFrida.checked = Boolean(ports.debugFrida);
    }

    const controlsLocked = busy || active;
    elements.debugPort.disabled = controlsLocked;
    elements.cdpPort.disabled = controlsLocked;
    elements.debugMain.disabled = controlsLocked;
    elements.debugFrida.disabled = controlsLocked;
    elements.startButton.disabled = busy || active;
    elements.stopButton.disabled = busy || !active || phase === "stopping";
    elements.openDevToolsButton.disabled = busy || !state.proxyServerReady;
    elements.refreshDevToolsButton.disabled = busy || !state.devToolsOpen;

    if (phase === "error") {
        setCard(
            elements.backendCard,
            elements.backendValue,
            elements.backendMeta,
            "danger",
            "启动异常",
            state.exitCode == null ? "请查看错误日志" : `退出码 ${state.exitCode}`,
        );
    } else if (phase === "starting" || phase === "stopping") {
        setCard(
            elements.backendCard,
            elements.backendValue,
            elements.backendMeta,
            "warning",
            phase === "starting" ? "初始化中" : "停止中",
            state.pid ? `PID ${state.pid}` : "等待后端进程",
        );
    } else if (phase === "running") {
        setCard(
            elements.backendCard,
            elements.backendValue,
            elements.backendMeta,
            "success",
            "服务就绪",
            `DEBUG ${ports.debugPort} · CDP ${ports.cdpPort}`,
        );
    } else {
        setCard(
            elements.backendCard,
            elements.backendValue,
            elements.backendMeta,
            "neutral",
            "未启动",
            `DEBUG ${ports.debugPort} · CDP ${ports.cdpPort}`,
        );
    }

    if (state.wmpfVersion) {
        setCard(
            elements.runtimeCard,
            elements.runtimeValue,
            elements.runtimeMeta,
            "success",
            `WMPF ${state.wmpfVersion}`,
            state.wmpfPid ? `微信进程 PID ${state.wmpfPid}` : "Hook 已注入",
        );
    } else {
        setCard(
            elements.runtimeCard,
            elements.runtimeValue,
            elements.runtimeMeta,
            phase === "error" ? "danger" : active ? "warning" : "neutral",
            active ? "正在检测" : "等待检测",
            active ? "等待 Hook 注入" : "尚未注入 Hook",
        );
    }

    setCard(
        elements.miniappCard,
        elements.miniappValue,
        elements.miniappMeta,
        state.miniappConnected ? "success" : active ? "warning" : "neutral",
        state.miniappConnected ? "已连接" : "未连接",
        state.miniappConnected ? "微信运行时链路正常" : active ? "请在微信中打开小程序" : "等待微信端接入",
    );

    const cdpTone = state.cdpConnected ? "success" : state.devToolsOpen ? "warning" : "neutral";
    setCard(
        elements.cdpCard,
        elements.cdpValue,
        elements.cdpMeta,
        cdpTone,
        state.cdpConnected ? "会话已建立" : state.devToolsOpen ? "正在连接" : "未连接",
        state.devToolsOpen ? `DevTools · ${endpoint}` : "控制台尚未打开",
    );

    const serviceDone = phase === "running";
    setWorkflow(elements.workflowService, serviceDone ? "done" : active ? "current" : "current");
    setWorkflow(
        elements.workflowMiniapp,
        state.miniappConnected ? "done" : serviceDone ? "current" : "pending",
    );
    setWorkflow(
        elements.workflowConsole,
        state.cdpConnected ? "done" : state.miniappConnected ? "current" : "pending",
    );
}

function matchesFilter(entry) {
    if (activeFilter === "all") return true;
    if (activeFilter === "error") return entry.level === "error";
    if (activeFilter === "link") return ["miniapp", "cdp"].includes(entry.source);
    if (activeFilter === "server") {
        return ["server", "backend", "system"].includes(entry.source);
    }
    return entry.source === activeFilter;
}

function formatTime(timestamp) {
    return new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).format(new Date(timestamp));
}

function createLogElement(entry) {
    const item = document.createElement("li");
    const time = document.createElement("span");
    const source = document.createElement("span");
    const message = document.createElement("span");

    item.className = "log-entry";
    item.dataset.level = entry.level || "info";
    item.dataset.source = entry.source || "system";
    time.className = "log-time";
    source.className = "log-source";
    message.className = "log-message";
    setText(time, formatTime(entry.timestamp));
    setText(source, SOURCE_LABELS[entry.source] || String(entry.source || "LOG").toUpperCase());
    setText(message, entry.message);
    item.append(time, source, message);
    return item;
}

function renderLogs() {
    const filtered = logs.filter(matchesFilter);
    const shouldFollow =
        elements.logViewport.scrollHeight - elements.logViewport.scrollTop - elements.logViewport.clientHeight < 48;
    const fragment = document.createDocumentFragment();
    for (const entry of filtered) fragment.append(createLogElement(entry));
    elements.logList.replaceChildren(fragment);
    elements.emptyLog.hidden = filtered.length > 0;
    setText(
        elements.logCount,
        activeFilter === "all"
            ? `${filtered.length} 条记录`
            : `${filtered.length} / ${logs.length} 条记录`,
    );
    if (shouldFollow) elements.logViewport.scrollTop = elements.logViewport.scrollHeight;
}

async function runAction(action, successMessage) {
    if (busy) return;
    busy = true;
    if (state) renderState(state);
    try {
        const nextState = await action();
        if (nextState) renderState(nextState);
        if (successMessage) showToast("操作完成", successMessage);
    } catch (error) {
        showToast("操作失败", readableError(error), "error");
    } finally {
        busy = false;
        if (state) renderState(state);
    }
}

elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    const config = getConfigFromForm();
    const error = validateConfig(config);
    showValidationError(error);
    if (error) return;
    saveConfig(config);
    runAction(() => desktop.start(config));
});

for (const input of [elements.debugPort, elements.cdpPort]) {
    input.addEventListener("input", () => showValidationError(validateConfig(getConfigFromForm())));
}

elements.stopButton.addEventListener("click", () => runAction(() => desktop.stop()));
elements.openDevToolsButton.addEventListener("click", () =>
    runAction(() => desktop.openDevTools(), "已打开开发者工具"),
);
elements.refreshDevToolsButton.addEventListener("click", () =>
    runAction(() => desktop.refreshDevTools(), "已刷新 DevTools 会话"),
);
elements.clearLogButton.addEventListener("click", () => runAction(() => desktop.clearLogs()));
elements.copyEndpointButton.addEventListener("click", () => {
    const endpoint = elements.endpointValue.textContent;
    runAction(() => desktop.copyText(endpoint), `已复制 ${endpoint}`);
});
elements.guideButton.addEventListener("click", () => runAction(() => desktop.openDocs("guide")));
elements.browserGuideButton.addEventListener("click", () =>
    runAction(() => desktop.openDocs("browser")),
);

for (const filter of elements.filters) {
    filter.addEventListener("click", () => {
        activeFilter = filter.dataset.filter;
        for (const item of elements.filters) {
            item.setAttribute("aria-pressed", String(item === filter));
        }
        renderLogs();
    });
}

async function initialize() {
    restoreConfig();
    if (!desktop) {
        showToast("桌面桥接不可用", "请通过 Electron 启动本面板", "error");
        elements.startButton.disabled = true;
        return;
    }

    desktop.onState((nextState) => renderState(nextState));
    desktop.onLog((entry) => {
        logs.push(entry);
        if (logs.length > 500) logs = logs.slice(-500);
        renderLogs();
    });
    desktop.onLogsCleared(() => {
        logs = [];
        renderLogs();
    });

    try {
        const initialState = await desktop.getState();
        logs = Array.isArray(initialState.logs) ? initialState.logs.slice(-500) : [];
        renderState(initialState);
        renderLogs();
    } catch (error) {
        showToast("初始化失败", readableError(error), "error");
        elements.startButton.disabled = true;
    }
}

initialize();
