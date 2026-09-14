# Blackboard Bulk Downloader

A Manifest V3 browser extension for **Firefox, Brave, and Chrome** that allows students and instructors to download all course materials, lecture notes, slides, assignments, and files from any Blackboard course with a single click.

---

## Features

- **One-Click Download**: Automatically discovers all files in the current course and downloads them.
- **Dual-Engine Support**:
  - **Blackboard Ultra**: Directly accesses Blackboard's REST API endpoints (`/learn/api/public/v1/courses/...`) with fallback to DOM parsing.
  - **Blackboard Original (Classic)**: Crawls course navigation links, content sections, and nested subfolders recursively, detecting `/bbcswebdav/`, attachments, and document links.
- **Organized ZIP Archive**: Preserves the exact folder hierarchy from Blackboard inside the ZIP file. Duplicate filenames within the same folder are automatically resolved (`slides (1).pdf`).
- **Download Summary Report**: Every ZIP file includes a `_DOWNLOAD_REPORT.txt` documenting total discovered files, successfully downloaded items, and any inaccessible items.
- **Live Progress Tracking**: See the real-time file being downloaded, percentage complete, and file count.
- **Cancelable**: You can cancel an ongoing download at any time.
- **Background Persistence**: Downloads run in the background event script—closing the popup does not interrupt your download.
- **Customizable Settings**:
  - Choose between single ZIP archive (recommended) or individual files.
  - Option to skip video files (`.mp4`, `.mov`, etc.) to save bandwidth.
  - Adjustable subfolder recursion depth (1, 3, 5, or 10 levels).
- **Zero Credentials Required**: Uses your active browser session cookies (`credentials: 'include'`). No username, password, or OAuth tokens needed.

---

## How to Install and Test

### Firefox

1. Open **Firefox**.
2. In the address bar, type `about:debugging#/runtime/this-firefox` and press **Enter**.
3. Click **"Load Temporary Add-on..."**.
4. In the file picker, navigate to this project folder:
   ```
   d:\projects\extension\blackboard\manifest.json
   ```
   Select `manifest.json` and click **Open**.
5. The extension **"Blackboard Bulk Downloader"** will appear under **Temporary Extensions**.
6. Pin the extension icon to your toolbar:
   - Click the puzzle piece icon (Extensions) in Firefox's toolbar.
   - Click the gear icon next to **Blackboard Bulk Downloader** and select **Pin to Toolbar**.

### Brave / Chrome

1. Open **Brave** or **Chrome** and go to `brave://extensions` (or `chrome://extensions`).
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **"Load unpacked"**.
4. Select this project folder:
   ```
   d:\projects\extension\blackboard
   ```
5. The extension **"Blackboard Bulk Downloader"** will appear in your extensions list.
6. Pin it to the toolbar via the puzzle-piece icon.

Note: unpacked/developer-mode extensions are removed when the browser restarts unless you re-load them, and Chrome/Brave will periodically nag about disabling unpacked extensions — this is normal for local development. To install permanently, package and submit to the Chrome Web Store / Firefox Add-ons.

---

## How to Use

1. Navigate to your university's Blackboard website and log in.
2. Open any course page (e.g., Course Content or Outline).
3. Click the **Blackboard Bulk Downloader** icon in the toolbar.
4. The popup will automatically detect your course title and whether you are on Blackboard Original or Ultra.
5. Click **"Download All Files"**.
6. The extension will scan the course, download the files, build the ZIP file, and prompt you to save it!

---

## Project Structure

```
blackboard/
├── manifest.json              # Manifest V3 configuration (Firefox event page + Chrome/Brave service worker)
├── background/
│   └── background.js          # Background script: orchestrates scanning, downloads & ZIP creation
├── content/
│   └── content.js             # Content script: discovers files in Original & Ultra
├── popup/
│   ├── popup.html             # Extension popup user interface
│   ├── popup.css              # Modern dark theme styles
│   └── popup.js               # Popup controller & state synchronization
├── lib/
│   ├── jszip.min.js           # JSZip v3.10.1 - ZIP archive creation
│   └── bytesbase64.js         # Bytes <-> base64 helper for the offscreen document bridge
├── offscreen/
│   ├── offscreen.html         # Chrome/Brave only: hidden page used to create blob download URLs
│   └── offscreen.js           # (a service worker can't reliably do this itself)
├── icons/
│   ├── icon-16.png            # 16x16 icon
│   ├── icon-48.png            # 48x48 icon
│   └── icon-128.png           # 128x128 icon
└── README.md
```

On Chrome/Brave, the background script runs as an MV3 service worker, whose `URL.createObjectURL` isn't reliably usable by the downloads API. Creating the final ZIP's downloadable blob URL is therefore delegated to a hidden `offscreen` document (via the `offscreen` permission) on those browsers. Firefox's background script is a real page already, so it does this directly with no extra indirection.

---

## Supported File Types

The scanner automatically identifies all standard course document types, including:
- **Documents**: PDF, DOC, DOCX, TXT, RTF, CSV, TSV
- **Presentations**: PPT, PPTX, KEY
- **Spreadsheets**: XLS, XLSX
- **Archives**: ZIP, RAR, 7Z, TAR, GZ
- **Source Code**: PY, JAVA, C, CPP, H, CS, JS, TS, HTML, CSS, SQL, IPYNB, R, MAT
- **Media**: MP3, WAV, M4A, FLAC, MP4, MOV, AVI, WMV (can be filtered)
- **Images**: PNG, JPG, JPEG, GIF, SVG, WEBP

---

## Security & Privacy

- All file requests are made directly between your browser and your university's Blackboard server using your existing session cookies.
- No files, URLs, or user data are ever transmitted to any third-party servers.
- Works entirely offline within your local browser environment.

