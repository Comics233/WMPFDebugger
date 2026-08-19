const {
    app,
    BrowserWindow,
    Menu,
    clipboard,
    crashReporter,
    ipcMain,
    shell,
    utilityProcess,
} = require("electron");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const WebSocket = require("ws");
const { WebSocketServer } = require("ws");

const isSquirrelStartup = require("electron-squirrel-startup");
if (isSquirrelStartup) {
    app.quit();
} else {
    crashReporter.start({ uploadToServer: false });
}

const PROJECT_ROOT = path.join(__dirname, "..");
const UI_SMOKE_MODE = process.argv.includes("--ui-smoke");
const BACKEND_START_TIMEOUT_MS = 12_000;
const DEFAULT_CONFIG = Object.freeze({
    debugPort: 9421,
    cdpPort: 62000,
    debugMain: false,
    debugFrida: false,
    autoOpenDevTools: false,
});

const DOC_URLS = Object.freeze({
    guide: "https://github.com/evi0s/WMPFDebugger/blob/main/README.zh.md",
    browser: "https://github.com/evi0s/WMPFDebugger/blob/main/EXTENSION.md",
});

let mainWindow = null;
let devToolsWindow = null;
let browserDevToolsWindow = null;
let serverProcess = null;
let serverStartupTimer = null;
let serverStartupFailure = null;
let stopRequested = false;
let logSequence = 0;
let logs = [];
let browserControlSocket = null;
let browserControlConnectPromise = null;
let browserRequestSequence = 1_500_000_000;
let browserTargetSession = null;
const browserPendingRequests = new Map();
const browserForwardedRequests = new Map();
const browserIgnoredRequestIds = new Set();

let runtimeState = createInitialState();

function createInitialState() {
    return {
        phase: "idle",
        message: "等待启动调试服务",
        pid: null,
        exitCode: null,
        debugServerReady: false,
        proxyServerReady: false,
        miniappConnected: false,
        cdpConnected: false,
        devToolsOpen: false,
        browserControllerConnected: false,
        browserTargets: [],
        browserTargetId: null,
        browserTargetTitle: null,
        browserTargetUrl: null,
        browserDebugOpen: false,
        browserTargetConnected: false,
        wmpfVersion: null,
        wmpfPid: null,
        config: { ...DEFAULT_CONFIG },
        updatedAt: Date.now(),
    };
}

function getSnapshot() {
    return {
        ...runtimeState,
        config: { ...runtimeState.config },
        browserTargets: runtimeState.browserTargets.map((target) => ({ ...target })),
        logs: logs.map((entry) => ({ ...entry })),
    };
}

function sendToRenderer(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
    }
}

function updateState(patch) {
    runtimeState = {
        ...runtimeState,
        ...patch,
        config: patch.config
            ? { ...runtimeState.config, ...patch.config }
            : runtimeState.config,
        updatedAt: Date.now(),
    };
    sendToRenderer("runtime:state", getSnapshot());
}

function classifySource(message, fallback) {
    if (message.startsWith("[frida")) return "frida";
    if (message.startsWith("[miniapp")) return "miniapp";
    if (message.startsWith("[cdp")) return "cdp";
    if (message.startsWith("[server")) return "server";
    return fallback;
}

function appendLog(message, level = "info", fallbackSource = "system") {
    const normalized = String(message).replace(/\r$/, "");
    if (!normalized.trim()) return;

    const entry = {
        id: ++logSequence,
        timestamp: Date.now(),
        source: classifySource(normalized, fallbackSource),
        level,
        message: normalized,
    };

    logs.push(entry);
    if (logs.length > 500) logs = logs.slice(-500);
    sendToRenderer("runtime:log", entry);
    deriveRuntimeState(normalized, level);
}

