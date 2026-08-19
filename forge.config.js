module.exports = {
    packagerConfig: {
        asar: true,
        executableName: "WMPFDebugger",
        ignore: [
            /^\/(?:\.git|\.github|out|screenshots)(?:\/|$)/,
            /^\/src(?:\/|$)/,
            /^\/scripts(?:\/|$)/,
            /^\/tsconfig(?:\.build)?\.json$/,
        ],
    },
    rebuildConfig: {},
    plugins: [
        {
            name: "@electron-forge/plugin-auto-unpack-natives",
            config: {},
        },
    ],
    makers: [
        {
            name: "@electron-forge/maker-squirrel",
            config: {
                name: "wmpf_debugger",
                setupExe: "WMPFDebugger-Setup.exe",
            },
        },
        {
            name: "@electron-forge/maker-zip",
            platforms: ["win32"],
            config: {},
        },
    ],
};
