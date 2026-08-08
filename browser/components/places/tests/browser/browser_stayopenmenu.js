/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

// Menus should stay open (if pref is set) after ctrl-click, middle-click,
// ctrl-Enter, and contextmenu's "Open in a new tab" click.

const ACCEL =
  AppConstants.platform === "macosx" ? { metaKey: true } : { ctrlKey: true };

// The menubar is a native menu on Mac, which doesn't route mouse or keyboard
// activation through the closemenu attribute this feature relies on.
const NATIVE_MENUBAR = AppConstants.platform === "macosx";

async function locateBookmarkAndTestCtrlClick(menupopup) {
  let testMenuitem = [...menupopup.children].find(
    node => node.label == "Test1"
  );
  ok(testMenuitem, "Found test bookmark.");
  ok(BrowserTestUtils.isVisible(testMenuitem), "Should be visible");
  let promiseTabOpened = BrowserTestUtils.waitForNewTab(gBrowser, null);
  EventUtils.synthesizeMouseAtCenter(testMenuitem, { accelKey: true });
  let newTab = await promiseTabOpened;
  ok(true, "Bookmark ctrl-click opened new tab.");
  BrowserTestUtils.removeTab(newTab);
  return testMenuitem;
}

async function testContextmenu(menuitem) {
  let doc = menuitem.ownerDocument;
  let cm = doc.getElementById("placesContext");
  let promiseEvent = BrowserTestUtils.waitForEvent(cm, "popupshown");
  EventUtils.synthesizeMouseAtCenter(menuitem, {
    type: "contextmenu",
    button: 2,
  });
  await promiseEvent;
  let promiseTabOpened = BrowserTestUtils.waitForNewTab(gBrowser, null);
  let hidden = BrowserTestUtils.waitForEvent(cm, "popuphidden");
  cm.activateItem(doc.getElementById("placesContext_open:newtab"));
  await hidden;
  let newTab = await promiseTabOpened;
  return newTab;
}

add_setup(async function () {
  // Ensure BMB is available in UI.
  let origBMBlocation = CustomizableUI.getPlacementOfWidget(
    "bookmarks-menu-button"
  );
  if (!origBMBlocation) {
    CustomizableUI.addWidgetToArea(
      "bookmarks-menu-button",
      CustomizableUI.AREA_NAVBAR
    );
  }

  await SpecialPowers.pushPrefEnv({
    set: [["browser.bookmarks.openInTabClosesMenu", false]],
  });
  // Ensure menubar visible.
  let menubar = document.getElementById("toolbar-menubar");
  let menubarVisible = isToolbarVisible(menubar);
  if (!menubarVisible) {
    setToolbarVisibility(menubar, true);
    info("Menubar made visible");
  }
  // Ensure Bookmarks Toolbar Visible.
  let toolbar = document.getElementById("PersonalToolbar");
  let toolbarHidden = toolbar.collapsed;
  if (toolbarHidden) {
    await promiseSetToolbarVisibility(toolbar, true);
    info("Bookmarks toolbar made visible");
  }
  // Create our test bookmarks.
  await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.menuGuid,
    url: "https://example.com/",
    title: "Test1",
  });
  let folder = await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.toolbarGuid,
    type: PlacesUtils.bookmarks.TYPE_FOLDER,
    title: "TEST_TITLE",
    index: 0,
  });
  await PlacesUtils.bookmarks.insert({
    parentGuid: folder.guid,
    url: "https://example.com/",
    title: "Test1",
  });

  // A folder in the Bookmarks Menu, so we can check that opening a whole
  // folder in tabs also leaves the menu open.
  let menuFolder = await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.menuGuid,
    type: PlacesUtils.bookmarks.TYPE_FOLDER,
    title: "TEST_MENU_FOLDER",
  });
  await PlacesUtils.bookmarks.insert({
    parentGuid: menuFolder.guid,
    url: "https://example.com/infolder1",
    title: "InFolder1",
  });
  await PlacesUtils.bookmarks.insert({
    parentGuid: menuFolder.guid,
    url: "https://example.com/infolder2",
    title: "InFolder2",
  });

  // A history entry, for the History menu tests.
  await PlacesTestUtils.addVisits([
    { uri: "https://example.com/history1", title: "History1" },
  ]);

  registerCleanupFunction(async function () {
    await PlacesUtils.bookmarks.eraseEverything();
    await PlacesUtils.history.clear();
    // if BMB was not originally in UI, remove it.
    if (!origBMBlocation) {
      CustomizableUI.removeWidgetFromArea("bookmarks-menu-button");
    }
    // Restore menubar to original visibility.
    setToolbarVisibility(menubar, menubarVisible);
    // Restore original bookmarks toolbar visibility.
    if (toolbarHidden) {
      await promiseSetToolbarVisibility(toolbar, false);
    }
  });
});

