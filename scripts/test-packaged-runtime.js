const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const WebSocket = require("ws");

const projectRoot = path.join(__dirname, "..");
const executablePath =
    process.argv[2] ||
    path.join(projectRoot, "out", "WMPFDebugger-win32-x64", "WMPFDebugger.exe");
const remoteDebugPort = 49364;
const backendDebugPort = 49421;
const backendCdpPort = 49422;

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readJson(url) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                body += chunk;
            });
            response.on("end", () => {
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(error);
                }
            });
        });
        request.on("error", reject);
        request.setTimeout(1000, () => request.destroy(new Error("请求超时")));
    });
}

async function findRendererTarget() {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
        try {
            const targets = await readJson(`http://127.0.0.1:${remoteDebugPort}/json/list`);
            const target = targets.find(
                (item) =>
                    item.type === "page" &&
                    typeof item.webSocketDebuggerUrl === "string" &&
                    item.url.endsWith("/UI/index.html"),
            );
            if (target) return target;
        } catch {
            // Electron 可能仍在启动，继续轮询。
        }
        await delay(200);
    }
    throw new Error("未找到 Electron 渲染页面的调试目标");
}

async function connectCdp(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
    });

    let sequence = 0;
    const pending = new Map();
    socket.on("message", (data) => {
        const payload = JSON.parse(data.toString());
        const request = pending.get(payload.id);
        if (!request) return;
        pending.delete(payload.id);
        if (payload.error) request.reject(new Error(payload.error.message));
        else request.resolve(payload.result);
    });

    return {
        socket,
        send(method, params = {}) {
            return new Promise((resolve, reject) => {
                const id = ++sequence;
                pending.set(id, { resolve, reject });
                socket.send(JSON.stringify({ id, method, params }));
            });
        },
    };
}

async function evaluate(cdp, expression) {
    const result = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
    });
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || "页面执行失败");
    }
    return result.result.value;
}

async function main() {
    const child = spawn(executablePath, [`--remote-debugging-port=${remoteDebugPort}`], {
        cwd: path.dirname(executablePath),
        windowsHide: true,
        stdio: "ignore",
        env: {
            ...process.env,
            WMPF_BACKEND_SMOKE: "1",
        },
    });

    let cdp;
    try {
        const target = await findRendererTarget();
        cdp = await connectCdp(target.webSocketDebuggerUrl);
        const bridgeDeadline = Date.now() + 8_000;
        while (Date.now() < bridgeDeadline) {
            if (await evaluate(cdp, "typeof window.wmpfDesktop === 'object'")) break;
            await delay(100);
        }
        if (!(await evaluate(cdp, "typeof window.wmpfDesktop === 'object'"))) {
            throw new Error("Electron preload 桥接未就绪");
        }
        await evaluate(
            cdp,
            `window.wmpfDesktop.start(${JSON.stringify({
                debugPort: backendDebugPort,
                cdpPort: backendCdpPort,
                debugMain: false,
                debugFrida: false,
                autoOpenDevTools: false,
            })})`,
        );
        await delay(3_000);
        const snapshot = await evaluate(cdp, "window.wmpfDesktop.getState()");
        console.log(JSON.stringify(snapshot, null, 2));
        await evaluate(cdp, "window.wmpfDesktop.stop()");

        if (
            snapshot.phase !== "running" ||
            !snapshot.debugServerReady ||
            !snapshot.proxyServerReady
        ) {
            process.exitCode = 1;
        }
    } finally {
        cdp?.socket.close();
        child.kill();
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
});
