/**
 * Blackboard Bulk Downloader - Content Script
 * Runs in the context of Blackboard web pages.
 * Supports both Blackboard Original (Classic) and Blackboard Ultra.
 */

(() => {
  // Prevent duplicate injection
  if (window.__BLACKBOARD_DOWNLOADER_INJECTED__) return;
  window.__BLACKBOARD_DOWNLOADER_INJECTED__ = true;

  const browserAPI = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

  // Recognized downloadable file extensions
  const DOWNLOADABLE_EXTENSIONS = new Set([
    'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx',
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2',
    'txt', 'rtf', 'csv', 'tsv',
    'mp4', 'm4v', 'avi', 'mov', 'wmv', 'mkv', 'webm',
    'mp3', 'wav', 'm4a', 'flac', 'ogg',
    'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp',
    'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'js', 'ts', 'html', 'css', 'sql', 'ipynb',
    'r', 'mat', 'm', 'tex', 'epub', 'mobi'
  ]);

  /**
   * Helper: Clean filename by removing invalid filesystem characters
   */
  function sanitizeFilename(name) {
    if (!name) return 'unnamed_file';
    let clean = name.trim()
      .replace(/[\/\\:*?"<>|]/g, '_')
      .replace(/[\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ');
    if (clean.length > 120) {
      const extMatch = clean.match(/(\.[a-zA-Z0-9]{1,6})$/);
      const ext = extMatch ? extMatch[1] : '';
      clean = clean.substring(0, 120 - ext.length) + ext;
    }
    return clean;
  }

  /**
   * Helper: Clean folder path
   */
  function sanitizeFolderPath(path) {
    if (!path) return '';
    return path
      .split('/')
      .map(part => sanitizeFilename(part.trim()))
      .filter(part => part.length > 0 && part !== '.' && part !== '..')
      .join('/');
  }

  /**
   * Helper: Extract file extension from URL or filename
   */
  function getExtension(filenameOrUrl) {
    if (!filenameOrUrl) return '';
    try {
      const urlWithoutQuery = filenameOrUrl.split('?')[0].split('#')[0];
      const match = urlWithoutQuery.match(/\.([a-zA-Z0-9]{1,8})$/);
      return match ? match[1].toLowerCase() : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * Detect Blackboard interface mode and course metadata
   */
  function detectCourse() {
    const url = window.location.href;
    const origin = window.location.origin;

    // 1. Blackboard Ultra Detection
    // Ultra URLs typically: /ultra/courses/_12345_1/cl/outline or /ultra/courses/_12345_1/...
    const ultraMatch = url.match(/\/ultra\/courses\/(_[0-9]+_[0-9]+)/i) ||
                       url.match(/\/ultra\/courses\/([^\/\?#]+)/i);

    if (ultraMatch) {
      const courseId = ultraMatch[1];
      let courseTitle = '';
      const titleElem = document.querySelector('[data-testid="course-title"], .course-title, header h1, #course-outline-title');
      if (titleElem && titleElem.textContent.trim()) {
        courseTitle = titleElem.textContent.trim();
      } else {
        courseTitle = document.title.replace(/Blackboard.*$/i, '').trim() || `Course_${courseId}`;
      }

      return {
        isBlackboard: true,
        mode: 'ultra',
        courseId,
        courseTitle: sanitizeFilename(courseTitle),
        origin
      };
    }

    // 2. Blackboard Original Detection
    // Original URLs typically: /webapps/blackboard/execute/...course_id=_12345_1 or /webapps/...
    const originalMatch = url.match(/course_id=(_[0-9]+_[0-9]+)/i) ||
                          url.match(/course_id=([^\&\?#]+)/i);

    const isOriginalPath = url.includes('/webapps/blackboard/') ||
                          url.includes('/webapps/portal/') ||
                          document.querySelector('#courseMenuPalette, #content_listContainer, #breadcrumbs');

    if (originalMatch || isOriginalPath) {
      const courseId = originalMatch ? originalMatch[1] : '';
      let courseTitle = '';
      const courseTitleElem = document.querySelector('#courseMenu_link, #crumb_1, #pageTitleText, .courseName');
      if (courseTitleElem && courseTitleElem.textContent.trim()) {
        courseTitle = courseTitleElem.textContent.trim();
      } else {
        courseTitle = document.title.replace(/Blackboard.*$/i, '').trim() || (courseId ? `Course_${courseId}` : 'Blackboard_Course');
      }

      return {
        isBlackboard: true,
        mode: 'original',
        courseId,
        courseTitle: sanitizeFilename(courseTitle),
        origin
      };
    }

    // 3. Fallback: Generic Blackboard check
    if (document.querySelector('meta[name="blackboard"]') ||
        url.includes('/webapps/') ||
        document.body.className.includes('bb-') ||
        document.getElementById('navigationPane')) {
      return {
        isBlackboard: true,
        mode: 'original',
        courseId: '',
        courseTitle: sanitizeFilename(document.title || 'Blackboard_Course'),
        origin
      };
    }

    return {
      isBlackboard: false,
      mode: 'unknown',
      courseId: '',
      courseTitle: '',
      origin
    };
  }

  // =========================================================================
  // Mode A: Blackboard Original (Classic) Deep Scanner
  // =========================================================================

  class OriginalCourseScanner {
    constructor(courseInfo, options = {}) {
      this.courseInfo = courseInfo;
      this.options = {
        maxDepth: options.maxDepth || 5,
        allowedExtensions: options.allowedExtensions || null,
        skipVideos: options.skipVideos || false,
        onProgress: options.onProgress || (() => {})
      };
      this.visitedUrls = new Set();
      this.discoveredFiles = new Map(); // url -> fileObject
    }

    async scan() {
      this.options.onProgress({ step: 'scanning', message: 'Scanning course navigation...' });

      // Step 1: Find all main content areas from the left menu
      const navLinks = this.getNavigationLinks();
      this.visitedUrls.add(window.location.href);

      // Also scan current document directly
      await this.scanDocument(document, '', window.location.href, 0);

      // Step 2: Traverse each main menu section
      for (let i = 0; i < navLinks.length; i++) {
        const nav = navLinks[i];
        if (this.visitedUrls.has(nav.url)) continue;
        this.visitedUrls.add(nav.url);

        this.options.onProgress({
          step: 'scanning',
          message: `Scanning section (${i + 1}/${navLinks.length}): ${nav.title}`,
          foundCount: this.discoveredFiles.size
        });

        try {
          const doc = await this.fetchAndParseHtml(nav.url);
          if (doc) {
            await this.scanDocument(doc, nav.title, nav.url, 1);
          }
        } catch (e) {
          console.warn('[BB-Downloader] Failed to fetch nav section:', nav.url, e);
        }
      }

      return Array.from(this.discoveredFiles.values());
    }

    getNavigationLinks() {
      const links = [];
      const menuElements = document.querySelectorAll('#courseMenuPalette_contents li a, #navigationPane li a, .courseMenu a');

      menuElements.forEach(a => {
        const href = a.getAttribute('href');
        const text = a.textContent.trim();
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

        // Skip non-content areas like grades, announcements, tools, email
        const lowerText = text.toLowerCase();
        if (lowerText.includes('announcement') ||
            lowerText.includes('discussion') ||
            lowerText.includes('grade') ||
            lowerText.includes('tool') ||
            lowerText.includes('email') ||
            lowerText.includes('roster') ||
            lowerText.includes('calendar') ||
            lowerText.includes('help')) {
          return;
        }

        try {
          const absoluteUrl = new URL(href, window.location.origin).href;
          // Must stay within course
          if (this.courseInfo.courseId && !absoluteUrl.includes(this.courseInfo.courseId)) {
            // Check if it's still blackboard content
            if (!absoluteUrl.includes('/webapps/blackboard/content/')) return;
          }
          links.push({ title: sanitizeFilename(text), url: absoluteUrl });
        } catch (e) {}
      });

      return links;
    }

    async scanDocument(doc, currentFolder, currentUrl, depth) {
      if (depth > this.options.maxDepth) return;

      // 1. Scrape all files directly in this document
      this.extractFilesFromDoc(doc, currentFolder, currentUrl);

      // 2. Discover subfolders within this document
      const subfolders = this.extractSubfolders(doc, currentFolder, currentUrl);

      for (const folder of subfolders) {
        if (this.visitedUrls.has(folder.url)) continue;
        this.visitedUrls.add(folder.url);

        this.options.onProgress({
          step: 'scanning',
          message: `Scanning folder: ${folder.folderPath}`,
          foundCount: this.discoveredFiles.size
        });

        try {
          const subDoc = await this.fetchAndParseHtml(folder.url);
          if (subDoc) {
            await this.scanDocument(subDoc, folder.folderPath, folder.url, depth + 1);
          }
        } catch (e) {
          console.warn('[BB-Downloader] Failed to fetch folder:', folder.url, e);
        }
      }
    }

    extractFilesFromDoc(doc, currentFolder, pageUrl) {
      const allLinks = doc.querySelectorAll('a[href]');

      allLinks.forEach(a => {
        const rawHref = a.getAttribute('href');
        if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) return;

        let absoluteUrl;
        try {
          absoluteUrl = new URL(rawHref, pageUrl).href;
        } catch (e) {
          return;
        }

        const fileInfo = this.checkIfFileLink(a, absoluteUrl, doc);
        if (fileInfo) {
          if (!this.discoveredFiles.has(fileInfo.url)) {
            fileInfo.folderPath = currentFolder;
            this.discoveredFiles.set(fileInfo.url, fileInfo);
          }
        }
      });
    }

    checkIfFileLink(anchor, url, doc) {
      const lowerUrl = url.toLowerCase();
      const text = anchor.textContent.trim();

      // Pattern 1: Blackboard Content Collection (/bbcswebdav/...)
      const isWebDAV = lowerUrl.includes('/bbcswebdav/');

      // Pattern 2: Blackboard file execution (/webapps/blackboard/execute/content/file)
      const isBbFile = lowerUrl.includes('/webapps/blackboard/execute/content/file') ||
                       lowerUrl.includes('/webapps/blackboard/execute/download');

      // Pattern 3: Extension in URL
      const extFromUrl = getExtension(url);
      const isKnownExtension = DOWNLOADABLE_EXTENSIONS.has(extFromUrl);

      // Pattern 4: Extension in anchor text or title
      const extFromText = getExtension(text);
      const isTextFile = DOWNLOADABLE_EXTENSIONS.has(extFromText);

      // Pattern 5: Direct attachment icon or parent container check
      const parentItem = anchor.closest('.item, li.clearfix, .contentListElement, tr');
      const isAttachmentLink = anchor.closest('.attachments, .contextMenuContainer') !== null ||
                               (anchor.getAttribute('target') === '_blank' && (isWebDAV || isBbFile));

      if (!isWebDAV && !isBbFile && !isKnownExtension && !isTextFile && !isAttachmentLink) {
        return null;
      }

      // Filter out navigation links that happen to contain keywords
      if (lowerUrl.includes('listcontent.jsp') ||
          lowerUrl.includes('launchassessment.jsp') ||
          lowerUrl.includes('courseview') ||
          lowerUrl.includes('courselist') ||
          lowerUrl.includes('javascript:') ||
          lowerUrl.includes('logout')) {
        return null;
      }

      // Determine the best filename
      let filename = '';
      if (isTextFile) {
        filename = text;
      } else if (anchor.getAttribute('title') && getExtension(anchor.getAttribute('title'))) {
        filename = anchor.getAttribute('title');
      } else if (anchor.getAttribute('download')) {
        filename = anchor.getAttribute('download');
      } else if (extFromUrl) {
        try {
          const parsed = new URL(url);
          const parts = parsed.pathname.split('/');
          const last = decodeURIComponent(parts[parts.length - 1]);
          if (getExtension(last)) {
            filename = last;
          }
        } catch (e) {}
      }

      if (!filename) {
        if (text && text.length > 2 && text.length < 100) {
          filename = text;
        } else if (parentItem) {
          const header = parentItem.querySelector('h3, .item h3, .contentListElement h3');
          if (header && header.textContent.trim()) {
            filename = header.textContent.trim();
          }
        }
      }

      if (!filename) {
        filename = `blackboard_file_${Math.random().toString(36).substring(2, 8)}`;
      }

      filename = sanitizeFilename(filename);

      // Ensure extension exists
      let ext = getExtension(filename) || extFromUrl || 'bin';
      if (!filename.toLowerCase().endsWith('.' + ext)) {
        filename = `${filename}.${ext}`;
      }

      if (this.options.skipVideos && ['mp4', 'm4v', 'avi', 'mov', 'wmv', 'mkv', 'webm'].includes(ext)) {
        return null;
      }

      if (this.options.allowedExtensions && !this.options.allowedExtensions.has(ext)) {
        return null;
      }

      return {
        url,
        filename,
        extension: ext,
        title: text || filename
      };
    }

    extractSubfolders(doc, currentFolder, pageUrl) {
      const folders = [];
      const links = doc.querySelectorAll('a[href]');

      links.forEach(a => {
        const href = a.getAttribute('href');
        if (!href) return;

        const lowerHref = href.toLowerCase();
        if (lowerHref.includes('listcontent.jsp') || lowerHref.includes('content_id=')) {
          const isFolder = a.closest('.item')?.querySelector('img[src*="folder"], img[alt*="Folder"], img[alt*="folder"]') ||
                          a.querySelector('img[src*="folder"]') ||
                          a.classList.contains('folder') ||
                          lowerHref.includes('listcontent.jsp');

          if (isFolder) {
            try {
              const absoluteUrl = new URL(href, pageUrl).href;
              const folderTitle = sanitizeFilename(a.textContent.trim() || 'Folder');
              const folderPath = currentFolder ? `${currentFolder}/${folderTitle}` : folderTitle;

              folders.push({
                title: folderTitle,
                folderPath: sanitizeFolderPath(folderPath),
                url: absoluteUrl
              });
            } catch (e) {}
          }
        }
      });

      return folders;
    }

    async fetchAndParseHtml(url) {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) return null;
      const html = await response.text();
      const parser = new DOMParser();
      return parser.parseFromString(html, 'text/html');
    }
  }

  // =========================================================================
  // Mode B: Blackboard Ultra REST API & DOM Scanner
  // =========================================================================

  class UltraCourseScanner {
    constructor(courseInfo, options = {}) {
      this.courseInfo = courseInfo;
      this.options = {
        allowedExtensions: options.allowedExtensions || null,
        skipVideos: options.skipVideos || false,
        onProgress: options.onProgress || (() => {})
      };
      this.discoveredFiles = new Map();
    }

    async scan() {
      this.options.onProgress({ step: 'scanning', message: 'Connecting to Blackboard Ultra API...' });

      const courseId = this.courseInfo.courseId;
      const origin = this.courseInfo.origin;

      try {
        const apiFiles = await this.scanViaRestApi(origin, courseId);
        if (apiFiles && apiFiles.length > 0) {
          return apiFiles;
        }
      } catch (e) {
        console.warn('[BB-Downloader] REST API scan failed or restricted:', e);
      }

      this.options.onProgress({ step: 'scanning', message: 'Scanning Ultra page elements...' });
      return this.scanViaDom();
    }

    async scanViaRestApi(origin, courseId) {
      const rootUrl = `${origin}/learn/api/public/v1/courses/${courseId}/contents`;
      await this.traverseApiContents(rootUrl, '', courseId, origin, 0);
      return Array.from(this.discoveredFiles.values());
    }

    async traverseApiContents(url, currentFolder, courseId, origin, depth) {
      if (depth > 6) return;

      this.options.onProgress({
        step: 'scanning',
        message: currentFolder ? `Scanning API: ${currentFolder}` : 'Scanning course contents...',
        foundCount: this.discoveredFiles.size
      });

      let nextUrl = url;
      while (nextUrl) {
        const response = await fetch(nextUrl, {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) break;

        const data = await response.json();
        const items = data.results || [];

        for (const item of items) {
          const title = item.title || 'Untitled';
          const contentHandler = item.contentHandler?.id || '';

          // 1. Folder / Learning Module
          if (contentHandler === 'resource/x-bb-folder' ||
              contentHandler === 'resource/x-bb-lesson' ||
              item.hasChildren) {
            const subFolder = currentFolder ? `${currentFolder}/${sanitizeFilename(title)}` : sanitizeFilename(title);
            const childrenUrl = `${origin}/learn/api/public/v1/courses/${courseId}/contents/${item.id}/children`;
            await this.traverseApiContents(childrenUrl, subFolder, courseId, origin, depth + 1);
          }

          // 2. Direct File Resource
          else if (contentHandler === 'resource/x-bb-file') {
            const downloadUrl = `${origin}/learn/api/public/v1/courses/${courseId}/contents/${item.id}/attachments`;
            await this.fetchItemAttachments(downloadUrl, currentFolder, title, origin);
          }

          // 3. Document or Assignment with attachments
          else if (contentHandler === 'resource/x-bb-document' ||
                   contentHandler === 'resource/x-bb-assignment') {
            const attachUrl = `${origin}/learn/api/public/v1/courses/${courseId}/contents/${item.id}/attachments`;
            await this.fetchItemAttachments(attachUrl, currentFolder, title, origin);
          }

          // 4. Content with links / attachments directly on the object
          if (item.links) {
            for (const link of item.links) {
              if (link.rel === 'attachment' || link.rel === 'download') {
                this.addFile({
                  url: link.href.startsWith('http') ? link.href : `${origin}${link.href}`,
                  filename: sanitizeFilename(link.title || title),
                  folderPath: currentFolder
                });
              }
            }
          }
        }

        // Handle pagination
        if (data.paging && data.paging.nextPage) {
          nextUrl = data.paging.nextPage.startsWith('http')
            ? data.paging.nextPage
            : `${origin}${data.paging.nextPage}`;
        } else {
          nextUrl = null;
        }
      }
    }

    async fetchItemAttachments(attachmentsUrl, folderPath, itemTitle, origin) {
      try {
        const resp = await fetch(attachmentsUrl, {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });
        if (!resp.ok) return;

        const data = await resp.json();
        const attachments = data.results || (Array.isArray(data) ? data : []);

        for (const att of attachments) {
          const fileName = att.fileName || att.name || `${itemTitle}.pdf`;
          let downloadUrl = '';

          if (att.links) {
            const dlLink = att.links.find(l => l.rel === 'download' || l.rel === 'self');
            if (dlLink) downloadUrl = dlLink.href;
          }

          if (!downloadUrl && att.id) {
            downloadUrl = `${attachmentsUrl}/${att.id}/download`;
          }

          if (downloadUrl) {
            const fullUrl = downloadUrl.startsWith('http') ? downloadUrl : `${origin}${downloadUrl}`;
            this.addFile({
              url: fullUrl,
              filename: sanitizeFilename(fileName),
              folderPath
            });
          }
        }
      } catch (e) {
        console.warn('[BB-Downloader] Error fetching attachments:', e);
      }
    }

    addFile({ url, filename, folderPath }) {
      const ext = getExtension(filename) || getExtension(url) || 'bin';
      if (!filename.toLowerCase().endsWith('.' + ext)) {
        filename = `${filename}.${ext}`;
      }

      if (this.options.skipVideos && ['mp4', 'm4v', 'avi', 'mov', 'wmv', 'mkv', 'webm'].includes(ext)) {
        return;
      }

      if (this.options.allowedExtensions && !this.options.allowedExtensions.has(ext)) {
        return;
      }

      if (!this.discoveredFiles.has(url)) {
        this.discoveredFiles.set(url, {
          url,
          filename: sanitizeFilename(filename),
          extension: ext,
          folderPath: sanitizeFolderPath(folderPath),
          title: filename
        });
      }
    }

    scanViaDom() {
      const links = document.querySelectorAll('a[href], button[data-analytics-id*="download"]');
      links.forEach(el => {
        let href = el.getAttribute('href');
        if (!href) return;

        try {
          const absoluteUrl = new URL(href, window.location.origin).href;
          const text = el.textContent.trim();
          const ext = getExtension(absoluteUrl) || getExtension(text);

          if (DOWNLOADABLE_EXTENSIONS.has(ext) || absoluteUrl.includes('/bbcswebdav/')) {
            const filename = sanitizeFilename(text || `file.${ext}`);
            this.addFile({
              url: absoluteUrl,
              filename,
              folderPath: ''
            });
          }
        } catch (e) {}
      });

      return Array.from(this.discoveredFiles.values());
    }
  }

  // =========================================================================
  // Message Listener for Extension Commands
  // =========================================================================

  browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'DETECT_COURSE') {
      const info = detectCourse();
      sendResponse(info);
      return true;
    }

    if (message.action === 'SCAN_COURSE_FILES') {
      (async () => {
        try {
          const courseInfo = detectCourse();
          const options = message.options || {};

          let allowedExtensions = null;
          if (options.fileTypes && Array.isArray(options.fileTypes) && options.fileTypes.length > 0) {
            allowedExtensions = new Set(options.fileTypes.map(t => t.toLowerCase().trim()));
          }

          const scannerOptions = {
            maxDepth: options.maxDepth || 5,
            allowedExtensions,
            skipVideos: options.skipVideos || false,
            onProgress: (p) => {
              browserAPI.runtime.sendMessage({
                action: 'SCAN_PROGRESS',
                data: p
              }).catch(() => {});
            }
          };

          let files = [];
          if (courseInfo.mode === 'ultra') {
            const scanner = new UltraCourseScanner(courseInfo, scannerOptions);
            files = await scanner.scan();
          } else {
            const scanner = new OriginalCourseScanner(courseInfo, scannerOptions);
            files = await scanner.scan();
          }

          sendResponse({
            success: true,
            courseInfo,
            files,
            totalFiles: files.length
          });
        } catch (err) {
          console.error('[BB-Downloader] Scanning error:', err);
          sendResponse({
            success: false,
            error: err.message || 'Unknown scanning error'
          });
        }
      })();
      return true;
    }
  });

  console.log('[Blackboard Bulk Downloader] Content script ready.');
})();