function deriveRuntimeState(message, level) {
    const patch = {};
    const isNewMiniappConnection =
        message.includes("miniapp client connected") && !runtimeState.miniappConnected;
    const isMiniappDisconnection = message.includes("miniapp client disconnected");

    if (message.includes("debug server running")) patch.debugServerReady = true;
    if (message.includes("proxy server running")) patch.proxyServerReady = true;
    if (message.includes("miniapp client connected")) patch.miniappConnected = true;
    if (message.includes("miniapp client disconnected")) patch.miniappConnected = false;
    if (message.includes("CDP client connected")) patch.cdpConnected = true;
    if (message.includes("CDP client disconnected")) patch.cdpConnected = false;

    const loadedMatch = message.match(
        /script loaded, WMPF version:\s*(\d+),\s*pid:\s*(\d+)/i,
    );
    if (loadedMatch) {
        patch.wmpfVersion = Number(loadedMatch[1]);
        patch.wmpfPid = Number(loadedMatch[2]);
        patch.message = `已注入 WMPF ${loadedMatch[1]}`;
    }

    if (
        message.includes("WeChatAppEx.exe process not found") ||
        message.includes("version config not found") ||
        message.includes("error in find wmpf version")
    ) {
        patch.message = message.replace(/^\[[^\]]+\]\s*/, "");
    }

    const nextDebugReady = patch.debugServerReady ?? runtimeState.debugServerReady;
    const nextProxyReady = patch.proxyServerReady ?? runtimeState.proxyServerReady;
    if (nextDebugReady && nextProxyReady && runtimeState.phase === "starting") {
        clearServerStartupTimer();
        serverStartupFailure = null;
        patch.phase = "running";
        if (!patch.message) patch.message = "服务已启动，等待打开小程序";
    }

    if (level === "error" && runtimeState.phase !== "stopping") {
        patch.message = message;
    }

    if (Object.keys(patch).length > 0) updateState(patch);

    if (isNewMiniappConnection && runtimeState.config.autoOpenDevTools) {
        queueMicrotask(() => {
            if (devToolsWindow && !devToolsWindow.isDestroyed()) return;
            try {
                appendLog("检测到小程序连接，正在自动打开 DevTools", "info", "system");
                createDevToolsWindow();
            } catch (error) {
                appendLog(
                    `自动打开 DevTools 失败：${error instanceof Error ? error.message : error}`,
                    "error",
                    "system",
                );
            }
        });
    }

    if (isMiniappDisconnection) {
        queueMicrotask(() => {
            teardownBrowserTargetSession({ detach: false });
            updateState({ browserTargets: [] });
        });
    }
}

function validateConfig(input) {
    const debugPort = Number(input?.debugPort);
    const cdpPort = Number(input?.cdpPort);
    for (const [name, value] of [
        ["调试端口", debugPort],
        ["CDP 端口", cdpPort],
    ]) {
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
            throw new Error(`${name}必须是 1–65535 之间的整数`);
        }
    }
    if (debugPort === cdpPort) {
        throw new Error("调试端口和 CDP 端口不能相同");
    }
    return {
        debugPort,
        cdpPort,
        debugMain: Boolean(input?.debugMain),
        debugFrida: Boolean(input?.debugFrida),
        autoOpenDevTools: Boolean(input?.autoOpenDevTools),
    };
}

function bindOutput(stream, level, source) {
    const reader = readline.createInterface({ input: stream });
    reader.on("line", (line) => appendLog(line, level, source));
    return reader;
}

function resolveNodeExecutable() {
    return process.env.npm_node_execpath || process.env.NODE || "node";
}

function clearServerStartupTimer() {
    if (!serverStartupTimer) return;
    clearTimeout(serverStartupTimer);
    serverStartupTimer = null;
}

function getBackendErrorMessage(error, location) {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") {
        return location ? `${error}（${location}）` : error;
    }
    if (error && typeof error === "object") {
        const type = typeof error.type === "string" ? error.type : "未知错误";
        const location = typeof error.location === "string" ? `（${error.location}）` : "";
        return `${type}${location}`;
    }
    return String(error);
}

