const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");
const distDir = path.join(projectRoot, "dist");
const tscEntry = require.resolve("typescript/bin/tsc");

fs.rmSync(distDir, { recursive: true, force: true });

const compileResult = spawnSync(
    process.execPath,
    [tscEntry, "-p", path.join(projectRoot, "tsconfig.build.json")],
    {
        cwd: projectRoot,
        stdio: "inherit",
    },
);

if (compileResult.status !== 0) {
    process.exit(compileResult.status ?? 1);
}

fs.cpSync(
    path.join(projectRoot, "src", "third-party"),
    path.join(distDir, "third-party"),
    { recursive: true },
);

for (const requiredPath of [
    path.join(distDir, "index.js"),
    path.join(distDir, "third-party", "RemoteDebugCodex.js"),
    path.join(projectRoot, "frida", "hook.js"),
]) {
    if (!fs.existsSync(requiredPath)) {
        throw new Error(`构建缺少必要文件：${requiredPath}`);
    }
}

console.log(`[build] 后端已生成：${distDir}`);
