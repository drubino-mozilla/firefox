/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// This window is never shown. It exists only while there are no browser windows
// open, to give the notification area icon's menu a document and a widget to
// anchor to, the way the macOS hidden window hosts the Dock menu.

const { BrowserWindowTracker } = ChromeUtils.importESModule(
  "resource:///modules/BrowserWindowTracker.sys.mjs"
);
const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PrivateBrowsingUtils.sys.mjs"
);

const BackgroundModeTray = {
  statusBar: null,
  menu: null,

  async onLoad() {
    this.menu = document.getElementById("background-mode-tray-menu");
    this.menu.addEventListener("systemstatusbarclick", this);
    this.menu.addEventListener("command", this);

    if (PrivateBrowsingUtils.permanentPrivateBrowsing) {
      document.getElementById("background-mode-new-window").hidden = true;
    }
    if (!PrivateBrowsingUtils.enabled) {
      document.getElementById("background-mode-new-private-window").hidden =
        true;
    }

    // The icon's tooltip is read off the menu's label attribute when the item is
    // added, so the labels have to be applied first.
    await document.l10n.ready;

    this.statusBar = Cc["@mozilla.org/widget/systemstatusbar;1"].getService(
      Ci.nsISystemStatusBar
    );
    this.statusBar.addItem(this.menu);

    // Hide only after the item exists, so the menu's frames and widget are
    // built while the window is still nominally visible.
    window.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).visibility =
      false;
  },

  onUnload() {
    // The status bar holds a strong reference to the menu element until the item
    // is removed, which would otherwise leave a dead icon behind.
    this.statusBar?.removeItem(this.menu);
    this.statusBar = null;
  },

  openWindow(options = {}) {
    // SystemStatusBar calls SetForegroundWindow on this window before handing us
    // the click, so the process already has the right to raise the new window.
    BrowserWindowTracker.openWindow(options).focus();
  },

  handleEvent(event) {
    switch (event.type) {
      case "load":
        this.onLoad();
        break;
      case "unload":
        this.onUnload();
        break;
      case "systemstatusbarclick":
        this.openWindow();
        break;
      case "command":
        switch (event.target.id) {
          case "background-mode-new-window":
            this.openWindow();
            break;
          case "background-mode-new-private-window":
            this.openWindow({ private: true });
            break;
          case "background-mode-quit":
            Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
            break;
        }
        break;
    }
  },
};

addEventListener("load", BackgroundModeTray, { once: true });
addEventListener("unload", BackgroundModeTray, { once: true });
