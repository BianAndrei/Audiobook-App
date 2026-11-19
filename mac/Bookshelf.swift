// Bookshelf for macOS: a small native window around the local reader.
//
// It starts the reader and the Kokoro narrator (via manage.py), shows the library in its own
// window with its own Dock icon and menu bar, and on Quit saves your place and stops both servers.
// Built by scripts/make-dock-app.sh; the project folder and Python path come from Info.plist.

import Cocoa
import WebKit

private let info = Bundle.main.infoDictionary ?? [:]
private let projectPath = info["BookshelfProject"] as? String ?? ""
private let pythonPath = info["BookshelfPython"] as? String ?? "/usr/bin/python3"
private let port = 4173
private let appURL = URL(string: "http://localhost:\(port)/")!
private let healthURL = URL(string: "http://localhost:\(port)/api/health")!

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var loadedApp = false
    private var quitting = false

    // MARK: launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()                     // library lives here between launches
        config.mediaTypesRequiringUserActionForPlayback = []     // narration may start from a keypress
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false      // two-finger swipes turn pages instead
        if #available(macOS 13.3, *) { webView.isInspectable = true }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Bookshelf"
        window.minSize = NSSize(width: 640, height: 480)
        window.contentView = webView
        window.delegate = self
        window.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(calibratedRed: 0.11, green: 0.10, blue: 0.09, alpha: 1)
                : NSColor(calibratedRed: 0.96, green: 0.93, blue: 0.87, alpha: 1)
        }
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("BookshelfMainWindow")      // reopens at the same size and place
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        webView.loadHTMLString(Self.loadingPage, baseURL: nil)
        startServers()
        waitForReader(deadline: Date().addingTimeInterval(45))
    }

    private func startServers() {
        guard !projectPath.isEmpty else { return showError("This copy of Bookshelf doesn't know where its project folder is. Re-run scripts/make-dock-app.sh.") }
        run(["start", "--no-open"])
    }

    /// Runs `python3 manage.py <args>` without a shell, logging to .run/launcher.log.
    @discardableResult
    private func run(_ args: [String]) -> Process? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: pythonPath)
        process.arguments = [projectPath + "/manage.py"] + args
        process.currentDirectoryURL = URL(fileURLWithPath: projectPath)
        let runDir = projectPath + "/.run"
        try? FileManager.default.createDirectory(atPath: runDir, withIntermediateDirectories: true)
        let logPath = runDir + "/launcher.log"
        if !FileManager.default.fileExists(atPath: logPath) { FileManager.default.createFile(atPath: logPath, contents: nil) }
        if let log = FileHandle(forWritingAtPath: logPath) {
            log.seekToEndOfFile()
            process.standardOutput = log
            process.standardError = log
        }
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch {
            showError("Couldn't start the reader: \(error.localizedDescription)")
            return nil
        }
        return process
    }

    private func waitForReader(deadline: Date) {
        var request = URLRequest(url: healthURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
        request.httpMethod = "GET"
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.loadedApp = true
                    self.webView.load(URLRequest(url: appURL))
                } else if Date() < deadline {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.waitForReader(deadline: deadline) }
                } else {
                    self.showError("The reader didn't start. Details are in the project's .run/server.log and .run/launcher.log.")
                }
            }
        }.resume()
    }

    private func showError(_ message: String) {
        let escaped = message.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        webView.loadHTMLString(Self.loadingPage.replacingOccurrences(of: "Opening your library…", with: escaped)
            .replacingOccurrences(of: "class=\"spin\"", with: "class=\"spin\" hidden"), baseURL: nil)
    }

    // MARK: quit: save your place, then stop the reader and the narrator

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting { return .terminateNow }
        quitting = true
        var replied = false
        let finish = { [weak self] in
            guard !replied else { return }
            replied = true
            self?.run(["stop"])  // keeps running after we exit; frees the narrator's memory
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        guard loadedApp else { finish(); return .terminateLater }
        webView.callAsyncJavaScript("if (window.bookshelf && window.bookshelf.flush) { await window.bookshelf.flush(); }",
                                    arguments: [:], in: nil, in: .page) { _ in finish() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { finish() }  // never hang on quit
        return .terminateLater
    }

    // MARK: web view

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return decisionHandler(.allow) }
        if (url.host == "localhost" || url.host == "127.0.0.1") && url.port == port { return decisionHandler(.allow) }
        if url.scheme == "http" || url.scheme == "https" || url.scheme == "mailto" { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)  // anything else never loads inside the app
    }

    // Links that ask for a new window open in the default browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme == "http" || url.scheme == "https" { NSWorkspace.shared.open(url) }
        return nil
    }

    // "Add Book" file picker.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if loadedApp { webView.load(URLRequest(url: appURL)) }
    }

    @objc private func reloadPage(_ sender: Any?) {
        if loadedApp { webView.load(URLRequest(url: appURL)) } else { waitForReader(deadline: Date().addingTimeInterval(20)) }
    }

    // MARK: menus

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Bookshelf", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Bookshelf", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Bookshelf", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reloadPage(_:)), keyEquivalent: "r").target = self
        view.addItem(.separator())
        let full = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        full.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = view
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }

    private static let loadingPage = """
    <!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: light dark; }
    html, body { height: 100%; margin: 0; }
    body { display: grid; place-items: center; background: #f5eddf; color: #6b5a45;
           font: 15px -apple-system, BlinkMacSystemFont, sans-serif; }
    @media (prefers-color-scheme: dark) { body { background: #1c1a17; color: #bfb3a3; } }
    .box { text-align: center; max-width: 420px; padding: 0 24px; line-height: 1.5; }
    .spin { width: 22px; height: 22px; margin: 0 auto 14px; border-radius: 50%;
            border: 2.5px solid currentColor; border-right-color: transparent; animation: r .8s linear infinite; opacity: .6; }
    @keyframes r { to { transform: rotate(360deg); } }
    </style></head><body><div class="box"><div class="spin"></div>Opening your library…</div></body></html>
    """
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