add_task(async function testStayopenBookmarksClicks() {
  // Test Bookmarks Menu Button stayopen clicks - Ctrl-click.
  let BMB = document.getElementById("bookmarks-menu-button");
  let BMBpopup = document.getElementById("BMB_bookmarksPopup");
  let promiseEvent = BrowserTestUtils.waitForEvent(BMBpopup, "popupshown");
  EventUtils.synthesizeMouseAtCenter(BMB, {});
  await promiseEvent;
  info("Popupshown on Bookmarks-Menu-Button");
  var menuitem = await locateBookmarkAndTestCtrlClick(BMBpopup);
  ok(BMB.open, "Bookmarks Menu Button's Popup should still be open.");

  // Test Bookmarks Menu Button stayopen clicks: middle-click.
  let promiseTabOpened = BrowserTestUtils.waitForNewTab(gBrowser, null);
  EventUtils.synthesizeMouseAtCenter(menuitem, { button: 1 });
  let newTab = await promiseTabOpened;
  ok(true, "Bookmark middle-click opened new tab.");
  BrowserTestUtils.removeTab(newTab);
  ok(BMB.open, "Bookmarks Menu Button's Popup should still be open.");

  // Test Bookmarks Menu Button stayopen clicks - 'Open in new tab' on context menu.
  newTab = await testContextmenu(menuitem);
  ok(true, "Bookmark contextmenu opened new tab.");
  ok(BMB.open, "Bookmarks Menu Button's Popup should still be open.");
  promiseEvent = BrowserTestUtils.waitForEvent(BMBpopup, "popuphidden");
  BMB.open = false;
  await promiseEvent;
  info("Closing menu");
  BrowserTestUtils.removeTab(newTab);

  // Test App Menu's Bookmarks Library stayopen clicks.
  let appMenu = document.getElementById("PanelUI-menu-button");
  let appMenuPopup = document.getElementById("appMenu-popup");
  let PopupShownPromise = BrowserTestUtils.waitForEvent(
    appMenuPopup,
    "popupshown"
  );
  appMenu.click();
  await PopupShownPromise;

  let BMview;
  document.getElementById("appMenu-bookmarks-button").click();
  BMview = document.getElementById("PanelUI-bookmarks");
  let promise = BrowserTestUtils.waitForEvent(BMview, "ViewShown");
  await promise;
  info("Bookmarks panel shown.");

  // Test App Menu's Bookmarks Library stayopen clicks: Ctrl-click.
  let menu = document.getElementById("panelMenu_bookmarksMenu");
  var testMenuitem = await locateBookmarkAndTestCtrlClick(menu);
  ok(appMenu.open, "Menu should remain open.");

  // Test App Menu's Bookmarks Library stayopen clicks: middle-click.
  promiseTabOpened = BrowserTestUtils.waitForNewTab(gBrowser, null);
  EventUtils.synthesizeMouseAtCenter(testMenuitem, { button: 1 });
  newTab = await promiseTabOpened;
  ok(true, "Bookmark middle-click opened new tab.");
  BrowserTestUtils.removeTab(newTab);
  ok(
    PanelView.forNode(BMview).active,
    "Should still show the bookmarks subview"
  );
  ok(appMenu.open, "Menu should remain open.");

  // Close the App Menu
  appMenuPopup.hidePopup();
  ok(!appMenu.open, "The menu should now be closed.");

  // The remaining checks use the menubar, which is a native menu on Mac.
  if (NATIVE_MENUBAR) {
    return;
  }

  // Test Bookmarks Menu (menubar) stayopen clicks: Ctrl-click.
  let BM = document.getElementById("bookmarksMenu");
  let BMpopup = document.getElementById("bookmarksMenuPopup");
  promiseEvent = BrowserTestUtils.waitForEvent(BMpopup, "popupshown");
  EventUtils.synthesizeMouseAtCenter(BM, {});
  await promiseEvent;
  info("Popupshowing on Bookmarks Menu");
  menuitem = await locateBookmarkAndTestCtrlClick(BMpopup);
  ok(BM.open, "Bookmarks Menu's Popup should still be open.");

  // Test Bookmarks Menu (menubar) stayopen clicks: middle-click.
  promiseTabOpened = BrowserTestUtils.waitForNewTab(gBrowser, null);
  EventUtils.synthesizeMouseAtCenter(menuitem, { button: 1 });
  newTab = await promiseTabOpened;
  ok(true, "Bookmark middle-click opened new tab.");
  BrowserTestUtils.removeTab(newTab);
  ok(BM.open, "Bookmarks Menu's Popup should still be open.");

  // Test Bookmarks Menu (menubar) stayopen clicks: 'Open in new tab' on context menu.
  newTab = await testContextmenu(menuitem);
  ok(true, "Bookmark contextmenu opened new tab.");
  BrowserTestUtils.removeTab(newTab);
  ok(BM.open, "Bookmarks Menu's Popup should still be open.");
  promiseEvent = BrowserTestUtils.waitForEvent(BMpopup, "popuphidden");
  BM.open = false;
  await promiseEvent;

  // Test Bookmarks Toolbar stayopen clicks - Ctrl-click.
  let BT = document.getElementById("PlacesToolbarItems");
  let toolbarbutton = BT.firstElementChild;
  ok(toolbarbutton, "Folder should be first item on Bookmarks Toolbar.");
  let buttonMenupopup = toolbarbutton.firstElementChild;
  Assert.equal(
    buttonMenupopup.tagName,
    "menupopup",
    "Found toolbar button's menupopup."
  );
  promiseEvent = BrowserTestUtils.waitForEvent(buttonMenupopup, "popupshown");
  EventUtils.synthesizeMouseAtCenter(toolbarbutton, {});
  await promiseEvent;
  ok(true, "Bookmarks toolbar folder's popup is open.");
  menuitem = buttonMenupopup.firstElementChild.nextElementSibling;
  promiseTabOpened = BrowserTestUtils.waitForNewTab(gBrowser, null);
  EventUtils.synthesizeMouseAtCenter(menuitem, { ctrlKey: true });
  newTab = await promiseTabOpened;
  ok(
    true,
    "Bookmark in folder on bookmark's toolbar ctrl-click opened new tab."
  );
  ok(
    toolbarbutton.open,
    "Popup of folder on bookmark's toolbar should still be open."
  );
  promiseEvent = BrowserTestUtils.waitForEvent(buttonMenupopup, "popuphidden");
  toolbarbutton.open = false;
  await promiseEvent;
  BrowserTestUtils.removeTab(newTab);

  // Test Bookmarks Toolbar stayopen clicks: middle-click.
  promiseEvent = BrowserTestUtils.waitForEvent(buttonMenupopup, "popupshown");
  EventUtils.synthesizeMouseAtCenter(toolbarbutton, {});
  await promiseEvent;
  ok(true, "Bookmarks toolbar folder's popup is open.");
  promiseTabOpened = BrowserTestUtils.waitForNewTab(gBrowser, null);
  EventUtils.synthesizeMouseAtCenter(menuitem, { button: 1 });
  newTab = await promiseTabOpened;
  ok(
    true,
    "Bookmark in folder on Bookmarks Toolbar middle-click opened new tab."
  );
  ok(
    toolbarbutton.open,
    "Popup of folder on bookmark's toolbar should still be open."
  );
  promiseEvent = BrowserTestUtils.waitForEvent(buttonMenupopup, "popuphidden");
  toolbarbutton.open = false;
  await promiseEvent;
  BrowserTestUtils.removeTab(newTab);

  // Test Bookmarks Toolbar stayopen clicks: 'Open in new tab' on context menu.
  promiseEvent = BrowserTestUtils.waitForEvent(buttonMenupopup, "popupshown");
  EventUtils.synthesizeMouseAtCenter(toolbarbutton, {});
  await promiseEvent;
  ok(true, "Bookmarks toolbar folder's popup is open.");
  newTab = await testContextmenu(menuitem);
  ok(true, "Bookmark on Bookmarks Toolbar contextmenu opened new tab.");
  ok(
    toolbarbutton.open,
    "Popup of folder on bookmark's toolbar should still be open."
  );
  promiseEvent = BrowserTestUtils.waitForEvent(buttonMenupopup, "popuphidden");
  toolbarbutton.open = false;
  await promiseEvent;
  BrowserTestUtils.removeTab(newTab);
});