async function startServer(input) {
    if (serverProcess) return getSnapshot();

    const config = validateConfig(input);
    const backendArgs = [
        "--debug-port",
        String(config.debugPort),
        "--cdp-port",
        String(config.cdpPort),
    ];
    if (config.debugMain) backendArgs.push("--debug-main");
    if (config.debugFrida) backendArgs.push("--debug-frida");

    clearServerStartupTimer();
    serverStartupFailure = null;
    stopRequested = false;
    updateState({
        ...createInitialState(),
        phase: "starting",
        message: "正在启动本地调试链路…",
        config,
    });
    appendLog("正在启动 WMPFDebugger 后端服务", "info", "system");

    let child;
    try {
        if (app.isPackaged) {
            const packagedWorkingDirectory = path.dirname(process.execPath);
            child = utilityProcess.fork(
                path.join(app.getAppPath(), "dist", "index.js"),
                backendArgs,
                {
                    cwd: packagedWorkingDirectory,
                    stdio: "pipe",
                    serviceName: "WMPFDebugger 后端服务",
                    env: {
                        ...process.env,
                        FORCE_COLOR: "0",
                    },
                },
            );
            appendLog(
                `安装态后端工作目录：${packagedWorkingDirectory}`,
                "info",
                "system",
            );
        } else {
            const tsNodeCli = require.resolve("ts-node/dist/bin.js");
            const backendEntry = path.join(PROJECT_ROOT, "src", "index.ts");
            child = spawn(
                resolveNodeExecutable(),
                [tsNodeCli, backendEntry, ...backendArgs],
                {
                    cwd: PROJECT_ROOT,
                    windowsHide: true,
                    stdio: ["ignore", "pipe", "pipe"],
                    env: {
                        ...process.env,
                        FORCE_COLOR: "0",
                    },
                },
            );
        }
    } catch (error) {
        const message = getBackendErrorMessage(error);
        serverStartupFailure = message;
        appendLog(`后端进程启动失败：${message}`, "error", "system");
        updateState({ phase: "error", message, pid: null });
        throw error;
    }
    serverProcess = child;

    if (!child.stdout || !child.stderr) {
        child.kill();
        serverProcess = null;
        const message = "无法读取后端进程输出";
        serverStartupFailure = message;
        appendLog(message, "error", "system");
        updateState({ phase: "error", message, pid: null });
        throw new Error(message);
    }

    const stdoutReader = bindOutput(child.stdout, "info", "backend");
    const stderrReader = bindOutput(child.stderr, "error", "backend");

    child.once("spawn", () => {
        updateState({ pid: child.pid ?? null });
        appendLog(`后端进程已创建，PID ${child.pid}`, "info", "system");
    });

    child.once("error", (error, location) => {
        clearServerStartupTimer();
        const message = getBackendErrorMessage(error, location);
        serverStartupFailure = message;
        appendLog(`后端进程启动失败：${message}`, "error", "system");
        updateState({
            phase: "error",
            message,
            pid: null,
        });
    });

    const handleExit = (code, signal = null) => {
        clearServerStartupTimer();
        stdoutReader.close();
        stderrReader.close();
        serverProcess = null;
        closeBrowserController();
        const expected = stopRequested;
        const startupFailure = serverStartupFailure;
        serverStartupFailure = null;
        const exitLabel = signal ? `信号 ${signal}` : `退出码 ${code ?? "未知"}`;
        appendLog(`后端进程已结束（${exitLabel}）`, expected ? "info" : "error", "system");
        if (devToolsWindow && !devToolsWindow.isDestroyed()) {
            devToolsWindow.close();
        }
        updateState({
            phase: expected || (code === 0 && !startupFailure) ? "idle" : "error",
            message: expected
                ? "调试服务已停止"
                : startupFailure ||
                  (code === 0 ? "后端进程已结束" : `后端异常退出（${exitLabel}）`),
            pid: null,
            exitCode: code,
            debugServerReady: false,
            proxyServerReady: false,
            miniappConnected: false,
            cdpConnected: false,
            devToolsOpen: false,
            browserControllerConnected: false,
            browserTargets: [],
            browserTargetId: null,
            browserTargetTitle: null,
            browserTargetUrl: null,
            browserDebugOpen: false,
            browserTargetConnected: false,
            wmpfVersion: null,
            wmpfPid: null,
        });
        stopRequested = false;
    };

    if (app.isPackaged) {
        child.once("exit", (code) => handleExit(code));
    } else {
        child.once("close", handleExit);
    }

    serverStartupTimer = setTimeout(() => {
        if (serverProcess !== child || runtimeState.phase !== "starting") return;
        const message = `后端启动超过 ${BACKEND_START_TIMEOUT_MS / 1000} 秒，请检查安装目录和运行日志`;
        serverStartupFailure = message;
        appendLog(message, "error", "system");
        updateState({ phase: "error", message, pid: child.pid ?? null });
        if (!child.kill()) serverProcess = null;
    }, BACKEND_START_TIMEOUT_MS);

    return getSnapshot();
}

async function stopServer() {
    if (!serverProcess) {
        updateState({ phase: "idle", message: "调试服务未运行" });
        return getSnapshot();
    }

    stopRequested = true;
    clearServerStartupTimer();
    serverStartupFailure = null;
    updateState({ phase: "stopping", message: "正在停止调试服务…" });
    appendLog("正在停止 WMPFDebugger 后端服务", "info", "system");
    serverProcess.kill();
    return getSnapshot();
}

