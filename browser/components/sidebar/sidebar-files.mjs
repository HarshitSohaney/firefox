/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

import { html, when } from "chrome://global/content/vendor/lit.all.mjs";

import { SidebarPage } from "./sidebar-page.mjs";

const { QR } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/qrcode/encoder.mjs"
);

const FILEFLOW_BASE = "https://fileflow.harshitsohaney.com";

const MEDIA_FOLDERS_PREF = "sidebar.fileflow.mediaFolders";
const MEDIA_FILES_PREF = "sidebar.fileflow.mediaFiles";
const MEDIA_SCAN_CAP = 60;
const MEDIA_THUMB_SIZE = 84;

ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  DownloadsCommon:
    "moz-src:///browser/components/downloads/DownloadsCommon.sys.mjs",
  DownloadsViewUI:
    "moz-src:///browser/components/downloads/DownloadsViewUI.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
});

/**
 * The Files sidebar panel. Lists the user's downloaded files, sourced
 * reactively from DownloadsCommon. Each row opens the file on click, reveals
 * it in the OS file manager via a secondary button, and can be dragged out to
 * the desktop, another app, or a web page.
 */
export class SidebarFiles extends SidebarPage {
  static properties = {
    downloads: { type: Array },
    mediaItems: { type: Array },
    qrDataURI: { type: String },
  };

  static queries = {
    qrCodeImage: ".sidebar-qr-code",
  };

  // Maps a download's target path to a generated thumbnail data URL (or null
  // while one is being generated) for image downloads.
  #thumbnails = new Map();

  #qrId = crypto.randomUUID();

  get qrUrl() {
    return `${FILEFLOW_BASE}/${this.#qrId}`;
  }

  constructor() {
    super();
    this.downloads = [];
    this.mediaItems = [];
    this.qrDataURI = QR.encodeToDataURI(this.qrUrl, "M").src;
    this.#boundOnSession = this.#onFileFlowSession.bind(this);
    this.#boundOnFileReceived = this.#onFileFlowFileReceived.bind(this);
  }

  #boundOnSession = null;
  #boundOnFileReceived = null;
  #pollTimer = null;
  #parentOwnsSession = false;

