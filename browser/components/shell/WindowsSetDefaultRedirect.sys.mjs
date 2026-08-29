/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The IOpenWithLauncher api call protocol shared by the producer
 * (ShellService.setAsDefault{PDF,Protocol}Handler) and the consumer
 * (WindowsSetDefaultAppCmdHandler).
 *
 * ShellService arms a one-shot redirect before launching the OS "Open with"
 * picker via IOpenWithLauncher; once the user picks Firefox, the OS relaunches
 * Firefox with the same value and the command-line handler consumes it. This
 * module owns that shared state (its storage and the matching rules).
 *
 * The state is install-scoped, not profile-scoped: it describes a default the
 * *install* asked the OS to set, and the ProgID the OS invokes is a bare
 * `firefox.exe -osint -url "%1"` with no profile argument, so the relaunch
 * resolves whichever profile that install defaults to. Keying the storage on
 * the install hash means any profile of this install can consume what any
 * other armed, while a different install can never see it.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
});

// Name of the value, under the install-scoped key below, holding the
// { openWithArg, overrideUri, type } object consumed by
// WindowsSetDefaultAppCmdHandler when the user picks a default (file type or
// protocol) using the IOpenWithLauncher API. It is reset anytime the dialog is
// used again, or when we intercept the OS reopening one of our openWithArgs.
const REDIRECT_VALUE_NAME = "PendingRedirect";

export class WindowsSetDefaultRedirect {
  // Supported default types to set using IOpenWithLauncher.
  static TYPE = {
    FILE: 1 << 0,
    PROTOCOL: 1 << 1,
  };

  /**
   * HKCU key holding this install's pending redirect, e.g.
   * "Software\Mozilla\Firefox\SetDefaultApp\71AE18FE3142402B".
   *
   * @returns {string}
   */
  static get regPath() {
    const vendor = Services.appinfo.vendor || "Mozilla";
    const installHash = Cc["@mozilla.org/xre/directory-provider;1"]
      .getService(Ci.nsIXREDirProvider)
      .getInstallHash();
    return `Software\\${vendor}\\${AppConstants.MOZ_APP_NAME}\\SetDefaultApp\\${installHash}`;
  }

  /**
   * Stash a one-shot redirect for the IOpenWithLauncher call.
   *
   * @param {string} openWithArg
   *   The value handed to launchSetDefaultAppPicker, which the OS hands back as
   *   "-osint -url <openWithArg>" once the user picks a new default. Depending on
   *   type, this is either a file path on the system (file-type defaults) or a
   *   URL (protocol defaults).
   * @param {?string} overrideUri
   *   URI spec to open when openWithArg comes back, or null to consume the relaunch
   *   and open nothing.
   * @param {number} type
   *   One of WindowsSetDefaultRedirect.TYPE, identifying whether openWithArg is a
   *   file path or a URL.
   */
  static arm(openWithArg, overrideUri, type) {
    // Overwrites any stale object left by an older call.
    this.#write(
      JSON.stringify({ openWithArg, overrideUri: overrideUri ?? null, type })
    );
  }

  /**
   * Clear a pending redirect.
   */
  static clear() {
    let key;
    try {
      key = this.#openKey(Ci.nsIWindowsRegKey.ACCESS_WRITE);
      key.removeValue(REDIRECT_VALUE_NAME);
    } catch (e) {
      // Nothing armed, so nothing to clear.
    } finally {
      key?.close();
    }
  }

  /**
   * If `arg` is the openWithArg stashed by the most recent
   * launchSetDefaultAppPicker call, consume the one-shot redirect and return
   * its `{ overrideUri }`, where overrideUri is a URI spec to open or null to
   * just suppress the relaunch. Returns null when `arg` is unrelated to a
   * pending attempt to set a default.
   *
   * @param {string} arg - The -url value the OS handed back.
   * @returns {?{overrideUri: ?string}}
   */
  static consume(arg) {
    const state = this.#read();
    if (!state || !this.#matches(state, arg)) {
      return null;
    }
    this.clear();
    return { overrideUri: state.overrideUri ?? null };
  }

  /**
   * Open this install's key, creating it when opening for write.
   *
   * @param {number} mode - nsIWindowsRegKey ACCESS_* flags.
   * @returns {nsIWindowsRegKey} An open key the caller must close.
   */
  static #openKey(mode) {
    const key = Cc["@mozilla.org/windows-registry-key;1"].createInstance(
      Ci.nsIWindowsRegKey
    );
    const flags = mode | Ci.nsIWindowsRegKey.WOW64_64;
    if (mode & Ci.nsIWindowsRegKey.ACCESS_WRITE) {
      key.create(
        Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER,
        this.regPath,
        flags
      );
    } else {
      key.open(Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER, this.regPath, flags);
    }
    return key;
  }

  /**
   * @param {string} json - Serialized state to store.
   */
  static #write(json) {
    let key;
    try {
      key = this.#openKey(Ci.nsIWindowsRegKey.ACCESS_WRITE);
      key.writeStringValue(REDIRECT_VALUE_NAME, json);
    } catch (e) {
      console.error("Failed to store the pending set-default redirect:", e);
    } finally {
      key?.close();
    }
  }

  /**
   * Read and validate the pending redirect stashed by arm().
   *
   * @returns {?{openWithArg: string, overrideUri: ?string, type: number}} The
   * stored state, or null when nothing is armed, the value holds the wrong
   * type, or it is malformed JSON.
   */
  static #read() {
    let raw;
    let key;
    try {
      key = this.#openKey(Ci.nsIWindowsRegKey.ACCESS_READ);
      if (!key.hasValue(REDIRECT_VALUE_NAME)) {
        return null;
      }
      raw = key.readStringValue(REDIRECT_VALUE_NAME);
    } catch (e) {
      return null;
    } finally {
      key?.close();
    }
    if (!raw) {
      return null;
    }
    try {
      const state = JSON.parse(raw);
      return state && typeof state.openWithArg === "string" ? state : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Checks if the -url value the OS handed back matches the stashed redirect.
   *
   * @param {{openWithArg: string, type: number}} state - The stashed redirect.
   * @param {string} arg - The -url value from the OS relaunch.
   * @returns {boolean}
   */
  static #matches(state, arg) {
    switch (state.type) {
      case this.TYPE.PROTOCOL:
        return state.openWithArg === arg;
      case this.TYPE.FILE:
        try {
          return new lazy.FileUtils.File(state.openWithArg).equals(
            new lazy.FileUtils.File(arg)
          );
        } catch (e) {
          return false;
        }
      default:
        return false;
    }
  }
}