function createDevToolsWindow() {
    if (!serverProcess || !runtimeState.proxyServerReady) {
        throw new Error("CDP 代理尚未就绪，请先启动调试服务");
    }

    if (devToolsWindow && !devToolsWindow.isDestroyed()) {
        devToolsWindow.focus();
        return getSnapshot();
    }

    devToolsWindow = new BrowserWindow({
        width: 1380,
        height: 860,
        minWidth: 900,
        minHeight: 620,
        title: "WMPF DevTools",
        backgroundColor: "#202124",
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            devTools: false,
        },
    });

    devToolsWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    devToolsWindow.loadURL(
        `devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${runtimeState.config.cdpPort}`,
    );
    devToolsWindow.once("ready-to-show", () => devToolsWindow?.show());
    devToolsWindow.webContents.on("did-fail-load", (_event, code, description) => {
        appendLog(`DevTools 加载失败（${code}）：${description}`, "error", "system");
    });
    devToolsWindow.on("closed", () => {
        devToolsWindow = null;
        updateState({ devToolsOpen: false });
    });

    updateState({ devToolsOpen: true });
    appendLog("已打开内置 DevTools 窗口", "info", "system");
    return getSnapshot();
}

function refreshDevTools() {
    if (!devToolsWindow || devToolsWindow.isDestroyed()) {
        throw new Error("DevTools 窗口尚未打开");
    }
    devToolsWindow.reload();
    appendLog("已刷新 DevTools 连接", "info", "system");
    return getSnapshot();
}

function nextBrowserRequestId() {
    browserRequestSequence += 1;
    if (browserRequestSequence > 2_000_000_000) browserRequestSequence = 1_500_000_000;
    return browserRequestSequence;
}

function isSocketOpen(socket) {
    return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function sendSocketJson(socket, payload) {
    if (!isSocketOpen(socket)) throw new Error("浏览器目标控制连接未就绪");
    socket.send(JSON.stringify(payload));
}

function rejectBrowserPendingRequests(error) {
    for (const pending of browserPendingRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
    }
    browserPendingRequests.clear();
    browserForwardedRequests.clear();
    browserIgnoredRequestIds.clear();
}

function sendToBrowserTargetClient(message) {
    const client = browserTargetSession?.client;
    if (isSocketOpen(client)) client.send(message);
}

function handleBrowserProtocolMessage(rawData) {
    let payload;
    try {
        payload = JSON.parse(rawData.toString());
    } catch {
        return;
    }

    if (payload.id != null) {
        const pending = browserPendingRequests.get(payload.id);
        if (pending) {
            browserPendingRequests.delete(payload.id);
            clearTimeout(pending.timer);
            if (payload.error) {
                pending.reject(
                    new Error(payload.error.message || `CDP 请求失败：${pending.method}`),
                );
            } else {
                pending.resolve(payload.result ?? {});
            }
            return;
        }

        const forwarded = browserForwardedRequests.get(payload.id);
        if (forwarded) {
            browserForwardedRequests.delete(payload.id);
            const response = { ...payload, id: forwarded.originalId };
            delete response.sessionId;
            if (isSocketOpen(forwarded.client)) {
                forwarded.client.send(JSON.stringify(response));
            }
            return;
        }

        if (browserIgnoredRequestIds.delete(payload.id)) return;
    }

    const session = browserTargetSession;
    if (!session) return;

    if (
        payload.method === "Target.detachedFromTarget" &&
        payload.params?.sessionId === session.sessionId
    ) {
        appendLog("浏览器目标调试会话已被运行时断开", "info", "system");
        void teardownBrowserTargetSession({ detach: false });
        return;
    }

    if (session.mode === "flattened" && payload.sessionId === session.sessionId) {
        const targetPayload = { ...payload };
        delete targetPayload.sessionId;
        sendToBrowserTargetClient(JSON.stringify(targetPayload));
        return;
    }

    if (
        session.mode === "nested" &&
        payload.method === "Target.receivedMessageFromTarget" &&
        payload.params?.sessionId === session.sessionId &&
        typeof payload.params.message === "string"
    ) {
        sendToBrowserTargetClient(payload.params.message);
    }
}

function ensureBrowserControlSocket() {
    if (isSocketOpen(browserControlSocket)) return Promise.resolve(browserControlSocket);
    if (browserControlConnectPromise) return browserControlConnectPromise;
    if (!serverProcess || !runtimeState.proxyServerReady) {
        return Promise.reject(new Error("CDP 代理尚未就绪，请先启动调试服务"));
    }

    browserControlConnectPromise = new Promise((resolve, reject) => {
        const url = `ws://127.0.0.1:${runtimeState.config.cdpPort}/__wmpf_control__`;
        const socket = new WebSocket(url, {
            perMessageDeflate: false,
            maxPayload: 8 * 1024 * 1024,
        });
        browserControlSocket = socket;
        let settled = false;
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            socket.terminate();
            reject(new Error("连接浏览器目标控制通道超时"));
        }, 5000);

        socket.once("open", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            updateState({ browserControllerConnected: true });
            appendLog("浏览器目标控制通道已连接", "info", "system");
            resolve(socket);
        });
        socket.on("message", handleBrowserProtocolMessage);
        socket.once("error", (error) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(new Error(`浏览器目标控制通道连接失败：${error.message}`));
            }
        });
        socket.once("close", () => {
            clearTimeout(timeout);
            if (browserControlSocket !== socket) return;
            browserControlSocket = null;
            browserControlConnectPromise = null;
            rejectBrowserPendingRequests(new Error("浏览器目标控制通道已断开"));
            void teardownBrowserTargetSession({ detach: false });
            updateState({
                browserControllerConnected: false,
                browserTargets: [],
            });
        });
    });

    return browserControlConnectPromise;
}

