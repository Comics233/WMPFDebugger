const { app, BrowserWindow, Menu, clipboard, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");

const PROJECT_ROOT = path.join(__dirname, "..");
const UI_SMOKE_MODE = process.argv.includes("--ui-smoke");
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
let serverProcess = null;
let stopRequested = false;
let logSequence = 0;
let logs = [];

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

async function startServer(input) {
    if (serverProcess) return getSnapshot();

    const config = validateConfig(input);
    const tsNodeCli = require.resolve("ts-node/dist/bin.js");
    const backendEntry = path.join(PROJECT_ROOT, "src", "index.ts");
    const args = [
        tsNodeCli,
        backendEntry,
        "--debug-port",
        String(config.debugPort),
        "--cdp-port",
        String(config.cdpPort),
    ];
    if (config.debugMain) args.push("--debug-main");
    if (config.debugFrida) args.push("--debug-frida");

    stopRequested = false;
    updateState({
        ...createInitialState(),
        phase: "starting",
        message: "正在启动本地调试链路…",
        config,
    });
    appendLog("正在启动 WMPFDebugger 后端服务", "info", "system");

    const child = spawn(resolveNodeExecutable(), args, {
        cwd: PROJECT_ROOT,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            ...process.env,
            FORCE_COLOR: "0",
        },
    });
    serverProcess = child;

    const stdoutReader = bindOutput(child.stdout, "info", "backend");
    const stderrReader = bindOutput(child.stderr, "error", "backend");

    child.once("spawn", () => {
        updateState({ pid: child.pid ?? null });
        appendLog(`后端进程已创建，PID ${child.pid}`, "info", "system");
    });

    child.once("error", (error) => {
        appendLog(`后端进程启动失败：${error.message}`, "error", "system");
        serverProcess = null;
        updateState({
            phase: "error",
            message: error.message,
            pid: null,
        });
    });

    child.once("close", (code, signal) => {
        stdoutReader.close();
        stderrReader.close();
        serverProcess = null;
        const expected = stopRequested;
        const exitLabel = signal ? `信号 ${signal}` : `退出码 ${code ?? "未知"}`;
        appendLog(`后端进程已结束（${exitLabel}）`, expected ? "info" : "error", "system");
        if (devToolsWindow && !devToolsWindow.isDestroyed()) {
            devToolsWindow.close();
        }
        updateState({
            phase: expected || code === 0 ? "idle" : "error",
            message: expected ? "调试服务已停止" : `后端异常退出（${exitLabel}）`,
            pid: null,
            exitCode: code,
            debugServerReady: false,
            proxyServerReady: false,
            miniappConnected: false,
            cdpConnected: false,
            devToolsOpen: false,
            wmpfVersion: null,
            wmpfPid: null,
        });
        stopRequested = false;
    });

    return getSnapshot();
}

async function stopServer() {
    if (!serverProcess) {
        updateState({ phase: "idle", message: "调试服务未运行" });
        return getSnapshot();
    }

    stopRequested = true;
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
        const report = await mainWindow.webContents.executeJavaScript(`({
            title: document.title,
            phase: document.querySelector("#global-state")?.dataset.state,
            startEnabled: !document.querySelector("#start-button")?.disabled,
            bridgeReady: typeof window.wmpfDesktop === "object",
            logEmpty: !document.querySelector("#empty-log")?.hidden,
            autoOpenAvailable: Boolean(document.querySelector("#auto-open-devtools"))
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
            Math.abs(overflowReport.panelHeightAfter - overflowReport.panelHeightBefore) > 1 ||
            overflowReport.contentHeight <= overflowReport.viewportHeight ||
            overflowReport.overflowY !== "auto"
        ) {
            throw new Error(
                `页面状态不符合预期：${JSON.stringify({ ...report, overflowReport })}`,
            );
        }

        const screenshotPath = path.join(app.getPath("temp"), "wmpf-control-deck-smoke.png");
        const screenshot = await mainWindow.webContents.capturePage();
        await fs.writeFile(screenshotPath, screenshot.toPNG());
        console.log(
            `[ui-smoke] ${JSON.stringify({ ...report, overflowReport, screenshotPath })}`,
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
        height: 925,
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
    if (serverProcess) {
        stopRequested = true;
        serverProcess.kill();
    }
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
