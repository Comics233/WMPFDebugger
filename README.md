# WMPFDebugger Desktop

[![Windows Release](https://github.com/Comics233/WMPFDebugger/actions/workflows/release.yml/badge.svg)](https://github.com/Comics233/WMPFDebugger/actions/workflows/release.yml)
[![Latest Release](https://img.shields.io/github/v/release/Comics233/WMPFDebugger?display_name=tag)](https://github.com/Comics233/WMPFDebugger/releases/latest)
[![License](https://img.shields.io/github/license/Comics233/WMPFDebugger)](LICENSE)

面向 Windows 微信小程序运行时（WMPF）的桌面调试工具，基于 [上游项目](https://github.com/evi0s/WMPFDebugger) 并集成其多平台适配。

> 本项目仅用于学习、研究和个人调试。使用前请阅读文末免责声明，并自行承担运行时注入带来的风险。

## 主要功能

- Electron 桌面操作面板，无需手动执行 TypeScript 命令；
- 启动、停止 WMPF 调试服务并实时展示运行状态；
- 内置 Chromium DevTools，可直接调试微信小程序；
- 支持小程序连接后自动打开调试窗口；
- 浏览器页面雷达，可扫描并调试微信内置浏览器的 `page`、`webview` 和 `iframe`；
- 运行日志按来源分类并在面板内部滚动，不会撑开页面；
- 安装版和免安装绿色版均内置运行环境，目标电脑不需要安装 Node.js；
- GitHub Actions 自动构建 Windows x64 安装包与绿色版 ZIP。

## 支持范围

- Windows x64：支持自动检测（Beta）及上游已适配版本，包括 25715、25710、25558、25510、25459、25364 和历史版本；本分支另含 WMPF 25560 配置。
- Linux x86_64：25665、14978、14910。
- macOS arm64：269136。
- 微信更新 WMPF 后，偏移地址可能需要重新适配。

检查版本：Windows 在任务管理器中查看 `WeChatAppEx.exe` 所在路径；macOS 可检查 `WeChatAppEx.app` 的 `CFBundleVersion`。

## 下载

前往 [Releases](https://github.com/Comics233/WMPFDebugger/releases/latest) 下载最新版：

| 文件 | 用途 |
| --- | --- |
| `WMPFDebugger-Setup.exe` | Windows x64 安装版 |
| `WMPFDebugger-win32-x64-<版本号>.zip` | 绿色版，解压后运行 |

绿色版必须完整解压，不能只复制 `WMPFDebugger.exe`，其旁边的 `resources` 等目录同样是运行所必需的。

当前发布包尚未配置代码签名，Windows 首次运行时可能显示 SmartScreen 提示。命令行用户可添加 `--auto-detect` 尝试自动检测偏移（Beta）。

## 使用方法

1. 启动微信，并确保微信与 WMPFDebugger 的权限等级一致；
2. 安装或解压 WMPFDebugger，运行 `WMPFDebugger.exe`；
3. 保持默认端口或按需修改，点击“启动调试链路”；
4. 等待面板显示服务已启动，然后在微信中打开目标小程序；
5. 点击“打开控制台”，或启用“小程序连接后自动打开控制台”。

默认端口：

- 小程序调试服务：`9421`；
- CDP 代理：`62000`。

### 调试微信内置浏览器

小程序连接成功后，打开“浏览器页面雷达”，扫描可调试目标并选择页面。入口小程序需要在浏览器调试期间保持运行。参见 [EXTENSION.md](EXTENSION.md)。

上游还提供 Linux x86_64 和 macOS arm64 版本适配；本 Electron 桌面打包流程仍面向 Windows x64。

## 本地开发

环境要求：

- Windows x64；
- Node.js 22 LTS 或更高版本；
- Yarn Classic 1.22.x。

安装依赖并启动 Electron 面板：

```powershell
yarn install --frozen-lockfile
yarn ui
```

常用命令：

```powershell
yarn run check       # TypeScript 类型检查
yarn build:backend   # 编译生产环境后端
yarn make:portable   # 生成绿色版 ZIP
yarn make:win        # 生成安装版 EXE 和绿色版 ZIP
yarn test:packaged   # 验证打包后的后端启动链路
```

本地产物位于：

```text
out/make/squirrel.windows/x64/WMPFDebugger-Setup.exe
out/make/zip/win32/x64/WMPFDebugger-win32-x64-<版本号>.zip
```

## 自动发布

[Windows Release](https://github.com/Comics233/WMPFDebugger/actions/workflows/release.yml)
工作流会在 Windows 托管运行器上完成类型检查、后端编译、Electron Forge 打包和 GitHub
Release 发布。

发布前先修改 `package.json` 中的版本号并提交，然后推送同版本标签：

```powershell
git tag v1.0.2
git push origin v1.0.2
```

工作流要求标签严格等于 `v` + `package.json.version`。也可以在 GitHub Actions 页面手动运行
工作流并输入标签；如果 Release 已存在，流水线会覆盖其中的 EXE 和 ZIP 文件。

## 相关文档

- [EXTENSION.md](EXTENSION.md)：微信内置浏览器调试原理与限制；
- [ADAPTATION.md](ADAPTATION.md)：新 WMPF 版本偏移适配；
- [FAQ.zh.md](FAQ.zh.md)：常见问题；
- [README.zh.md](README.zh.md)：上游功能和命令行用法说明。

## 致谢与版权

本项目遵循 GPLv2。重新分发或发布衍生版本时，请保留适用的版权及许可证声明，并履行 GPLv2 对源代码的要求；同时请保留已有署名及贡献者信息。

- 核心调试协议与注入实现来自 [evi0s/WMPFDebugger](https://github.com/evi0s/WMPFDebugger)；
- `src/third-party` 中的代码提取自微信开发者工具，其版权归腾讯控股有限公司所有；
- 其他历史版本贡献者请参见上游项目提交记录。

项目遵循 [GPL-2.0](LICENSE) 许可证。

## 免责声明

本程序按“原样”提供，不附带任何明示或暗示的担保。使用者需要自行承担程序质量、性能、
兼容性、数据损失以及账号或运行环境异常等全部风险。本项目与腾讯、微信官方无隶属或授权关系。
