/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const QR_URL_REGEX = /^https:\/\/fileflow\.harshitsohaney\.com\/[0-9a-f-]{36}$/;

async function showCustomizePanel(win) {
  await win.SidebarController.show("viewCustomizeSidebar");
  // `.show()` can return before the pane has fired its `load` event if we were
  // already trying to load that same pane in the same browser (see
  // browser_customize_sidebar.js / bug 1954987).
  if (win.SidebarController.browser.contentDocument.readyState != "complete") {
    await BrowserTestUtils.waitForEvent(
      win.SidebarController.browser,
      "load",
      true
    );
  }
  const doc = win.SidebarController.browser.contentDocument;
  const component = doc.querySelector("sidebar-customize");
  await component.updateComplete;
  await BrowserTestUtils.waitForMutationCondition(
    component.shadowRoot,
    { subtree: true, childList: true },
    () => component.qrCodeImage
  );
  return component;
}

add_task(async function test_sidebar_qr_code_present() {
  const component = await showCustomizePanel(window);

  const img = component.qrCodeImage;
  ok(img, "QR code image is present in the customize panel.");
  ok(
    img.src.startsWith("data:image/gif"),
    `QR code src is a GIF data URI (got: ${img.src.slice(0, 24)}...).`
  );

  ok(
    QR_URL_REGEX.test(component.qrUrl),
    `QR URL has the expected shape (got: ${component.qrUrl}).`
  );

  SidebarController.hide();
});

add_task(async function test_sidebar_qr_code_changes_on_reopen() {
  const firstComponent = await showCustomizePanel(window);
  const firstUrl = firstComponent.qrUrl;

  // Switch to another panel so the customize document is reloaded (and a new
  // <sidebar-customize> instance constructed) when we reopen it.
  await SidebarTestUtils.showPanel(window, "viewHistorySidebar");

  const secondComponent = await showCustomizePanel(window);
  const secondUrl = secondComponent.qrUrl;

  Assert.notEqual(
    firstUrl,
    secondUrl,
    "A fresh ID is generated each time the customize panel is opened."
  );

  SidebarController.hide();
});
