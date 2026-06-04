/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

import { html } from "chrome://global/content/vendor/lit.all.mjs";

import { SidebarPage } from "./sidebar-page.mjs";

const { QR } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/qrcode/encoder.mjs"
);

const FILEFLOW_BASE = "https://fileflow.harshitsohaney.com";
const FILEFLOW_POLL_INTERVAL_MS = 1500;

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
  };

  static queries = {
    qrCodeImage: ".sidebar-qr-code",
  };

  #fileflowTimer = null;

  // Maps a download's target path to a generated thumbnail data URL (or null
  // while one is being generated) for image downloads.
  #thumbnails = new Map();

  #qrId = crypto.randomUUID();
  #qrDataURI = QR.encodeToDataURI(this.qrUrl, "M").src;

  get qrUrl() {
    return `${FILEFLOW_BASE}/${this.#qrId}`;
  }

  constructor() {
    super();
    this.downloads = [];
  }

  connectedCallback() {
    super.connectedCallback();
    // getData() keys privacy off the chrome window, so a private window only
    // ever sees its own session's downloads.
    this.downloadsData = lazy.DownloadsCommon.getData(this.topWindow);
    lazy.DownloadsCommon.initializeAllDataLinks();
    this.downloadsData.addView(this);
    this.#startFileFlowPolling();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.downloadsData?.removeView(this);
    this.#stopFileFlowPolling();
  }

  // Poll the FileFlow server for a photo uploaded from the paired phone. Once
  // the file is ready, save it to disk as a regular download so it shows up in
  // the list and can be dragged out like any other downloaded item.
  #startFileFlowPolling() {
    if (this.#fileflowTimer) {
      return;
    }
    const poll = async () => {
      this.#fileflowTimer = null;
      try {
        const statusResp = await fetch(`${FILEFLOW_BASE}/status/${this.#qrId}`);
        if (statusResp.ok) {
          const { ready } = await statusResp.json();
          if (ready) {
            const fileResp = await fetch(`${FILEFLOW_BASE}/file/${this.#qrId}`);
            if (fileResp.ok) {
              await this.#saveAsDownload(await fileResp.blob());
              // Rotate to a fresh QR code so the next scan/upload is a new,
              // distinct transfer. Polling continues against the new id below.
              this.#refreshQrCode();
            }
          }
        }
      } catch (e) {
        // The phone hasn't uploaded yet, or the network blipped. Keep polling.
      }
      this.#fileflowTimer = setTimeout(poll, FILEFLOW_POLL_INTERVAL_MS);
    };
    this.#fileflowTimer = setTimeout(poll, FILEFLOW_POLL_INTERVAL_MS);
  }

  #stopFileFlowPolling() {
    if (this.#fileflowTimer) {
      clearTimeout(this.#fileflowTimer);
      this.#fileflowTimer = null;
    }
  }

  // Generate a new QR id and code, and re-render so the displayed QR updates.
  #refreshQrCode() {
    this.#qrId = crypto.randomUUID();
    this.#qrDataURI = QR.encodeToDataURI(this.qrUrl, "M").src;
    this.requestUpdate();
  }

  // Write the received blob into the downloads directory and register it as a
  // succeeded download. The panel already observes the public downloads list,
  // so the new item renders as a (draggable) row automatically.
  async #saveAsDownload(blob) {
    const downloadsDir = await lazy.Downloads.getPreferredDownloadsDirectory();
    const fileName = `fileflow-photo-${this.#qrId}${this.#extensionForType(
      blob.type
    )}`;
    const targetPath = PathUtils.join(downloadsDir, fileName);
    await IOUtils.write(targetPath, new Uint8Array(await blob.arrayBuffer()));

    const download = await lazy.Downloads.createDownload({
      source: { url: `${FILEFLOW_BASE}/file/${this.#qrId}` },
      target: { path: targetPath },
      contentType: blob.type,
      succeeded: true,
    });
    const list = await lazy.Downloads.getList(lazy.Downloads.PUBLIC);
    await list.add(download);
    await download.refresh();
  }

  #extensionForType(type) {
    try {
      const mimeService = Cc["@mozilla.org/mime;1"].getService(
        Ci.nsIMIMEService
      );
      const primary = mimeService.getFromTypeAndExtension(
        type,
        ""
      ).primaryExtension;
      if (primary) {
        return `.${primary}`;
      }
    } catch (e) {
      // Unknown content type; fall back to no extension.
    }
    return "";
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
      <div class="sidebar-panel">
        <sidebar-panel-header
          data-l10n-id="sidebar-menu-files-header"
          data-l10n-attrs="heading"
          view="viewFilesSidebar"
        ></sidebar-panel-header>
        <div class="sidebar-panel-scrollable-content">
          ${this.downloads.length
            ? html`<ul class="files-list">
                ${this.fileItems.map(item => this.#rowTemplate(item))}
              </ul>`
            : html`<fxview-empty-state
                headerLabel="sidebar-files-empty-heading"
                .descriptionLabels=${["sidebar-files-empty-description"]}
                class="empty-state files"
                isSelectedTab
              ></fxview-empty-state>`}
          <div class="qr-code-group">
            <h4
              class="files-qr-code-heading"
              data-l10n-id="sidebar-files-qr-code-heading"
            ></h4>
            <img
              class="sidebar-qr-code"
              src=${this.#qrDataURI}
              data-l10n-id="sidebar-files-qr-code"
            />
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define("sidebar-files", SidebarFiles);