async function openBookmarksMenu() {
  let BM = document.getElementById("bookmarksMenu");
  let BMpopup = document.getElementById("bookmarksMenuPopup");
  let shown = BrowserTestUtils.waitForEvent(BMpopup, "popupshown");
  EventUtils.synthesizeMouseAtCenter(BM, {});
  await shown;
  return [BM, BMpopup];
}

async function closeMenu(menu, popup) {
  let hidden = BrowserTestUtils.waitForEvent(popup, "popuphidden");
  menu.open = false;
  await hidden;
}

// Ctrl-Enter should leave the menu open, just like ctrl-click.
add_task(async function testStayopenKeyboardActivation() {
  if (NATIVE_MENUBAR) {
    return;
  }

  let [BM, BMpopup] = await openBookmarksMenu();

  let selected = null;
  for (let i = 0; i < 20; i++) {
    EventUtils.synthesizeKey("KEY_ArrowDown");
    selected = BMpopup.querySelector('menuitem[_moz-menuactive="true"]');
    if (selected?.label == "Test1") {
      break;
    }
  }
  Assert.equal(
    selected?.label,
    "Test1",
    "Selected the test bookmark with the keyboard."
  );

  let promiseTabOpened = BrowserTestUtils.waitForNewTab(gBrowser, null);
  EventUtils.synthesizeKey("KEY_Enter", { accelKey: true });
  let newTab = await promiseTabOpened;
  ok(true, "Bookmark ctrl-Enter opened new tab.");
  BrowserTestUtils.removeTab(newTab);
  ok(BM.open, "Bookmarks Menu should still be open after ctrl-Enter.");

  await closeMenu(BM, BMpopup);
});

