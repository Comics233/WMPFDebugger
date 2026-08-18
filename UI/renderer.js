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
    autoOpenDevTools: document.querySelector("#auto-open-devtools"),
    autoOpenStatus: document.querySelector("#auto-open-status"),
    browserTargetButton: document.querySelector("#browser-target-button"),
    browserEntryStatus: document.querySelector("#browser-entry-status"),
    browserTargetCount: document.querySelector("#browser-target-count"),
    browserDrawer: document.querySelector("#browser-drawer"),
    browserDrawerBackdrop: document.querySelector("#browser-drawer-backdrop"),
    browserDrawerClose: document.querySelector("#browser-drawer-close"),
    browserRefreshButton: document.querySelector("#browser-refresh-button"),
    browserStopButton: document.querySelector("#browser-stop-button"),
    browserSessionStrip: document.querySelector(".browser-session-strip"),
    browserSessionTitle: document.querySelector("#browser-session-title"),
    browserSessionMeta: document.querySelector("#browser-session-meta"),
    browserDrawerCount: document.querySelector("#browser-drawer-count"),
    browserTargetViewport: document.querySelector(".browser-target-viewport"),
    browserTargetEmpty: document.querySelector("#browser-target-empty"),
    browserTargetEmptyTitle: document.querySelector("#browser-target-empty strong"),
    browserTargetEmptyCopy: document.querySelector("#browser-target-empty p"),
    browserTargetList: document.querySelector("#browser-target-list"),
    browserDocsButton: document.querySelector("#browser-docs-button"),
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
let browserBusy = false;
let browserDrawerReturnFocus = null;

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
        autoOpenDevTools: elements.autoOpenDevTools.checked,
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
        elements.autoOpenDevTools.checked = Boolean(saved.autoOpenDevTools);
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

function renderAutoOpenStatus() {
    setText(
        elements.autoOpenStatus,
        elements.autoOpenDevTools.checked
            ? "已开启 · 检测到连接后自动弹出"
            : "已关闭 · 保持手动打开",
    );
}

function createBrowserTargetElement(target) {
    const item = document.createElement("li");
    const kind = document.createElement("span");
    const copy = document.createElement("span");
    const title = document.createElement("span");
    const url = document.createElement("span");
    const meta = document.createElement("span");
    const button = document.createElement("button");
    const isActive = state?.browserTargetId === target.targetId && state?.browserDebugOpen;

    item.className = "browser-target-item";
    item.dataset.active = String(Boolean(isActive));
    kind.className = "target-kind";
    copy.className = "target-copy";
    title.className = "target-title";
    url.className = "target-url";
    meta.className = "target-meta";
    button.className = "target-open-button";
    button.type = "button";
    button.disabled = browserBusy;

    setText(kind, target.type === "webview" ? "WEB" : target.type);
    setText(title, target.title || "未命名页面");
    setText(url, target.url || "无页面地址");
    url.title = target.url || "";
    setText(
        meta,
        `${target.isMiniApp ? "小程序入口" : "浏览器页面"} · ${target.attached ? "已被附加" : "可连接"}`,
    );
    setText(button, isActive ? "聚焦" : "调试");
    button.addEventListener("click", () => openSelectedBrowserTarget(target));
    copy.append(title, url, meta);
    item.append(kind, copy, button);
    return item;
}

function renderBrowserTargets() {
    if (!state) return;
    const targets = Array.isArray(state.browserTargets) ? state.browserTargets : [];
    const fragment = document.createDocumentFragment();
    for (const target of targets) fragment.append(createBrowserTargetElement(target));
    elements.browserTargetList.replaceChildren(fragment);
    elements.browserTargetEmpty.hidden = targets.length > 0;
    setText(elements.browserDrawerCount, `${targets.length} TARGET${targets.length === 1 ? "" : "S"}`);
    setText(elements.browserTargetCount, targets.length ? `${targets.length} 个目标` : "待扫描");

    elements.browserTargetButton.disabled = busy || !state.miniappConnected;
    elements.browserRefreshButton.disabled = browserBusy || !state.miniappConnected;
    elements.browserStopButton.hidden = !state.browserDebugOpen;
    elements.browserStopButton.disabled = browserBusy;
    elements.browserSessionStrip.dataset.active = String(Boolean(state.browserDebugOpen));
    elements.browserDrawer.dataset.loading = String(browserBusy);

    if (state.browserDebugOpen) {
        setText(elements.browserEntryStatus, `正在调试 · ${state.browserTargetTitle || "浏览器页面"}`);
        setText(elements.browserSessionTitle, state.browserTargetTitle || "浏览器目标已附加");
        setText(
            elements.browserSessionMeta,
            state.browserTargetConnected
                ? "独立 DevTools 会话已建立"
                : "已附加目标，正在等待 DevTools 连接",
        );
    } else if (state.miniappConnected) {
        setText(
            elements.browserEntryStatus,
            targets.length ? `发现 ${targets.length} 个页面目标` : "运行时已连接 · 可以开始扫描",
        );
        setText(
            elements.browserSessionTitle,
            state.browserControllerConnected ? "目标控制通道已就绪" : "等待扫描目标",
        );
        setText(elements.browserSessionMeta, "需要保持入口小程序运行");
    } else {
        setText(elements.browserEntryStatus, "打开小程序后扫描可调试页面");
        setText(elements.browserSessionTitle, "等待小程序调试通道");
        setText(elements.browserSessionMeta, "启动服务并在微信中打开一个小程序");
    }

    if (browserBusy) {
        setText(elements.browserTargetEmptyTitle, "正在扫描微信运行时");
        setText(elements.browserTargetEmptyCopy, "正在请求 Target.getTargets，请稍候。 ");
    } else {
        setText(elements.browserTargetEmptyTitle, "尚未发现浏览器页面");
        setText(
            elements.browserTargetEmptyCopy,
            "保持小程序打开，然后重新扫描微信运行时中的页面目标。",
        );
    }
}

