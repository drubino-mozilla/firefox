/* Any copyright is dedicated to the Public Domain.
https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { StartupTelemetry } = ChromeUtils.importESModule(
  "moz-src:///browser/components/StartupTelemetry.sys.mjs"
);

const ENV_VAR = "FIREFOX_LAUNCHED_BY_DESKTOP_LAUNCHER";

add_setup(function test_setup() {
  // FOG needs a profile directory to put its data in.
  do_get_profile();

  // FOG needs to be initialized in order for data to flow.
  Services.fog.initializeFOG();
});

add_task(async function test_not_launched_from_desktop_launcher() {
  // This test ensures that if the env variable isn't set, we don't mistakenly categorize
  // startup through desktop launcher
  await StartupTelemetry.pinningStatus();

  Assert.notEqual(
    "DesktopLauncher",
    Glean.osEnvironment.launchMethod.testGetValue()
  );
});

add_task(async function test_launched_from_desktop_launcher() {
  // Let's assume that the desktop launcher sets the environment variable correctly.
  // Set it manually in the test to simulate that behaviour
  Services.env.set(ENV_VAR, "TRUE");

  await StartupTelemetry.pinningStatus();

  Assert.equal(
    "DesktopLauncher",
    Glean.osEnvironment.launchMethod.testGetValue()
  );
});

// This file is Windows-only via `run-if = ["os == 'win'"]` in xpcshell.toml.
//
// classifyShortcut() is the tractable seam for the Startup-folder cases:
// Services.appinfo.processStartupShortcut is read-only and cannot be faked.
// It compares the path as a case-insensitive string prefix against the folders
// SHGetKnownFolderPath resolves and avoids I/O, so these synthesized paths do
// not need to exist on disk.
const STARTUP_RELATIVE_PATH =
  "Microsoft\\Windows\\Start Menu\\Programs\\Startup";

function classifyStartupShortcut(folder) {
  let shellService = Cc["@mozilla.org/browser/shell-service;1"].getService(
    Ci.nsIWindowsShellService
  );
  return shellService.classifyShortcut(
    `${folder}\\${STARTUP_RELATIVE_PATH}\\Firefox.lnk`
  );
}

// A Start Menu folder path is a prefix of its Startup folder path and
// ClassifyShortcut returns on first match, so the "Autostart" rows must stay
// above the "StartMenu" rows in its folders[] table. Getting "StartMenu" here
// means that ordering regressed.
add_task(function test_classifyShortcut_perUserStartupFolder() {
  Assert.equal(
    classifyStartupShortcut(Services.dirsvc.get("AppData", Ci.nsIFile).path),
    "Autostart",
    "A shortcut in the per-user Startup folder classifies as Autostart"
  );
});

add_task(function test_classifyShortcut_allUsersStartupFolder() {
  Assert.equal(
    classifyStartupShortcut(Services.env.get("ProgramData")),
    "Autostart",
    "A shortcut in the all-users Startup folder classifies as Autostart"
  );
});
