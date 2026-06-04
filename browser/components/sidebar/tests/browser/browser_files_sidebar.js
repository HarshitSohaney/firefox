/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { FileTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/FileTestUtils.sys.mjs"
);

const QR_URL_REGEX = /^https:\/\/fileflow\.harshitsohaney\.com\/[0-9a-f-]{36}$/;

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.files.sidebar.enabled", true]],
  });
});

async function showFilesPanel() {
  await SidebarController.show("viewFilesSidebar");
  const { contentDocument } = SidebarController.browser;
  const component = contentDocument.querySelector("sidebar-files");
  Assert.ok(component, "Files panel is shown.");
  return component;
}

function getRows(component) {
  return component.shadowRoot.querySelectorAll(".files-row");
}

async function waitForRowCount(component, expected) {
  await BrowserTestUtils.waitForMutationCondition(
    component.shadowRoot,
    { childList: true, subtree: true },
    () => getRows(component).length === expected
  );
}

// Creates a download whose target file exists on disk, adds it to the public
// list, and registers cleanup.
async function addFinishedDownload() {
  const list = await Downloads.getList(Downloads.PUBLIC);
  const targetFile = FileTestUtils.getTempFile("sidebar-files-test.txt");
  await IOUtils.writeUTF8(targetFile.path, "test download contents");

  const download = await Downloads.createDownload({
    source: "https://example.com/sidebar-files-test.txt",
    target: { path: targetFile.path },
    succeeded: true,
  });
  await list.add(download);
  await download.refresh();

  registerCleanupFunction(async () => {
    await list.remove(download);
    await download.finalize(true);
    await IOUtils.remove(targetFile.path, { ignoreAbsent: true });
  });

  return { download, targetFile };
}

add_task(async function test_files_lists_downloads() {
  const { targetFile } = await addFinishedDownload();

  const component = await showFilesPanel();
  await waitForRowCount(component, 1);

  const nameEl = component.shadowRoot.querySelector(".files-name");
  Assert.ok(nameEl, "A download row rendered.");
  Assert.equal(
    nameEl.textContent,
    targetFile.leafName,
    "Row shows the download's filename."
  );

  SidebarController.hide();
});

add_task(async function test_primary_action_opens_download() {
  const { download } = await addFinishedDownload();

  const openStub = sinon.stub(DownloadsCommon, "openDownload").resolves();
  registerCleanupFunction(() => openStub.restore());

  const component = await showFilesPanel();
  await waitForRowCount(component, 1);

  const content = SidebarController.browser.contentWindow;
  EventUtils.synthesizeMouseAtCenter(
    component.shadowRoot.querySelector(".files-name"),
    {},
    content
  );

  Assert.ok(openStub.calledOnce, "openDownload was called.");
  Assert.equal(
    openStub.firstCall.args[0],
    download,
    "openDownload was called with the download."
  );

  SidebarController.hide();
});

add_task(async function test_secondary_action_reveals_file() {
  const { targetFile } = await addFinishedDownload();

  const revealStub = sinon.stub(DownloadsCommon, "showDownloadedFile");
  registerCleanupFunction(() => revealStub.restore());

  const component = await showFilesPanel();
  await waitForRowCount(component, 1);

  const content = SidebarController.browser.contentWindow;
  EventUtils.synthesizeMouseAtCenter(
    component.shadowRoot.querySelector(".files-show-in-folder"),
    {},
    content
  );

  Assert.ok(revealStub.calledOnce, "showDownloadedFile was called.");
  Assert.equal(
    revealStub.firstCall.args[0].path,
    targetFile.path,
    "showDownloadedFile was called with the download's file."
  );

  SidebarController.hide();
});

add_task(async function test_row_drag_provides_file_and_url() {
  const { download, targetFile } = await addFinishedDownload();

  const component = await showFilesPanel();
  await waitForRowCount(component, 1);

  const content = SidebarController.browser.contentWindow;
  const row = component.shadowRoot.querySelector(".files-row");
  const dataTransfer = new content.DataTransfer();
  const event = new content.DragEvent("dragstart", { dataTransfer });
  row.dispatchEvent(event);

  const draggedFile = dataTransfer.mozGetDataAt("application/x-moz-file", 0);
  Assert.ok(
    draggedFile instanceof Ci.nsIFile,
    "Drag data contains an nsIFile."
  );
  Assert.equal(
    draggedFile.path,
    targetFile.path,
    "Dragged file matches the download's target."
  );
  Assert.equal(
    dataTransfer.getData("text/uri-list"),
    Services.io.newFileURI(targetFile).spec,
    "Drag data contains the file URI."
  );
  // Web page drop targets read these: they get the original download URL.
  Assert.equal(
    dataTransfer.getData("text/plain"),
    download.source.url,
    "Drag data exposes the source URL as plain text."
  );
  Assert.equal(
    dataTransfer.getData("text/x-moz-url"),
    `${download.source.url}\n${targetFile.leafName}`,
    "Drag data exposes the source URL and title for link drop targets."
  );

  SidebarController.hide();
});

add_task(async function test_list_updates_on_add_and_remove() {
  const component = await showFilesPanel();
  await waitForRowCount(component, 0);

  const empty = component.shadowRoot.querySelector(".files-empty");
  Assert.ok(empty, "Empty state is shown when there are no downloads.");

  const list = await Downloads.getList(Downloads.PUBLIC);
  const targetFile = FileTestUtils.getTempFile("sidebar-files-update.txt");
  await IOUtils.writeUTF8(targetFile.path, "contents");
  const download = await Downloads.createDownload({
    source: "https://example.com/sidebar-files-update.txt",
    target: { path: targetFile.path },
    succeeded: true,
  });

  await list.add(download);
  await waitForRowCount(component, 1);
  Assert.equal(getRows(component).length, 1, "Adding a download adds a row.");

  await list.remove(download);
  await waitForRowCount(component, 0);
  Assert.equal(
    getRows(component).length,
    0,
    "Removing a download removes its row."
  );

  await download.finalize(true);
  await IOUtils.remove(targetFile.path, { ignoreAbsent: true });
  SidebarController.hide();
});

add_task(async function test_files_qr_code_present() {
  const component = await showFilesPanel();
  await component.updateComplete;

  const img = component.qrCodeImage;
  Assert.ok(img, "QR code image is present in the Files panel.");
  Assert.ok(
    img.src.startsWith("data:image/gif"),
    `QR code src is a GIF data URI (got: ${img.src.slice(0, 24)}...).`
  );
  Assert.ok(
    QR_URL_REGEX.test(component.qrUrl),
    `QR URL has the expected shape (got: ${component.qrUrl}).`
  );

  SidebarController.hide();
});
