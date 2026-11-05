/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

XPCOMUtils.defineLazyServiceGetters(lazy, {
  WindowsUIUtils: ["@mozilla.org/windows-ui-utils;1", Ci.nsIWindowsUIUtils],
});

ChromeUtils.defineLazyGetter(lazy, "logConsole", () =>
  console.createInstance({
    prefix: "DockedBar",
    maxLogLevel: "All",
  })
);

const PREF_ENABLED = "browser.dockedbar.enabled";
// Foxfood Mode: open what's launched from the bar in the OS default browser
// instead of this Firefox, when the default is a different Firefox install.
const PREF_FOXFOOD = "browser.dockedbar.foxfood";
const WIDGET_ID = "dockedbar-button";
const STYLESHEET = "chrome://browser/skin/dockedbar.css";

// Height of the window while the results dropdown is open, in CSS pixels. It
// has room for the tallest dropdown and its shadow. The window is see-through
// and lets clicks through outside the toolbar and the dropdown, so it doesn't
// need to fit the dropdown. The dropdown's maximum height depends on the
// window's, so growing the window to fit it would be a feedback loop.
const OPEN_WINDOW_HEIGHT = 600;

/** @type {Window|null} */
let gBarWindow = null;
let gOpening = null;
let gObservers = [];
/** What was in the docked address bar when the user last picked something. */
let gCommittedText = "";

function isEnabled() {
  return Services.prefs.getBoolPref(PREF_ENABLED, false);
}

/**
 * Keeps the reserved strip as tall as the bar's toolbar, and while the results
 * dropdown is open, makes room for it and lets it take clicks.
 *
 * @param {Window} win
 */
function observeWindowContents(win) {
  let urlbar = win.gURLBar;
  let dropdown =
    urlbar.panel.querySelector(".urlbarView-background") ?? urlbar.panel;

  let update = () => {
    let scale = win.devicePixelRatio;
    let toolbarHeight = Math.ceil(
      win.gNavToolbox.getBoundingClientRect().height * scale
    );
    lazy.WindowsUIUtils.dockAsAppBar(win, toolbarHeight);

    let windowHeight = toolbarHeight;
    let hitRegions = [];
    if (urlbar.hasAttribute("open")) {
      let bounds = dropdown.getBoundingClientRect();
      windowHeight = Math.max(
        toolbarHeight,
        Math.ceil(OPEN_WINDOW_HEIGHT * scale)
      );
      hitRegions = [
        Math.round(bounds.left * scale),
        Math.round(bounds.top * scale),
        Math.round(bounds.width * scale),
        Math.round(bounds.height * scale),
        Math.round(
          parseFloat(win.getComputedStyle(dropdown).borderBottomLeftRadius) *
            scale
        ),
      ];
    }
    lazy.WindowsUIUtils.setAppBarWindowHeight(win, windowHeight);
    lazy.WindowsUIUtils.setAppBarHitRegions(win, hitRegions);
  };

  // Resizing the native window synchronously from inside an observer callback,
  // which runs during the refresh driver tick, loses pending restyles in the
  // results view. Coalesce and resize from a separate task instead.
  let updatePending = false;
  let scheduleUpdate = () => {
    if (updatePending) {
      return;
    }
    updatePending = true;
    Services.tm.dispatchToMainThread(() => {
      updatePending = false;
      if (!win.closed) {
        update();
      }
    });
  };

  let mutationObserver = new win.MutationObserver(scheduleUpdate);
  mutationObserver.observe(urlbar, { attributeFilter: ["open"] });
  let resizeObserver = new win.ResizeObserver(scheduleUpdate);
  resizeObserver.observe(win.gNavToolbox);
  resizeObserver.observe(urlbar.panel);
  resizeObserver.observe(dropdown);
  gObservers = [mutationObserver, resizeObserver];
  update();
}

/**
 * Remembers what's in the address bar just before a pick, by Enter or by
 * clicking a result, so it can stay in the bar after the page opens elsewhere.
 * The address bar replaces its value with the picked URL before loading it.
 *
 * @param {Window} win
 */
function trackCommittedText(win) {
  let urlbar = win.gURLBar;
  let remember = () => (gCommittedText = urlbar.value);
  urlbar.inputField.addEventListener(
    "keydown",
    event => {
      if (event.key == "Enter") {
        remember();
      }
    },
    true
  );
  urlbar.panel.addEventListener("mousedown", remember, true);
}

/**
 * Treats the bar window losing and gaining focus like the address bar losing
 * and gaining it, as it effectively does from the user's point of view. The
 * address bar otherwise stays focused in the inactive window, showing its
 * selection in the low contrast inactive selection colors.
 *
 * @param {Window} win
 */
function syncFocusWithWindow(win) {
  let input = win.gURLBar.inputField;
  win.addEventListener("deactivate", () => {
    if (win.document.activeElement == input) {
      input.blur();
    }
  });
  win.addEventListener("activate", () => {
    if (win.document.activeElement == input) {
      input.select();
    }
  });
}