function openBrowserDrawer() {
    if (!state?.miniappConnected) {
        showToast("暂时无法扫描", "请先启动服务并在微信中打开一个小程序", "error");
        return;
    }
    browserDrawerReturnFocus = document.activeElement;
    elements.browserDrawer.hidden = false;
    renderBrowserTargets();
    elements.browserDrawerClose.focus();
    void refreshBrowserTargets();
}

function closeBrowserDrawer() {
    elements.browserDrawer.hidden = true;
    if (browserDrawerReturnFocus instanceof HTMLElement) browserDrawerReturnFocus.focus();
    browserDrawerReturnFocus = null;
}

async function refreshBrowserTargets() {
    if (browserBusy || !state?.miniappConnected) return;
    browserBusy = true;
    renderBrowserTargets();
    try {
        const nextState = await desktop.listBrowserTargets();
        renderState(nextState);
        if (!nextState.browserTargets.length) {
            showToast("扫描完成", "没有发现可调试的页面或 WebView");
        }
    } catch (error) {
        showToast("扫描失败", readableError(error), "error");
    } finally {
        browserBusy = false;
        renderBrowserTargets();
    }
}

async function openSelectedBrowserTarget(target) {
    if (browserBusy) return;
    browserBusy = true;
    renderBrowserTargets();
    try {
        const nextState = await desktop.openBrowserTarget(target.targetId);
        renderState(nextState);
        showToast("浏览器调试已启动", target.title || "已打开独立 DevTools 窗口");
    } catch (error) {
        showToast("无法附加页面", readableError(error), "error");
    } finally {
        browserBusy = false;
        renderBrowserTargets();
    }
}

async function stopBrowserTarget() {
    if (browserBusy) return;
    browserBusy = true;
    renderBrowserTargets();
    try {
        const nextState = await desktop.closeBrowserTarget();
        renderState(nextState);
        showToast("浏览器调试已结束", "目标会话和独立窗口已关闭");
    } catch (error) {
        showToast("关闭失败", readableError(error), "error");
    } finally {
        browserBusy = false;
        renderBrowserTargets();
    }
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
        elements.autoOpenDevTools.checked = Boolean(ports.autoOpenDevTools);
    }

    const controlsLocked = busy || active;
    elements.debugPort.disabled = controlsLocked;
    elements.cdpPort.disabled = controlsLocked;
    elements.debugMain.disabled = controlsLocked;
    elements.debugFrida.disabled = controlsLocked;
    elements.autoOpenDevTools.disabled = controlsLocked;
    renderAutoOpenStatus();
    elements.startButton.disabled = busy || active;
    elements.stopButton.disabled = busy || !active || phase === "stopping";
    elements.openDevToolsButton.disabled = busy || !state.proxyServerReady;
    elements.refreshDevToolsButton.disabled = busy || !state.devToolsOpen;
    renderBrowserTargets();

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

    const cdpSessionConnected = state.cdpConnected || state.browserTargetConnected;
    const cdpWindowOpen = state.devToolsOpen || state.browserDebugOpen;
    const cdpTone = cdpSessionConnected ? "success" : cdpWindowOpen ? "warning" : "neutral";
    setCard(
        elements.cdpCard,
        elements.cdpValue,
        elements.cdpMeta,
        cdpTone,
        cdpSessionConnected ? "会话已建立" : cdpWindowOpen ? "正在连接" : "未连接",
        state.browserDebugOpen
            ? `浏览器 · ${state.browserTargetTitle || "页面目标"}`
            : state.devToolsOpen
              ? `DevTools · ${endpoint}`
              : "控制台尚未打开",
    );

    const serviceDone = phase === "running";
    setWorkflow(elements.workflowService, serviceDone ? "done" : active ? "current" : "current");
    setWorkflow(
        elements.workflowMiniapp,
        state.miniappConnected ? "done" : serviceDone ? "current" : "pending",
    );
    setWorkflow(
        elements.workflowConsole,
        cdpSessionConnected ? "done" : state.miniappConnected ? "current" : "pending",
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

elements.autoOpenDevTools.addEventListener("change", () => {
    renderAutoOpenStatus();
    saveConfig(getConfigFromForm());
});

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
elements.browserTargetButton.addEventListener("click", openBrowserDrawer);
elements.browserDrawerClose.addEventListener("click", closeBrowserDrawer);
elements.browserDrawerBackdrop.addEventListener("click", closeBrowserDrawer);
elements.browserRefreshButton.addEventListener("click", refreshBrowserTargets);
elements.browserStopButton.addEventListener("click", stopBrowserTarget);
elements.browserDocsButton.addEventListener("click", () =>
    runAction(() => desktop.openDocs("browser")),
);

elements.browserDrawer.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        event.preventDefault();
        closeBrowserDrawer();
        return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...elements.browserDrawer.querySelectorAll("button:not(:disabled):not([hidden])")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
});

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
    renderAutoOpenStatus();
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