async function sendBrowserCommand(method, params = {}, timeoutMs = 6000) {
    const socket = await ensureBrowserControlSocket();
    const id = nextBrowserRequestId();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            browserPendingRequests.delete(id);
            reject(new Error(`CDP 请求超时：${method}`));
        }, timeoutMs);
        browserPendingRequests.set(id, { method, resolve, reject, timer });
        try {
            sendSocketJson(socket, { id, method, params });
        } catch (error) {
            browserPendingRequests.delete(id);
            clearTimeout(timer);
            reject(error);
        }
    });
}

function normalizeBrowserTargets(targetInfos) {
    const supportedTypes = new Set(["page", "webview", "iframe"]);
    return targetInfos
        .filter(
            (target) =>
                target &&
                typeof target.targetId === "string" &&
                supportedTypes.has(target.type),
        )
        .map((target) => ({
            targetId: target.targetId.slice(0, 512),
            type: target.type,
            title: String(target.title || "未命名页面").slice(0, 512),
            url: String(target.url || "").slice(0, 4096),
            attached: Boolean(target.attached),
            isMiniApp: /appindex|appservice/i.test(`${target.title} ${target.url}`),
        }))
        .sort((left, right) => {
            if (left.isMiniApp !== right.isMiniApp) return left.isMiniApp ? 1 : -1;
            return left.title.localeCompare(right.title, "zh-CN");
        });
}

async function listBrowserTargets() {
    if (!runtimeState.miniappConnected) {
        throw new Error("请先在微信中打开一个小程序以建立调试通道");
    }
    const result = await sendBrowserCommand("Target.getTargets");
    const targets = normalizeBrowserTargets(
        Array.isArray(result.targetInfos) ? result.targetInfos : [],
    );
    updateState({ browserTargets: targets });
    appendLog(`已发现 ${targets.length} 个可调试浏览器目标`, "info", "system");
    return getSnapshot();
}

function forwardBrowserTargetMessage(session, client, rawData) {
    if (browserTargetSession !== session || !isSocketOpen(browserControlSocket)) return;
    const rawMessage = rawData.toString();
    if (rawMessage.length > 8 * 1024 * 1024) {
        client.close(1009, "CDP message too large");
        return;
    }

    try {
        if (session.mode === "nested") {
            const id = nextBrowserRequestId();
            if (browserIgnoredRequestIds.size > 4096) browserIgnoredRequestIds.clear();
            browserIgnoredRequestIds.add(id);
            sendSocketJson(browserControlSocket, {
                id,
                method: "Target.sendMessageToTarget",
                params: {
                    sessionId: session.sessionId,
                    message: rawMessage,
                },
            });
            return;
        }

        const payload = JSON.parse(rawMessage);
        const outgoing = { ...payload, sessionId: session.sessionId };
        if (payload.id != null) {
            const id = nextBrowserRequestId();
            browserForwardedRequests.set(id, {
                originalId: payload.id,
                client,
            });
            outgoing.id = id;
        }
        sendSocketJson(browserControlSocket, outgoing);
    } catch (error) {
        if (isSocketOpen(client)) client.close(1011, "target proxy unavailable");
        appendLog(
            `转发浏览器目标命令失败：${error instanceof Error ? error.message : error}`,
            "error",
            "system",
        );
    }
}

