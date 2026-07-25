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

// Positioned far enough off-screen that the host window can never be seen, in
// case a window manager declines to honour the visibility flag we set on load.
//
// alert=yes is what keeps this window out of the taskbar and out of Alt-Tab: it
// is the only route to WS_EX_TOOLWINDOW for a non-popup window, via
// CHROME_ALERT -> InitData::mIsAlert -> nsWindow::WindowExStyle. Without it the
// window acquires a taskbar button as soon as SystemStatusBar calls
// SetForegroundWindow on it to open the icon's menu. It requires dialog=yes.
const TRAY_FEATURES =
  "chrome,dialog=yes,alert=yes,titlebar=no,width=1,height=1,left=-32000,top=-32000";

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
 * open an off-screen host window and hang a notification area icon off it. The
 * icon is the only way back in, which is why it owns both re-entry and quit.
 *
 * The icon exists for exactly as long as the pref is set, rather than only while
 * there are no windows: a background application that appears in the
 * notification area only some of the time is not a pattern users recognise, and
 * it would give no indication ahead of time that closing the last window is not
 * going to quit.
 */
class BackgroundModeSingleton {
  #initialized = false;
  #holdingSurvivalRef = false;
  #trayWindow = null;
  #shuttingDown = false;
  #startupComplete = false;

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
    // Only used to tell when it is safe to add a window of our own; opening one
    // during startup would compete with the first browser window.
    Services.obs.addObserver(this, "browser-delayed-startup-finished");

    this.#syncSurvivalRef();
  }

  observe(subject, topic) {
    switch (topic) {
      case "quit-application-granted":
        // Mirrors what nsAppStartup::Quit does at this point on macOS: give up
        // the baseline reference so the counter can reach zero once the last
        // window is gone and shutdown can finish. The host window is closed by
        // Quit's own CloseAllWindows.
        this.#shuttingDown = true;
        this.#releaseSurvivalRef();
        break;
      case "browser-delayed-startup-finished":
        this.#onStartupComplete();
        break;
    }
  }

  #onStartupComplete() {
    if (this.#startupComplete) {
      return;
    }
    this.#startupComplete = true;
    Services.obs.removeObserver(this, "browser-delayed-startup-finished");
    this.#syncTrayHost();
  }

  onEnabledChanged() {
    if (!this.#initialized) {
      return;
    }
    // Turning the pref off while running with no windows drops the last reason
    // to stay alive, so the browser quits once the host window is gone.
    this.#syncSurvivalRef();
    this.#syncTrayHost();
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

  #syncTrayHost() {
    if (this.#shuttingDown || !this.#startupComplete) {
      return;
    }
    if (this.keepsSessionAlive && lazy.trayIconEnabled) {
      this.#openTrayHost();
    } else {
      this.#closeTrayHost();
    }
  }

  #openTrayHost() {
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

  #closeTrayHost() {
    let win = this.#trayWindow;
    this.#trayWindow = null;
    if (win && !win.closed) {
      win.close();
    }
  }
}

export const BackgroundMode = new BackgroundModeSingleton();