  connectedCallback() {
    super.connectedCallback();
    // getData() keys privacy off the chrome window, so a private window only
    // ever sees its own session's downloads.
    this.downloadsData = lazy.DownloadsCommon.getData(this.topWindow);
    lazy.DownloadsCommon.initializeAllDataLinks();
    this.downloadsData.addView(this);
    this.#loadRememberedMedia();
    this.#qrId = crypto.randomUUID();
    this.qrDataURI = QR.encodeToDataURI(this.qrUrl, "M").src;
    const win = this.topWindow;
    win.addEventListener("FileFlow:SessionStarted", this.#boundOnSession);
    win.addEventListener("FileFlow:FileReceived", this.#boundOnFileReceived);
    this.#parentOwnsSession = false;
    this.#startPolling();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#stopPolling();
    this.downloadsData?.removeView(this);
    const win = this.topWindow;
    win.removeEventListener("FileFlow:SessionStarted", this.#boundOnSession);
    win.removeEventListener("FileFlow:FileReceived", this.#boundOnFileReceived);
  }

  #startPolling() {
    if (this.#pollTimer) {
      return;
    }
    const poll = async () => {
      this.#pollTimer = null;
      if (this.#parentOwnsSession) {
        return;
      }
      try {
        const resp = await fetch(`${FILEFLOW_BASE}/status/${this.#qrId}`);
        if (resp.ok) {
          const { ready } = await resp.json();
          if (ready) {
            const fileResp = await fetch(`${FILEFLOW_BASE}/file/${this.#qrId}`);
            if (fileResp.ok) {
              const blob = await fileResp.blob();
              const bytes = new Uint8Array(await blob.arrayBuffer());
              const contentType = blob.type || "image/jpeg";
              const filename = `fileflow-${Date.now()}.${contentType.split("/")[1] || "jpg"}`;
              await this.#saveAsDownload(bytes, contentType, filename);
              this.#qrId = crypto.randomUUID();
              this.qrDataURI = QR.encodeToDataURI(this.qrUrl, "M").src;
              this.#pollTimer = setTimeout(poll, 2000);
              return;
            }
          }
        }
      } catch (e) {
        // Network blip or phone hasn't uploaded yet.
      }
      this.#pollTimer = setTimeout(poll, 2000);
    };
    this.#pollTimer = setTimeout(poll, 2000);
  }

  #stopPolling() {
    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  #onFileFlowSession(event) {
    const { qrId } = event.detail;
    this.#parentOwnsSession = true;
    this.#stopPolling();
    this.#qrId = qrId;
    this.qrDataURI = QR.encodeToDataURI(this.qrUrl, "M").src;
  }

  async #onFileFlowFileReceived(event) {
    const { bytes, contentType, filename } = event.detail;
    await this.#saveAsDownload(bytes, contentType, filename);
    this.#parentOwnsSession = false;
    this.#qrId = crypto.randomUUID();
    this.qrDataURI = QR.encodeToDataURI(this.qrUrl, "M").src;
    this.#startPolling();
  }

  async #saveAsDownload(bytes, contentType, filename) {
    const downloadsDir = await lazy.Downloads.getPreferredDownloadsDirectory();
    const targetPath = PathUtils.join(downloadsDir, filename);
    await IOUtils.write(targetPath, new Uint8Array(bytes));

    const download = await lazy.Downloads.createDownload({
      source: { url: `${FILEFLOW_BASE}/file/${this.#qrId}` },
      target: { path: targetPath },
      contentType,
      succeeded: true,
    });
    const list = await lazy.Downloads.getList(lazy.Downloads.PUBLIC);
    await list.add(download);
    await download.refresh();
  }

  // DownloadsData view callbacks. Download objects are mutated in place, so we
  // reassign the array to make Lit re-render.
  onDownloadAdded(download) {
    this.downloads = [download, ...this.downloads];
    this.#ensureThumbnail(download);
  }

  onDownloadChanged(download) {
    if (this.downloads.includes(download)) {
      this.downloads = [...this.downloads];
    }
    this.#ensureThumbnail(download);
  }

  onDownloadRemoved(download) {
    this.downloads = this.downloads.filter(d => d !== download);
    if (download.target?.path) {
      this.#thumbnails.delete(download.target.path);
    }
  }

  get fileItems() {
    return this.downloads.map(download => {
      const displayName = lazy.DownloadsViewUI.getDisplayName(download);
      return {
        download,
        // getDisplayName() returns an { l10n } object for blocked downloads.
        name:
          typeof displayName === "string"
            ? displayName
            : (displayName?.l10n?.args?.url ?? ""),
        icon: download.target.path
          ? `moz-icon://${download.target.path}?size=16`
          : "moz-icon://.unknown?size=16",
        thumbnail: this.#thumbnails.get(download.target?.path) ?? null,
        status: lazy.DownloadsViewUI.getSizeWithUnits(download),
      };
    });
  }

