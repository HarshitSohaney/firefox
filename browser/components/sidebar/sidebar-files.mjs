/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

import { html } from "chrome://global/content/vendor/lit.all.mjs";

import { SidebarPage } from "./sidebar-page.mjs";

ChromeUtils.defineESModuleGetters(lazy, {
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
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.downloadsData?.removeView(this);
  }

  // DownloadsData view callbacks. Download objects are mutated in place, so we
  // reassign the array to make Lit re-render.
  onDownloadAdded(download) {
    this.downloads = [download, ...this.downloads];
  }

  onDownloadChanged(download) {
    if (this.downloads.includes(download)) {
      this.downloads = [...this.downloads];
    }
  }

  onDownloadRemoved(download) {
    this.downloads = this.downloads.filter(d => d !== download);
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
        status: lazy.DownloadsViewUI.getSizeWithUnits(download),
      };
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
      <img class="files-icon" src=${item.icon} alt="" />
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
        </div>
      </div>
    `;
  }
}

customElements.define("sidebar-files", SidebarFiles);