function readRegistryString(root, path, name) {
  let key = Cc["@mozilla.org/windows-registry-key;1"].createInstance(
    Ci.nsIWindowsRegKey
  );
  try {
    key.open(root, path, Ci.nsIWindowsRegKey.ACCESS_READ);
    return key.readStringValue(name);
  } catch {
    return null;
  } finally {
    key.close();
  }
}

/**
 * The executable of the OS default browser, if it is a Firefox install other
 * than this one.
 *
 * @returns {nsIFile|null}
 */
function getOtherDefaultFirefox() {
  const { ROOT_KEY_CURRENT_USER, ROOT_KEY_CLASSES_ROOT } = Ci.nsIWindowsRegKey;
  const associations =
    "Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https";
  // Windows 11 records the default in UserChoiceLatest and can leave a stale
  // value in the older UserChoice key.
  let progId =
    readRegistryString(
      ROOT_KEY_CURRENT_USER,
      `${associations}\\UserChoiceLatest\\ProgId`,
      "ProgId"
    ) ||
    readRegistryString(
      ROOT_KEY_CURRENT_USER,
      `${associations}\\UserChoice`,
      "ProgId"
    );
  if (!progId?.startsWith("FirefoxURL")) {
    return null;
  }
  let command = readRegistryString(
    ROOT_KEY_CLASSES_ROOT,
    `${progId}\\shell\\open\\command`,
    ""
  );
  let exePath = command?.match(/^"([^"]+)"/)?.[1];
  if (!exePath || !/\\firefox\.exe$/i.test(exePath)) {
    return null;
  }
  let exe = new lazy.FileUtils.File(exePath);
  let self = Services.dirsvc.get("XREExeF", Ci.nsIFile);
  if (!exe.exists() || exe.path.toLowerCase() == self.path.toLowerCase()) {
    return null;
  }
  return exe;
}

function isFoxfoodEnabled() {
  return Services.prefs.getBoolPref(PREF_FOXFOOD, false);
}

/**
 * Runs the default Firefox with aArgs if Foxfood Mode is on and available.
 *
 * @param {string[]} args
 * @returns {boolean} Whether it was launched.
 */
function launchInFoxfoodFirefox(args) {
  if (!isFoxfoodEnabled()) {
    return false;
  }
  let exe = getOtherDefaultFirefox();
  if (!exe) {
    return false;
  }
  let process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
  process.init(exe);
  process.runwAsync(args, args.length);
  // The launched process hands the command line to the running Firefox, but
  // can't pass on the right to come to the front. This Firefox has it while
  // the user is clicking in the bar, so raise that Firefox from here. Try again
  // shortly in case it had no window and is opening one.
  let raise = () => {
    try {
      lazy.WindowsUIUtils.raiseTopWindowOfExecutable(exe.path);
      return true;
    } catch {
      return false;
    }
  };
  if (!raise()) {
    lazy.setTimeout(raise, 1000);
  }
  return true;
}

function openNewTab() {
  if (launchInFoxfoodFirefox(["-new-tab", "about:newtab"])) {
    return;
  }
  let target = lazy.BrowserWindowTracker.getTopWindow({
    allowFromInactiveWorkspace: true,
  });
  if (!target) {
    lazy.BrowserWindowTracker.openWindow();
    return;
  }
  target.BrowserCommands.openTab();
  if (target.windowState == target.STATE_MINIMIZED) {
    target.restore();
  }
  target.focus();
}

function createMenu(doc) {
  let menu = doc.createXULElement("menupopup");
  menu.id = "dockedbar-menu";

  let close = doc.createXULElement("menuitem");
  close.id = "dockedbar-menu-close";
  doc.l10n.setAttributes(close, "dockedbar-menu-close");
  close.addEventListener("command", () =>
    Services.prefs.setBoolPref(PREF_ENABLED, false)
  );

  let foxfood = doc.createXULElement("menuitem");
  foxfood.id = "dockedbar-menu-foxfood";
  foxfood.setAttribute("type", "checkbox");
  doc.l10n.setAttributes(foxfood, "dockedbar-menu-foxfood");
  foxfood.addEventListener("command", () =>
    Services.prefs.setBoolPref(PREF_FOXFOOD, foxfood.hasAttribute("checked"))
  );

  menu.addEventListener("popupshowing", () => {
    let available = !!getOtherDefaultFirefox();
    foxfood.disabled = !available;
    foxfood.toggleAttribute("checked", available && isFoxfoodEnabled());
  });

  menu.append(close, foxfood);
  doc.getElementById("mainPopupSet").append(menu);
  return menu;
}

function addControls(win) {
  let doc = win.document;
  let navBar = doc.getElementById("nav-bar");
  let customizationTarget = doc.getElementById("nav-bar-customization-target");

  let menu = createMenu(doc);
  let menuButton = doc.createXULElement("toolbarbutton");
  menuButton.id = "dockedbar-menu-button";
  menuButton.className = "toolbarbutton-1";
  menuButton.setAttribute("aria-haspopup", "menu");
  doc.l10n.setAttributes(menuButton, "dockedbar-menu-button");
  menuButton.addEventListener("command", () =>
    menu.openPopup(menuButton, { position: "after_start" })
  );
  menu.addEventListener("popupshowing", () =>
    menuButton.setAttribute("open", "true")
  );
  menu.addEventListener("popuphiding", () =>
    menuButton.removeAttribute("open")
  );
  navBar.insertBefore(menuButton, customizationTarget);

  let newTabButton = doc.createXULElement("toolbarbutton");
  newTabButton.id = "dockedbar-new-tab-button";
  newTabButton.className = "toolbarbutton-1";
  doc.l10n.setAttributes(newTabButton, "dockedbar-new-tab-button");
  newTabButton.addEventListener("command", openNewTab);
  navBar.append(newTabButton);
}