  // For a succeeded image download, generate a downscaled thumbnail (longest
  // side capped at 100px, aspect ratio preserved) and cache it as a data URL
  // keyed by path.
  async #ensureThumbnail(download) {
    const path = download.target?.path;
    if (!download.succeeded || !path || this.#thumbnails.has(path)) {
      return;
    }
    if (!this.#isImageDownload(download)) {
      return;
    }
    // Reserve the slot so concurrent change events don't read the file twice.
    this.#thumbnails.set(path, null);
    try {
      const bytes = await IOUtils.read(path);
      const type = download.contentType || "image/png";
      const bitmap = await createImageBitmap(new Blob([bytes], { type }));
      try {
        this.#thumbnails.set(path, await this.#downscaleToDataURL(bitmap));
      } finally {
        bitmap.close();
      }
      this.requestUpdate();
    } catch (e) {
      // Couldn't decode (e.g. corrupt or unsupported); fall back to the icon
      // and allow a later attempt.
      this.#thumbnails.delete(path);
    }
  }

  #isImageDownload(download) {
    if (download.contentType?.startsWith("image/")) {
      return true;
    }
    const match = download.target?.path?.match(/\.([^.]+)$/);
    const ext = match?.[1].toLowerCase();
    return ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "ico"].includes(
      ext
    );
  }

  async #downscaleToDataURL(bitmap) {
    const maxDimension = 100;
    const largestSide = Math.max(bitmap.width, bitmap.height);
    const scale = largestSide > maxDimension ? maxDimension / largestSide : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
    return this.#blobToDataURL(
      await canvas.convertToBlob({ type: "image/png" })
    );
  }

  #blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async onPrimaryAction(download) {
    await lazy.DownloadsCommon.openDownload(download);
  }

  onSecondaryAction(download) {
    if (!download.target.path) {
      return;
    }
    lazy.DownloadsCommon.showDownloadedFile(
      new lazy.FileUtils.File(download.target.path)
    );
  }

  onDragStart(event, download) {
    if (!download.target.path) {
      return;
    }
    // The existence check must be synchronous: a dragstart handler cannot wait
    // on async I/O.
    const file = new lazy.FileUtils.File(download.target.path);
    if (!file.exists()) {
      return;
    }
    const dataTransfer = event.dataTransfer;
    // The privileged file flavor lets the OS, and web upload drop zones,
    // treat this as a file drag.
    dataTransfer.mozSetDataAt("application/x-moz-file", file, 0);
    dataTransfer.setData("text/uri-list", lazy.NetUtil.newURI(file).spec);
    // Expose the original download URL for web page link/text drop targets:
    // the local file:// path above is not useful to web content.
    const sourceUrl = download.source?.url;
    if (sourceUrl) {
      const displayName = lazy.DownloadsViewUI.getDisplayName(download);
      const title = typeof displayName === "string" ? displayName : sourceUrl;
      dataTransfer.setData("text/x-moz-url", `${sourceUrl}\n${title}`);
      dataTransfer.setData("text/plain", sourceUrl);
    }
    dataTransfer.effectAllowed = "copyMove";
    dataTransfer.addElement(event.currentTarget);
    event.stopPropagation();
  }

  // Local media brought in from the desktop, either via the file picker or by
  // dropping files onto the panel. Each item is shown as a thumbnail and can
  // be dragged back out to a web page or the OS.
  async onAddMedia() {
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(
      this.topWindow.browsingContext,
      "Add media",
      Ci.nsIFilePicker.modeOpenMultiple
    );
    fp.appendFilters(Ci.nsIFilePicker.filterImages);
    const result = await new Promise(resolve => fp.open(resolve));
    if (result != Ci.nsIFilePicker.returnOK) {
      return;
    }
    const paths = [];
    for (const file of fp.files) {
      paths.push(file.QueryInterface(Ci.nsIFile).path);
    }
    this.#rememberFiles(paths);
    await this.#addMediaPaths(paths);
  }

  // Let the user choose a folder; remember it and load its images. Chrome code
  // has full filesystem access, so the only prompt is macOS's own (TCC) when a
  // protected location is first read.
  async onAddFolder() {
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(
      this.topWindow.browsingContext,
      "Choose a media folder",
      Ci.nsIFilePicker.modeGetFolder
    );
    const result = await new Promise(resolve => fp.open(resolve));
    if (result != Ci.nsIFilePicker.returnOK) {
      return;
    }
    const folder = fp.file.QueryInterface(Ci.nsIFile).path;
    const folders = this.#getFolders();
    if (!folders.includes(folder)) {
      this.#saveFolders([...folders, folder]);
    }
    await this.#addMediaPaths(await this.#scanFolder(folder));
  }

  onClearMedia() {
    this.mediaItems = [];
    this.#saveFiles([]);
    this.#saveFolders([]);
  }

  async #loadRememberedMedia() {
    await this.#addMediaPaths(this.#getFiles());
    for (const folder of this.#getFolders()) {
      try {
        await this.#addMediaPaths(await this.#scanFolder(folder));
      } catch (e) {
        console.error("[FileFlow] could not load folder", folder, e);
      }
    }
  }

  #getFolders() {
    try {
      return JSON.parse(Services.prefs.getStringPref(MEDIA_FOLDERS_PREF, "[]"));
    } catch (e) {
      return [];
    }
  }

  #saveFolders(folders) {
    Services.prefs.setStringPref(MEDIA_FOLDERS_PREF, JSON.stringify(folders));
  }

  #rememberFiles(paths) {
    this.#saveFiles([...new Set([...this.#getFiles(), ...paths])]);
  }

  #getFiles() {
    try {
      return JSON.parse(Services.prefs.getStringPref(MEDIA_FILES_PREF, "[]"));
    } catch (e) {
      return [];
    }
  }

  #saveFiles(files) {
    Services.prefs.setStringPref(MEDIA_FILES_PREF, JSON.stringify(files));
  }

  // Breadth-first scan for image files, capped so a huge tree can't stall the
  // panel or exhaust memory.
  async #scanFolder(folder) {
    const found = [];
    const queue = [folder];
    while (queue.length && found.length < MEDIA_SCAN_CAP) {
      let children;
      try {
        children = await IOUtils.getChildren(queue.shift());
      } catch (e) {
        continue;
      }
      for (const child of children) {
        if (found.length >= MEDIA_SCAN_CAP) {
          break;
        }
        const info = await IOUtils.stat(child);
        if (info.type === "directory") {
          queue.push(child);
        } else if (this.#imageMimeForPath(child)) {
          found.push(child);
        }
      }
    }
    return found;
  }

  onPanelDragOver(event) {
    if (event.dataTransfer.types.includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }

  async onPanelDrop(event) {
    const paths = [];
    for (const file of event.dataTransfer.files) {
      if (file.mozFullPath) {
        paths.push(file.mozFullPath);
      }
    }
    if (!paths.length) {
      return;
    }
    event.preventDefault();
    this.#rememberFiles(paths);
    await this.#addMediaPaths(paths);
  }

  async #addMediaPaths(paths) {
    const existing = new Set(this.mediaItems.map(item => item.path));
    const added = [];
    for (const path of paths) {
      if (existing.has(path)) {
        continue;
      }
      existing.add(path);
      try {
        added.push({
          path,
          name: PathUtils.filename(path),
          thumb: await this.#makeThumb(path),
        });
      } catch (e) {
        console.error("[FileFlow] could not add media", path, e);
      }
    }
    if (added.length) {
      this.mediaItems = [...added, ...this.mediaItems];
    }
  }

  async #makeThumb(path) {
    const type = this.#imageMimeForPath(path);
    if (!type) {
      return null;
    }
    const bytes = await IOUtils.read(path);
    const blob = new Blob([bytes], { type });
    try {
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(
        MEDIA_THUMB_SIZE / bitmap.width,
        MEDIA_THUMB_SIZE / bitmap.height,
        1
      );
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      return this.#blobToDataURL(
        await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 })
      );
    } catch (e) {
      return this.#blobToDataURL(blob);
    }
  }

  #imageMimeForPath(path) {
    const ext = path.split(".").pop().toLowerCase();
    return (
      {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
        bmp: "image/bmp",
        svg: "image/svg+xml",
      }[ext] ?? null
    );
  }

  onMediaDragStart(event, item) {
    const file = new lazy.FileUtils.File(item.path);
    if (!file.exists()) {
      return;
    }
    const dataTransfer = event.dataTransfer;
    dataTransfer.mozSetDataAt("application/x-moz-file", file, 0);
    dataTransfer.setData("text/uri-list", lazy.NetUtil.newURI(file).spec);
    dataTransfer.effectAllowed = "copyMove";
    dataTransfer.addElement(event.currentTarget);
    event.stopPropagation();
  }

  #mediaTemplate(item) {
    return html`<div
      class="media-tile"
      draggable="true"
      title=${item.name}
      @dragstart=${e => this.onMediaDragStart(e, item)}
    >
      <img
        class="media-thumb"
        src=${item.thumb ?? `moz-icon://${item.path}?size=32`}
        alt=${item.name}
      />
      <span class="media-name">${item.name}</span>
    </div>`;
  }

  #rowTemplate(item) {
    return html`<li
      class="files-row"
      draggable="true"
      @dragstart=${e => this.onDragStart(e, item.download)}
    >
      ${item.thumbnail
        ? html`<img
            class="files-thumbnail"
            src=${item.thumbnail}
            alt=""
            draggable="false"
          />`
        : html`<img class="files-icon" src=${item.icon} alt="" />`}
      <a
        class="files-name"
        href="#"
        @click=${e => {
          e.preventDefault();
          this.onPrimaryAction(item.download);
        }}
        >${item.name}</a
      >
      <span class="files-status">${item.status}</span>
      <moz-button
        class="files-show-in-folder"
        type="icon ghost"
        iconSrc="chrome://global/skin/icons/folder.svg"
        data-l10n-id="sidebar-files-show-in-folder"
        @click=${() => this.onSecondaryAction(item.download)}
      ></moz-button>
    </li>`;
  }

  render() {
    return html`
      ${this.stylesheet()}
      <link
        rel="stylesheet"
        href="chrome://browser/content/sidebar/sidebar-files.css"
      />
      <div
        class="sidebar-panel"
        @dragover=${e => this.onPanelDragOver(e)}
        @drop=${e => this.onPanelDrop(e)}
      >
        <sidebar-panel-header
          data-l10n-id="sidebar-menu-files-header"
          data-l10n-attrs="heading"
          view="viewFilesSidebar"
        ></sidebar-panel-header>
        <div class="sidebar-panel-scrollable-content">
          <div class="media-group">
            <div class="media-actions">
              <moz-button
                class="media-add"
                type="ghost"
                iconSrc="chrome://global/skin/icons/plus.svg"
                data-l10n-id="sidebar-files-add-media"
                @click=${() => this.onAddMedia()}
              ></moz-button>
              <moz-button
                class="media-add"
                type="ghost"
                iconSrc="chrome://global/skin/icons/folder.svg"
                data-l10n-id="sidebar-files-add-folder"
                @click=${() => this.onAddFolder()}
              ></moz-button>
              ${when(
                this.mediaItems.length,
                () =>
                  html`<moz-button
                    class="media-clear"
                    type="ghost"
                    iconSrc="chrome://global/skin/icons/delete.svg"
                    data-l10n-id="sidebar-files-clear-media"
                    @click=${() => this.onClearMedia()}
                  ></moz-button>`
              )}
            </div>
            ${this.mediaItems.length
              ? html`<div class="media-grid">
                  ${this.mediaItems.map(item => this.#mediaTemplate(item))}
                </div>`
              : html`<p
                  class="media-hint"
                  data-l10n-id="sidebar-files-media-hint"
                ></p>`}
          </div>
          ${this.downloads.length
            ? html`<ul class="files-list">
                ${this.fileItems.map(item => this.#rowTemplate(item))}
              </ul>`
            : html`<div class="files-empty">
                <h4 data-l10n-id="sidebar-files-empty-heading"></h4>
                <p data-l10n-id="sidebar-files-empty-description"></p>
              </div>`}
          <div class="qr-code-group">
            <h4
              class="files-qr-code-heading"
              data-l10n-id="sidebar-files-qr-code-heading"
            ></h4>
            <div class="qr-stack">
              <img
                class="qr-kit"
                src="chrome://browser/content/sidebar/firefox-mascot.png"
                role="presentation"
              />
              <img
                class="sidebar-qr-code"
                src=${this.qrDataURI}
                data-l10n-id="sidebar-files-qr-code"
              />
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define("sidebar-files", SidebarFiles);