async function createBrowserTargetProxy(target, sessionId, mode) {
    const proxyServer = new WebSocketServer({
        host: "127.0.0.1",
        port: 0,
        perMessageDeflate: false,
        maxPayload: 8 * 1024 * 1024,
    });
    await new Promise((resolve, reject) => {
        proxyServer.once("listening", resolve);
        proxyServer.once("error", reject);
    });
    const address = proxyServer.address();
    if (!address || typeof address === "string") {
        proxyServer.close();
        throw new Error("无法分配浏览器目标代理端口");
    }

    const session = {
        target,
        sessionId,
        mode,
        proxyServer,
        proxyPort: address.port,
        proxyToken: randomBytes(16).toString("hex"),
        client: null,
    };
    browserTargetSession = session;

    proxyServer.on("connection", (client, request) => {
        if (request.url !== `/${session.proxyToken}`) {
            client.close(1008, "invalid target proxy token");
            return;
        }
        if (browserTargetSession !== session) {
            client.close(1012, "session replaced");
            return;
        }
        if (session.client && isSocketOpen(session.client)) session.client.terminate();
        session.client = client;
        updateState({ browserTargetConnected: true });
        appendLog(`浏览器目标调试前端已连接：${target.title}`, "info", "system");
        client.on("message", (data) => forwardBrowserTargetMessage(session, client, data));
        client.on("error", (error) => {
            appendLog(`浏览器目标代理错误：${error.message}`, "error", "system");
        });
        client.on("close", () => {
            if (session.client === client) session.client = null;
            if (browserTargetSession === session) {
                updateState({ browserTargetConnected: false });
            }
        });
    });

    return session;
}

async function teardownBrowserTargetSession({ detach = true, closeWindow = true } = {}) {
    const session = browserTargetSession;
    browserTargetSession = null;
    browserForwardedRequests.clear();
    browserIgnoredRequestIds.clear();

    const targetWindow = browserDevToolsWindow;
    browserDevToolsWindow = null;
    if (closeWindow && targetWindow && !targetWindow.isDestroyed()) targetWindow.destroy();

    if (session?.client) session.client.terminate();
    if (session?.proxyServer) {
        try {
            session.proxyServer.close();
        } catch {
            // 服务已关闭时无需重复处理。
        }
    }

    if (detach && session?.sessionId && isSocketOpen(browserControlSocket)) {
        try {
            await sendBrowserCommand(
                "Target.detachFromTarget",
                { sessionId: session.sessionId },
                2500,
            );
        } catch (error) {
            appendLog(
                `释放浏览器目标会话失败：${error instanceof Error ? error.message : error}`,
                "info",
                "system",
            );
        }
    }

    updateState({
        browserTargetId: null,
        browserTargetTitle: null,
        browserTargetUrl: null,
        browserDebugOpen: false,
        browserTargetConnected: false,
    });
}

