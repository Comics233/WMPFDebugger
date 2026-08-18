# WeChat Embedded Browser Page Debugging

This is a simple workaround of utilizing existing debugging protocol to debug web pages of WeChat Embedded Browser.

## Electron Control Deck

The Electron panel can automate the target discovery and attachment steps below:

1. Start the debugging service and open a miniapp to initialize the WMPF debugging channel.
2. Open **Browser Page Radar** in the control panel.
3. Scan the available `page`, `webview`, and `iframe` targets.
4. Select **Debug** on a target to open it in a dedicated DevTools window.

The panel prefers flattened CDP sessions and automatically falls back to the legacy
`Target.sendMessageToTarget` transport when required by an older WMPF Chromium runtime.
The bootstrap miniapp must remain open for the browser debugging session to continue.

## Background

Debugging a miniapp using this tool is actually debugging a tab of the embedded browser.
You can verify all targets via Protocol Monitor, and the miniapp tab (AppIndex) is already attached:

![ext1](screenshots/extension/protocol_monitor.1.png)

## Workaround

**Step 1.** Follow all steps in [README.md](README.md). You need to initialize one debug session via launching a miniapp. A minimal miniapp is recommended (e.g., WeChat official miniapp demo).

**Step 2.** In DevTools, open Protocol Monitor panel and toggle the CDP command editor:

![ext2](screenshots/extension/protocol_monitor.2.png)

**Step 3.** In CDP command editor, type in `Target.getTargets`, hit Send:

![ext3](screenshots/extension/protocol_monitor.3.png)

**Step 4.** In Protocol Monitor panel, find the sent CDP command, inspect the response on the right panel. Locate the browser tab you want to debug. Copy the `targetId` of the tab.

![ext4](screenshots/extension/protocol_monitor.4.png)

**Step 5.** In CDP command editor, type in `Target.attachToTarget`, type in the `targetId` parameter, hit Send:

![ext5](screenshots/extension/protocol_monitor.5.png)

All done. After these steps you have successfully attached to the tab. Please note that the Element tab will not update so you cannot use that panel to inspect the DOM tree. Also, you cannot close the miniapp since it will stop the debug session.

In addition, for miniapps that using `webview` tag, you can also use the same method above to attach to the WebView tab and inspect.


