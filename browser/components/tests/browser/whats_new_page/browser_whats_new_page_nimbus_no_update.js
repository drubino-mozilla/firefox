/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const EXPECTED_URL = "https://www.firefox.com/en-US/whatsnew/";

// The update directory used by this test is empty, so no update record exists.
// The milestone change alone should still open the Nimbus-provided What's New
// Page, which is the only path available to installs that are updated outside
// of the Mozilla updater (MSIX, Snap, Flatpak and distro packages).
add_task(async function nimbus_whats_new_page_without_update() {
  let um = Cc["@mozilla.org/updates/update-manager;1"].getService(
    Ci.nsIUpdateManager
  );
  ok(
    !(await um.lastUpdateInstalled()),
    "There should be no installed update record"
  );

  // The page under test is opened before the harness takes over the current tab
  // and removes that tab's history, so the Nimbus pref supplies two
  // pipe-separated URLs and this test uses the first tab.
  gBrowser.selectedTab = gBrowser.tabs[0];
  // The harness also changes the page to about:blank, so go back to the page
  // that was originally opened during startup.
  gBrowser.goBack();

  await TestUtils.waitForCondition(
    () => gBrowser.selectedBrowser?.currentURI?.spec == EXPECTED_URL,
    `Waiting for the expected page to reopen, ${gBrowser.selectedBrowser.currentURI.spec}`
  );
  is(
    gBrowser.selectedBrowser.currentURI.spec,
    EXPECTED_URL,
    "The what's new page should be the Nimbus URL despite there being no update"
  );
  gBrowser.removeTab(gBrowser.selectedTab);
});