async function openBrowserTarget(targetId) {
    const normalizedId = String(targetId || "");
    if (!normalizedId || normalizedId.length > 512) throw new Error("浏览器目标 ID 无效");
    let target = runtimeState.browserTargets.find((item) => item.targetId === normalizedId);
    if (!target) {
        await listBrowserTargets();
        target = runtimeState.browserTargets.find((item) => item.targetId === normalizedId);
    }
    if (!target) throw new Error("浏览器目标已失效，请刷新列表后重试");

    if (
        browserTargetSession?.target.targetId === normalizedId &&
        browserDevToolsWindow &&
        !browserDevToolsWindow.isDestroyed()
    ) {
        browserDevToolsWindow.focus();
        return getSnapshot();
    }

    await teardownBrowserTargetSession();
    let mode = "flattened";
    let result;
    try {
        result = await sendBrowserCommand("Target.attachToTarget", {
            targetId: normalizedId,
            flatten: true,
        });
    } catch (flattenError) {
        mode = "nested";
        appendLog("当前内核不支持扁平会话，切换兼容代理模式", "info", "system");
        result = await sendBrowserCommand("Target.attachToTarget", {
            targetId: normalizedId,
        });
    }
    if (!result?.sessionId) throw new Error("运行时未返回浏览器目标会话 ID");

    let session;
    try {
        session = await createBrowserTargetProxy(target, result.sessionId, mode);
    } catch (error) {
        await sendBrowserCommand(
            "Target.detachFromTarget",
            { sessionId: result.sessionId },
            2500,
        ).catch(() => {});
        throw error;
    }

    const targetWindow = new BrowserWindow({
        width: 1380,
        height: 860,
        minWidth: 900,
        minHeight: 620,
        show: false,
        title: `浏览器调试 · ${target.title}`,
        backgroundColor: "#202124",
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            devTools: false,
        },
    });
    browserDevToolsWindow = targetWindow;
    targetWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    targetWindow.loadURL(
        `devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${session.proxyPort}/${session.proxyToken}`,
    );
    targetWindow.once("ready-to-show", () => targetWindow.show());
    targetWindow.webContents.on("did-fail-load", (_event, code, description) => {
        appendLog(`浏览器 DevTools 加载失败（${code}）：${description}`, "error", "system");
    });
    targetWindow.on("closed", () => {
        if (browserDevToolsWindow !== targetWindow) return;
        browserDevToolsWindow = null;
        void teardownBrowserTargetSession({ closeWindow: false });
    });

    updateState({
        browserTargetId: target.targetId,
        browserTargetTitle: target.title,
        browserTargetUrl: target.url,
        browserDebugOpen: true,
        browserTargetConnected: false,
    });
    appendLog(`已附加浏览器目标：${target.title}（${mode}）`, "info", "system");
    return getSnapshot();
}

async function closeBrowserTarget() {
    await teardownBrowserTargetSession();
    appendLog("已关闭浏览器目标调试会话", "info", "system");
    return getSnapshot();
}

function closeBrowserController() {
    void teardownBrowserTargetSession({ detach: false });
    rejectBrowserPendingRequests(new Error("浏览器目标控制器已关闭"));
    const socket = browserControlSocket;
    browserControlSocket = null;
    browserControlConnectPromise = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    updateState({
        browserControllerConnected: false,
        browserTargets: [],
    });
}

function isTrustedSender(event) {
    return Boolean(mainWindow && event.sender === mainWindow.webContents);
}

function registerHandler(channel, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
        if (!isTrustedSender(event)) throw new Error("拒绝未知页面的 IPC 请求");
        return handler(...args);
    });
}

function registerIpc() {
    registerHandler("runtime:get-state", () => getSnapshot());
    registerHandler("runtime:start", (config) => startServer(config));
    registerHandler("runtime:stop", () => stopServer());
    registerHandler("runtime:open-devtools", () => createDevToolsWindow());
    registerHandler("runtime:refresh-devtools", () => refreshDevTools());
    registerHandler("browser:list-targets", () => listBrowserTargets());
    registerHandler("browser:open-target", (targetId) => openBrowserTarget(targetId));
    registerHandler("browser:close-target", () => closeBrowserTarget());
    registerHandler("runtime:clear-logs", () => {
        logs = [];
        sendToRenderer("runtime:logs-cleared", null);
        return getSnapshot();
    });
    registerHandler("app:copy", (value) => {
        const text = String(value ?? "").slice(0, 2048);
        clipboard.writeText(text);
        return true;
    });
    registerHandler("app:open-docs", (name) => {
        const url = DOC_URLS[name];
        if (!url) throw new Error("未知的文档入口");
        return shell.openExternal(url);
    });
}