// Opening a whole folder in tabs should also leave the menu open. This is the
// behaviour added by bug 1420749; folders are <menu> elements which never fire
// a command event, so they rely on BookmarksEventHandler.onClick rather than
// on the closemenu attribute.
add_task(async function testStayopenFolderInMenu() {
  if (NATIVE_MENUBAR) {
    return;
  }

  let [BM, BMpopup] = await openBookmarksMenu();

  let folderMenu = [...BMpopup.children].find(
    node => node.label == "TEST_MENU_FOLDER"
  );
  ok(folderMenu, "Found the test folder in the Bookmarks Menu.");

  let tabPromises = [
    BrowserTestUtils.waitForNewTab(gBrowser, "https://example.com/infolder1"),
    BrowserTestUtils.waitForNewTab(gBrowser, "https://example.com/infolder2"),
  ];
  EventUtils.synthesizeMouseAtCenter(folderMenu, { button: 1 });
  let tabs = await Promise.all(tabPromises);
  ok(true, "Folder middle-click opened all its bookmarks in tabs.");
  ok(BM.open, "Bookmarks Menu should still be open after opening a folder.");

  for (let tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
  await closeMenu(BM, BMpopup);
});

// The History menu should behave like the Bookmarks menu.
add_task(async function testStayopenHistoryMenu() {
  if (NATIVE_MENUBAR) {
    return;
  }

  let historyMenu = document.getElementById("history-menu");
  let historyPopup = document.getElementById("historyMenuPopup");
  let shown = BrowserTestUtils.waitForEvent(historyPopup, "popupshown");
  EventUtils.synthesizeMouseAtCenter(historyMenu, {});
  await shown;

  let historyItem = [...historyPopup.children].find(
    node => node.label == "History1"
  );
  ok(historyItem, "Found the history entry.");

  let promiseTabOpened = BrowserTestUtils.waitForNewTab(gBrowser, null);
  historyPopup.activateItem(historyItem, ACCEL);
  let newTab = await promiseTabOpened;
  ok(true, "History entry ctrl-click opened new tab.");
  BrowserTestUtils.removeTab(newTab);
  ok(historyMenu.open, "History Menu should still be open after ctrl-click.");

  promiseTabOpened = BrowserTestUtils.waitForNewTab(gBrowser, null);
  historyPopup.activateItem(historyItem, { button: 1 });
  newTab = await promiseTabOpened;
  ok(true, "History entry middle-click opened new tab.");
  BrowserTestUtils.removeTab(newTab);
  ok(historyMenu.open, "History Menu should still be open after middle-click.");

  await closeMenu(historyMenu, historyPopup);
});

// The App Menu's History subview should behave like its Bookmarks subview.
add_task(async function testStayopenAppMenuHistory() {
  let appMenu = document.getElementById("PanelUI-menu-button");
  let appMenuPopup = document.getElementById("appMenu-popup");
  let shown = BrowserTestUtils.waitForEvent(appMenuPopup, "popupshown");
  appMenu.click();
  await shown;

  let historyView = document.getElementById("PanelUI-history");
  let viewShown = BrowserTestUtils.waitForEvent(historyView, "ViewShown");
  document.getElementById("appMenu-history-button").click();
  await viewShown;
  info("History panel shown.");

  let historyButton = [
    ...document.getElementById("appMenu_historyMenu").children,
  ].find(node => node.label == "History1");
  ok(historyButton, "Found the history entry in the App Menu.");

  let promiseTabOpened = BrowserTestUtils.waitForNewTab(gBrowser, null);
  EventUtils.synthesizeMouseAtCenter(historyButton, { accelKey: true });
  let newTab = await promiseTabOpened;
  ok(true, "History entry ctrl-click opened new tab.");
  BrowserTestUtils.removeTab(newTab);
  ok(
    PanelView.forNode(historyView).active,
    "Should still show the history subview"
  );
  ok(appMenu.open, "Menu should remain open.");

  promiseTabOpened = BrowserTestUtils.waitForNewTab(gBrowser, null);
  EventUtils.synthesizeMouseAtCenter(historyButton, { button: 1 });
  newTab = await promiseTabOpened;
  ok(true, "History entry middle-click opened new tab.");
  BrowserTestUtils.removeTab(newTab);
  ok(appMenu.open, "Menu should remain open.");

  appMenuPopup.hidePopup();
  ok(!appMenu.open, "The menu should now be closed.");
});
