/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "backgroundModeEnabled",
  "browser.backgroundMode.enabled",
  false,
  () => BackgroundMode.onEnabledChanged()
);

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "trayIconEnabled",
  "browser.backgroundMode.trayIcon.enabled",
  true
);

const TRAY_URI = "chrome://browser/content/backgroundModeTray.xhtml";

// Far enough off-screen that the host window can never be seen, in case a
// window manager declines to honour the visibility flag we set on load.
const TRAY_FEATURES =
  "chrome,dialog=yes,titlebar=no,width=1,height=1,left=-32000,top=-32000";

/**
 * Brings the macOS "zero-window session" model to Windows, behind a pref.
 *
 * On macOS, nsAppStartup unconditionally holds one extra reference on its
 * mConsiderQuitStopper counter, so the counter floors at one rather than zero
 * and closing the last window never reaches the quit path. This does the same
 * thing from the front end by holding a lastWindowClosingSurvivalArea for as
 * long as the pref is set.
 *
 * macOS also has a hidden window that owns the menu bar and Dock menu, which is
 * what makes the zero-window state usable. Windows has no Dock, so instead we
 * open an off-screen host window while there are no browser windows and hang a
 * notification area icon off it. The icon is the only way back in, which is why
 * it owns both re-entry and quit.
 */
class BackgroundModeSingleton {
  #initialized = false;
  #holdingSurvivalRef = false;
  #trayWindow = null;
  #shuttingDown = false;
  #updateScheduled = false;

  get supported() {
    return AppConstants.platform == "win";
  }

  /**
   * True when closing the last browser window should leave the process running
   * instead of quitting. Callers that decide whether to run last-window-close
   * teardown should branch on this in the same places they branch on macOS.
   *
   * @returns {boolean}
   */
  get keepsSessionAlive() {
    return this.supported && lazy.backgroundModeEnabled;
  }

  init() {
    if (this.#initialized || !this.supported) {
      return;
    }
    this.#initialized = true;

    Services.obs.addObserver(this, "quit-application-granted");
    // A window is only discoverable as a browser window once its chrome
    // document has been parsed, which is well after domwindowopened, so use the
    // per-window startup notification for opens and domwindowclosed for closes.
    Services.obs.addObserver(this, "browser-delayed-startup-finished");
    Services.obs.addObserver(this, "domwindowclosed");

    this.#syncSurvivalRef();

    // A silent restart, which is how the update flow relaunches a browser that
    // was left running with no windows, deliberately opens no window at all.
    // None of the notifications above will ever fire in that case, so check the
    // window count once here. Without this the user would be left with a running
    // browser and no icon to get back into it.
    if (Services.startup.wasSilentlyStarted) {
      this.#scheduleUpdate();
    }
  }

  observe(subject, topic) {
    switch (topic) {
      case "quit-application-granted":
        // Mirrors what nsAppStartup::Quit does at this point on macOS: give up
        // the baseline reference so the counter can reach zero once the last
        // window is gone and shutdown can finish.
        this.#shuttingDown = true;
        this.#releaseSurvivalRef();
        break;
      case "browser-delayed-startup-finished":
      case "domwindowclosed":
        this.#scheduleUpdate();
        break;
    }
  }

  onEnabledChanged() {
    if (!this.#initialized) {
      return;
    }
    // Turning the pref off while running with no windows drops the last reason
    // to stay alive, so the browser quits once the host window is gone.
    this.#syncSurvivalRef();
    this.#scheduleUpdate();
  }

  #syncSurvivalRef() {
    if (this.#shuttingDown) {
      return;
    }
    if (this.keepsSessionAlive) {
      if (!this.#holdingSurvivalRef) {
        this.#holdingSurvivalRef = true;
        Services.startup.enterLastWindowClosingSurvivalArea();
      }
    } else {
      this.#releaseSurvivalRef();
    }
  }

  #releaseSurvivalRef() {
    if (!this.#holdingSurvivalRef) {
      return;
    }
    // Clear the flag first: exiting the survival area re-enters
    // nsAppStartup::Quit, which can run more of our code before returning.
    this.#holdingSurvivalRef = false;
    Services.startup.exitLastWindowClosingSurvivalArea();
  }

  #scheduleUpdate() {
    if (this.#updateScheduled) {
      return;
    }
    this.#updateScheduled = true;
    // Window registration settles after the current task, so count windows
    // once it has rather than racing the notification we are responding to.
    Services.tm.dispatchToMainThread(() => {
      this.#updateScheduled = false;
      this.#update();
    });
  }

  #update() {
    if (!this.#initialized || this.#shuttingDown) {
      return;
    }
    if (
      this.keepsSessionAlive &&
      lazy.trayIconEnabled &&
      !this.#browserWindowCount()
    ) {
      this.#showTray();
    } else {
      this.#hideTray();
    }
  }

  #browserWindowCount() {
    let count = 0;
    for (let win of Services.wm.getEnumerator("navigator:browser")) {
      if (!win.closed) {
        count++;
      }
    }
    return count;
  }

  #showTray() {
    if (this.#trayWindow && !this.#trayWindow.closed) {
      return;
    }
    // nsAppStartup::CreateChromeWindow refuses non-modal windows once
    // attemptingQuit is set, so never try once a quit is under way.
    if (Services.startup.attemptingQuit || Services.startup.shuttingDown) {
      return;
    }
    this.#trayWindow = Services.ww.openWindow(
      null,
      TRAY_URI,
      "_blank",
      TRAY_FEATURES,
      null
    );
  }

  #hideTray() {
    let win = this.#trayWindow;
    this.#trayWindow = null;
    if (win && !win.closed) {
      win.close();
    }
  }
}

export const BackgroundMode = new BackgroundModeSingleton();