async function runUiSmokeCapture() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
        await new Promise((resolve) => setTimeout(resolve, 350));
        updateState({
            miniappConnected: true,
            browserControllerConnected: true,
            browserTargets: [
                {
                    targetId: "smoke-browser-page",
                    type: "page",
                    title: "微信公众平台",
                    url: "https://mp.weixin.qq.com/s/example",
                    attached: false,
                    isMiniApp: false,
                },
                {
                    targetId: "smoke-webview-page",
                    type: "webview",
                    title: "小程序 WebView",
                    url: "https://example.com/webview",
                    attached: true,
                    isMiniApp: true,
                },
            ],
        });
        await new Promise((resolve) => setTimeout(resolve, 280));
        const report = await mainWindow.webContents.executeJavaScript(`({
            title: document.title,
            phase: document.querySelector("#global-state")?.dataset.state,
            startEnabled: !document.querySelector("#start-button")?.disabled,
            bridgeReady: typeof window.wmpfDesktop === "object",
            logEmpty: !document.querySelector("#empty-log")?.hidden,
            autoOpenAvailable: Boolean(document.querySelector("#auto-open-devtools")),
            targetScannerAvailable: Boolean(document.querySelector("#browser-target-button")),
            targetCards: document.querySelectorAll(".browser-target-item").length
        })`);
        const overflowReport = await mainWindow.webContents.executeJavaScript(`(() => {
            const panel = document.querySelector(".log-panel");
            const viewport = document.querySelector("#log-viewport");
            const list = document.querySelector("#log-list");
            const empty = document.querySelector("#empty-log");
            const panelHeightBefore = panel.getBoundingClientRect().height;
            empty.hidden = true;
            for (let index = 0; index < 200; index += 1) {
                const item = document.createElement("li");
                item.className = "log-entry";
                item.textContent = "滚动约束测试日志 " + index;
                list.append(item);
            }
            const result = {
                panelHeightBefore,
                panelHeightAfter: panel.getBoundingClientRect().height,
                viewportHeight: viewport.clientHeight,
                contentHeight: viewport.scrollHeight,
                overflowY: getComputedStyle(viewport).overflowY
            };
            list.replaceChildren();
            empty.hidden = false;
            return result;
        })()`);
        if (
            report.title !== "WMPF Control Deck" ||
            report.phase !== "idle" ||
            !report.startEnabled ||
            !report.bridgeReady ||
            !report.logEmpty ||
            !report.autoOpenAvailable ||
            !report.targetScannerAvailable ||
            report.targetCards !== 2 ||
            Math.abs(overflowReport.panelHeightAfter - overflowReport.panelHeightBefore) > 1 ||
            overflowReport.contentHeight <= overflowReport.viewportHeight ||
            overflowReport.overflowY !== "auto"
        ) {
            throw new Error(
                `页面状态不符合预期：${JSON.stringify({ ...report, overflowReport })}`,
            );
        }

        const screenshotPath = path.join(
            app.getPath("temp"),
            "wmpf-control-deck-browser-smoke.png",
        );
        const drawerReport = await mainWindow.webContents.executeJavaScript(`(() => {
            const drawer = document.querySelector("#browser-drawer");
            drawer.hidden = false;
            return {
                hidden: drawer.hidden,
                display: getComputedStyle(drawer).display,
                targetCards: drawer.querySelectorAll(".browser-target-item").length
            };
        })()`);
        if (
            drawerReport.hidden ||
            drawerReport.display === "none" ||
            drawerReport.targetCards !== 2
        ) {
            throw new Error(`浏览器目标抽屉未正确显示：${JSON.stringify(drawerReport)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 280));
        const screenshot = await mainWindow.webContents.capturePage();
        await fs.writeFile(screenshotPath, screenshot.toPNG());
        console.log(
            `[ui-smoke] ${JSON.stringify({ ...report, overflowReport, drawerReport, screenshotPath })}`,
        );
        app.exit(0);
    } catch (error) {
        console.error(`[ui-smoke] ${error instanceof Error ? error.stack : error}`);
        app.exit(1);
    }
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1180,
        height: 1000,
        minWidth: 920,
        minHeight: 680,
        show: false,
        title: "WMPF Control Deck",
        backgroundColor: "#090d0c",
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });

    mainWindow.loadFile(path.join(__dirname, "index.html"));
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    mainWindow.webContents.once("did-finish-load", () => {
        if (UI_SMOKE_MODE) void runUiSmokeCapture();
    });
    mainWindow.once("ready-to-show", () => mainWindow?.show());
    mainWindow.on("closed", () => {
        mainWindow = null;
        if (serverProcess) {
            stopRequested = true;
            serverProcess.kill();
        }
        if (devToolsWindow && !devToolsWindow.isDestroyed()) devToolsWindow.close();
        closeBrowserController();
    });
}

app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpc();
    createMainWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
});

app.on("before-quit", () => {
    closeBrowserController();
    if (serverProcess) {
        stopRequested = true;
        serverProcess.kill();
    }
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