async function openBar() {
  if (gBarWindow || gOpening) {
    return;
  }

  let url = Cc["@mozilla.org/supports-string;1"].createInstance(
    Ci.nsISupportsString
  );
  url.data = "about:blank";
  let extraOptions = Cc["@mozilla.org/hash-property-bag;1"].createInstance(
    Ci.nsIWritablePropertyBag2
  );
  extraOptions.setPropertyAsBool("dockedbar", true);
  let args = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
  args.appendElement(url);
  args.appendElement(extraOptions);

  gOpening = lazy.BrowserWindowTracker.promiseOpenWindow({
    args,
    features: "toolbar,alwaysontop,resizable=no,titlebar=no",
    all: false,
  });
  let win = await gOpening;
  gOpening = null;
  gBarWindow = win;

  win.addEventListener(
    "unload",
    () => {
      for (let observer of gObservers) {
        observer.disconnect();
      }
      gObservers = [];
      gBarWindow = null;
    },
    { once: true }
  );

  if (!isEnabled()) {
    win.close();
    return;
  }

  try {
    win.windowUtils.loadSheetUsingURIString(
      STYLESHEET,
      win.windowUtils.AUTHOR_SHEET
    );
    addControls(win);
    trackCommittedText(win);
    syncFocusWithWindow(win);
    if (win.windowState == win.STATE_MAXIMIZED) {
      win.restore();
    }
    await win.promiseDocumentFlushed(() => {});
    observeWindowContents(win);
  } catch (ex) {
    lazy.logConsole.error("Failed to set up the docked bar", ex);
  }
}

function closeBar() {
  if (gBarWindow) {
    lazy.WindowsUIUtils.undockAppBar(gBarWindow);
    gBarWindow.close();
  }
}

function openHere(barWin, url, where, params) {
  let target = lazy.BrowserWindowTracker.getTopWindow({
    private: lazy.PrivateBrowsingUtils.isWindowPrivate(barWin),
    allowFromInactiveWorkspace: true,
  });
  delete params.targetBrowser;
  params.inBackground = false;
  if (!target || where == "window") {
    params.initiatingDoc = barWin.document;
    barWin.openTrustedLinkIn(url, "window", params);
    return;
  }
  params.initiatingDoc = target.document;
  target.openTrustedLinkIn(url, "tab", params);
  if (target.windowState == target.STATE_MINIMIZED) {
    target.restore();
  }
  target.focus();
}

function updateButton(node) {
  let enabled = isEnabled();
  node.toggleAttribute("checked", enabled);
  node.setAttribute("aria-pressed", enabled);
}

function onPrefChanged() {
  if (isEnabled()) {
    openBar();
  } else {
    closeBar();
  }
  for (let { node } of lazy.CustomizableUI.getWidget(WIDGET_ID).instances) {
    if (node) {
      updateButton(node);
    }
  }
}

export const DockedBar = {
  init() {
    if (AppConstants.platform != "win") {
      return;
    }
    lazy.CustomizableUI.createWidget({
      id: WIDGET_ID,
      type: "button",
      l10nId: "dockedbar-toggle-button",
      defaultArea: lazy.CustomizableUI.AREA_NAVBAR,
      onCreated: updateButton,
      onCommand() {
        Services.prefs.setBoolPref(PREF_ENABLED, !isEnabled());
      },
    });
    Services.prefs.addObserver(PREF_ENABLED, onPrefChanged);
    onPrefChanged();
  },

  /**
   * Opens a load requested from the docked bar's address bar, in the default
   * Firefox in Foxfood Mode and otherwise in the most recent normal browser
   * window. What the user had in the bar stays there, editable.
   *
   * @param {Window} barWin
   *   The docked bar window.
   * @param {string} url
   *   The URL to load.
   * @param {string} where
   *   Where the address bar asked to open the URL, per `openTrustedLinkIn`.
   * @param {object} params
   *   The `openTrustedLinkIn` params.
   */
  openFromBar(barWin, url, where, params) {
    // A command line can't carry POST data, so those searches open here.
    let launched =
      !params.postData &&
      launchInFoxfoodFirefox([
        where == "window" ? "-new-window" : "-new-tab",
        url,
      ]);
    if (!launched) {
      openHere(barWin, url, where, params);
    }
    let text = gCommittedText;
    barWin.setTimeout(() => {
      let urlbar = barWin.gURLBar;
      urlbar.setValue(text, { valueIsTyped: true });
      urlbar.userTypedValue = text;
      urlbar.setPageProxyState("invalid");
    }, 0);
  },
};
