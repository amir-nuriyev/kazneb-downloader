(() => {
  "use strict";

  const TEXT_ENCODER = new TextEncoder();
  const DEFAULT_PAGE_CONCURRENCY = 64;
  const SLOW_PAGE_CONCURRENCY = 8;
  const REQUEST_START_SPACING_MS = 0;
  const TEXT_FETCH_TIMEOUT_MS = 30_000;
  const DEFAULT_PAGE_FETCH_TIMEOUT_MS = 60_000;
  const SLOW_PAGE_FETCH_TIMEOUT_MS = 180_000;
  const PAGE_RETRIES = 4;
  const MISSING_PAGE_PASSES = 2;
  const RETRY_BASE_MS = 800;
  const RETRY_MAX_MS = 12_000;
  const RATE_LIMIT_COOLDOWN_MS = 5_000;
  const PREFETCH_CACHE_TTL_MS = 5 * 60_000;
  const PREFETCH_APPROACH_PAGE_LIMIT = 20;
  const PREFETCH_APPROACH_PROXIMITY_PX = 560;
  const PREFETCH_APPROACH_MIN_PROGRESS_PX = 18;
  const PREFETCH_CLOSE_PROXIMITY_PX = 180;

  if (window.__kaznebDownloaderLoaded) {
    return;
  }
  window.__kaznebDownloaderLoaded = true;

  function absoluteUrl(url, base = window.location.href) {
    return new URL(decodeHtml(url), base).href;
  }

  function decodeHtml(value) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = value;
    return textarea.value;
  }

  function sanitizeFileName(value) {
    return String(value || "kazneb")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "kazneb";
  }

  function getKaznebLanguage() {
    const pathLanguage = /^\/(en|ru|kk|la)(?:\/|$)/i.exec(window.location.pathname);
    if (pathLanguage) {
      return pathLanguage[1].toLowerCase();
    }

    const activeLanguage = document.querySelector(".language-link.is-active");
    const activeHreflang = activeLanguage && activeLanguage.getAttribute("hreflang");
    if (/^(en|ru|kk|la)$/i.test(activeHreflang || "")) {
      return activeHreflang.toLowerCase();
    }

    const htmlLanguage = (document.documentElement.lang || "").split("-")[0].toLowerCase();
    if (/^(en|ru|kk|la)$/.test(htmlLanguage)) {
      return htmlLanguage;
    }

    return "en";
  }

  function getDownloadLabel() {
    const labels = {
      en: "Download",
      ru: "Скачать",
      kk: "Жүктеу",
      la: "Jukteu"
    };
    return labels[getKaznebLanguage()] || labels.en;
  }

  function getCancelLabel() {
    const labels = {
      en: "Cancel",
      ru: "Отмена",
      kk: "Болдырмау",
      la: "Bas tartu"
    };
    return labels[getKaznebLanguage()] || labels.en;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) {
      return "unknown size";
    }
    if (bytes < 1024 * 1024) {
      return `${Math.round(bytes / 1024)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function getConnectionInfo() {
    return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  }

  function getNetworkProfile() {
    const connection = getConnectionInfo();
    const effectiveType = String(connection?.effectiveType || "").toLowerCase();
    const downlink = Number(connection?.downlink);
    const rtt = Number(connection?.rtt);
    const saveData = Boolean(connection?.saveData);
    const slow =
      saveData ||
      /^(slow-)?2g$|^3g$/.test(effectiveType) ||
      (Number.isFinite(downlink) && downlink > 0 && downlink <= 1.5) ||
      (Number.isFinite(rtt) && rtt >= 500);

    return {
      downlink: Number.isFinite(downlink) ? downlink : null,
      effectiveType: effectiveType || null,
      pageConcurrency: slow ? SLOW_PAGE_CONCURRENCY : DEFAULT_PAGE_CONCURRENCY,
      pageFetchTimeoutMs: slow ? SLOW_PAGE_FETCH_TIMEOUT_MS : DEFAULT_PAGE_FETCH_TIMEOUT_MS,
      rtt: Number.isFinite(rtt) ? rtt : null,
      saveData,
      slow
    };
  }

  function serializeError(error) {
    if (!error) {
      return null;
    }
    return {
      name: error.name || "Error",
      message: error.message || String(error),
      stack: error.stack || null,
      retryable: Boolean(error.retryable),
      status: error.response ? error.response.status : null
    };
  }

  function createDebugCollector() {
    const entries = [];
    const startedAt = new Date().toISOString();

    return {
      log(event, data = {}) {
        entries.push({
          t: new Date().toISOString(),
          event,
          ...data
        });
        if (entries.length > 500) {
          entries.shift();
        }
      },
      report(extra = {}) {
        return JSON.stringify(
          {
            extensionVersion: chrome.runtime.getManifest().version,
            startedAt,
            pageUrl: window.location.href,
            language: getKaznebLanguage(),
            userAgent: navigator.userAgent,
            ...extra,
            entries
          },
          null,
          2
        );
      }
    };
  }

  function getDownloadIconUrl() {
    return new URL(
      "/themes/custom/kazneb/layout/html/assets/img/svg/download.svg",
      window.location.origin
    ).href;
  }

  function inferBookId(sourceUrl, pageUrls = []) {
    const candidates = [sourceUrl, ...pageUrls.slice(0, 1)];
    for (const value of candidates) {
      const patterns = [
        /[?&]brId=(\d+)/i,
        /\/catalogue\/view\/(\d+)/i,
        /\/FileStore\/dataFiles\/[^/]+\/[^/]+\/(\d+)\//i
      ];
      for (const pattern of patterns) {
        const match = pattern.exec(value);
        if (match) {
          return match[1];
        }
      }
    }
    return sanitizeFileName(document.title.split("|")[0] || "kazneb");
  }

  function cleanTitle(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function inferBookTitle(fallback) {
    const titleElement = document.querySelector(
      ".book-info__desktop .book-info__name, .book-info__mobile .book-info__name, .book-info__name"
    );
    const titleFromPage = cleanTitle(titleElement ? titleElement.textContent : "");
    if (titleFromPage) {
      return sanitizeFileName(titleFromPage);
    }

    const ogTitle = document.querySelector('meta[property="og:title"], meta[name="title"]');
    const titleFromMeta = cleanTitle(ogTitle ? ogTitle.getAttribute("content") : "");
    if (titleFromMeta) {
      return sanitizeFileName(titleFromMeta.split("|")[0]);
    }

    const titleFromDocument = cleanTitle(document.title.split("|")[0]);
    if (titleFromDocument) {
      return sanitizeFileName(titleFromDocument);
    }

    return sanitizeFileName(fallback || "kazneb");
  }

  function ensureSimpleViewer(url) {
    const parsed = new URL(url, window.location.href);
    if (!parsed.searchParams.has("simple")) {
      parsed.searchParams.set("simple", "true");
    }
    return parsed.href;
  }

  function extractPageUrls(html, baseUrl) {
    const urls = [];
    const pagePushPattern = /pages\.push\(\s*(['"])(.*?)\1\s*\)/gis;
    for (const match of html.matchAll(pagePushPattern)) {
      urls.push(match[2]);
    }

    if (!urls.length) {
      const fileStorePattern =
        /['"]([^'"]*\/FileStore\/[^'"]+\/content\/\d{4}\.(?:png|jpe?g|webp)(?:\?[^'"]*)?)['"]/gi;
      for (const match of html.matchAll(fileStorePattern)) {
        urls.push(match[1]);
      }
    }

    const seen = new Set();
    const normalized = [];
    for (const url of urls) {
      const absolute = absoluteUrl(url, baseUrl);
      if (!seen.has(absolute)) {
        seen.add(absolute);
        normalized.push(absolute);
      }
    }
    return normalized;
  }

  function hasDownloadSourceInHtml(html) {
    return (
      hasGeneratedPdfSourceInHtml(html) ||
      /full\.pdf/i.test(html)
    );
  }

  function hasGeneratedPdfSourceInHtml(html) {
    return (
      /pages\.push\(/i.test(html) ||
      /\/bookview\/view/i.test(html) ||
      /\/FileStore\/[^'"]+\/content\/\d{4}\.(?:png|jpe?g|webp)(?:\?[^'"]*)?/i.test(html)
    );
  }

  function extractViewerUrlFromHtml(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const links = [...doc.querySelectorAll("a[href]")].map((link) => link.getAttribute("href"));
    const candidate = links.find((href) => /\/bookview\/view/i.test(href || ""));
    return candidate ? ensureSimpleViewer(absoluteUrl(candidate, baseUrl)) : null;
  }

  function extractViewerUrlFromDom() {
    const link = document.querySelector('a[href*="/bookView/view"], a[href*="/bookview/view"]');
    return link ? ensureSimpleViewer(link.href) : null;
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) {
      throw new DOMException("Download cancelled.", "AbortError");
    }
  }

  function abortableDelay(ms, signal) {
    return new Promise((resolve, reject) => {
      throwIfAborted(signal);
      let timer = null;
      const cleanup = () => {
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
      };
      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        reject(new DOMException("Download cancelled.", "AbortError"));
      };
      timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  function createRequestPacer(signal, debug) {
    let gate = Promise.resolve();
    let nextStartAt = 0;
    let cooldownUntil = 0;

    return {
      waitTurn(context = {}) {
        if (REQUEST_START_SPACING_MS <= 0 && Date.now() >= cooldownUntil) {
          return Promise.resolve();
        }

        const run = gate.then(async () => {
          throwIfAborted(signal);
          const now = Date.now();
          const startAt = Math.max(now, nextStartAt, cooldownUntil);
          const waitMs = startAt - now;
          if (waitMs > 0) {
            if (waitMs >= 250) {
              debug?.log("request-pacer-wait", {
                ...context,
                waitMs
              });
            }
            await abortableDelay(waitMs, signal);
          }
          nextStartAt = Date.now() + REQUEST_START_SPACING_MS;
        });
        gate = run.catch(() => {});
        return run;
      },
      coolDown(ms, context = {}) {
        const until = Date.now() + Math.max(0, ms);
        if (until <= cooldownUntil) {
          return;
        }

        cooldownUntil = until;
        debug?.log("request-pacer-cooldown", {
          ...context,
          waitMs: Math.round(cooldownUntil - Date.now())
        });
      }
    };
  }

  async function fetchWithTimeout(url, options, timeoutMs, parentSignal) {
    throwIfAborted(parentSignal);
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(parentSignal.reason);
    const timer = setTimeout(() => controller.abort(new Error("Request timed out.")), timeoutMs);

    if (parentSignal) {
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal
      });
    } catch (error) {
      if (parentSignal && parentSignal.aborted) {
        throw new DOMException("Download cancelled.", "AbortError");
      }
      if (controller.signal.aborted) {
        throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (parentSignal) {
        parentSignal.removeEventListener("abort", abortFromParent);
      }
    }
  }

  function shouldRetryStatus(status) {
    return [408, 425, 429, 500, 502, 503, 504].includes(status);
  }

  function retryDelayMs(response, attempt) {
    const retryAfter = response && response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, RETRY_MAX_MS);
      }

      const dateMs = Date.parse(retryAfter);
      if (Number.isFinite(dateMs)) {
        return Math.min(Math.max(dateMs - Date.now(), 0), RETRY_MAX_MS);
      }
    }

    const jitter = Math.floor(Math.random() * 300);
    return Math.min(RETRY_BASE_MS * 2 ** (attempt - 1) + jitter, RETRY_MAX_MS);
  }

  function pageNumberFromUrl(url, fallback) {
    const name = new URL(url, window.location.href).pathname.split("/").pop() || "";
    const number = Number.parseInt(name.replace(/\D+/g, ""), 10);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizePageLimit(pageLimit, totalPages) {
    if (!Number.isFinite(pageLimit)) {
      return totalPages;
    }
    return Math.max(0, Math.min(totalPages, Math.floor(pageLimit)));
  }

  function missingPageIndexes(pages, pageLimit = null) {
    const missing = [];
    const limit = normalizePageLimit(pageLimit, pages.length);
    for (let index = 0; index < limit; index += 1) {
      if (!pages[index] || !pages[index].bytes) {
        missing.push(index);
      }
    }
    return missing;
  }

  function countDownloadedPages(pages, pageLimit = null) {
    if (!Array.isArray(pages)) {
      return 0;
    }
    const limit = normalizePageLimit(pageLimit, pages.length);
    let count = 0;
    for (let index = 0; index < limit; index += 1) {
      if (pages[index] && pages[index].bytes) {
        count += 1;
      }
    }
    return count;
  }

  function releasePageBytes(pages) {
    if (!Array.isArray(pages)) {
      return;
    }
    pages.forEach((page) => {
      if (page) {
        page.bytes = null;
        page.pdfPrepared = null;
      }
    });
    pages.length = 0;
  }

  function normalizePrefetchLimit(pageLimit) {
    if (!Number.isFinite(pageLimit) || pageLimit <= 0) {
      return null;
    }
    return Math.floor(pageLimit);
  }

  function isPointerNearElement(event, element, distancePx) {
    if (!event || !element || typeof element.getBoundingClientRect !== "function") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return (
      event.clientX >= rect.left - distancePx &&
      event.clientX <= rect.right + distancePx &&
      event.clientY >= rect.top - distancePx &&
      event.clientY <= rect.bottom + distancePx
    );
  }

  function pointerDistanceToElement(event, element) {
    if (!event || !element || typeof element.getBoundingClientRect !== "function") {
      return Number.POSITIVE_INFINITY;
    }
    const rect = element.getBoundingClientRect();
    const dx = event.clientX < rect.left
      ? rect.left - event.clientX
      : Math.max(0, event.clientX - rect.right);
    const dy = event.clientY < rect.top
      ? rect.top - event.clientY
      : Math.max(0, event.clientY - rect.bottom);
    return Math.hypot(dx, dy);
  }

  function isPointerMovingTowardElement(previousEvent, event, element, maxDistancePx, minProgressPx) {
    if (!previousEvent || !event) {
      return false;
    }
    const previousDistance = pointerDistanceToElement(previousEvent, element);
    const currentDistance = pointerDistanceToElement(event, element);
    return (
      currentDistance <= maxDistancePx &&
      previousDistance - currentDistance >= minProgressPx
    );
  }

  function abortableResult(promise, signal) {
    throwIfAborted(signal);
    if (!signal) {
      return promise;
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Download cancelled.", "AbortError"));
      };
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        }
      );
    });
  }

  async function fetchText(url, refererUrl, signal, debug) {
    debug?.log("fetch-text-start", { url });
    const response = await fetchWithTimeout(url, {
      credentials: "include",
      priority: "high",
      referrer: refererUrl || window.location.href
    }, TEXT_FETCH_TIMEOUT_MS, signal);
    debug?.log("fetch-text-response", {
      url,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type") || null
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching ${url}`);
    }
    return response.text();
  }

  async function resolvePages(setProgress, signal, debug) {
    const currentHtml = document.documentElement.outerHTML;
    const currentUrls = extractPageUrls(currentHtml, window.location.href);
    debug?.log("resolve-current-page", {
      count: currentUrls.length,
      hasPagesPush: /pages\.push/i.test(currentHtml)
    });
    if (currentUrls.length && /pages\.push/i.test(currentHtml)) {
      debug?.log("resolve-done", {
        source: "current-page",
        count: currentUrls.length,
        referer: window.location.href
      });
      return {
        pageUrls: currentUrls,
        referer: window.location.href
      };
    }

    let viewerUrl = extractViewerUrlFromDom() || extractViewerUrlFromHtml(currentHtml, window.location.href);
    if (!viewerUrl) {
      const pathMatch = /\/(?:en|ru|kk|la)\/catalogue\/view\/(\d+)/i.exec(window.location.pathname);
      if (pathMatch) {
        const language = window.location.pathname.split("/")[1] || "ru";
        viewerUrl = new URL(`/${language}/bookView/view?brId=${pathMatch[1]}&simple=true`, window.location.origin).href;
      }
    }
    debug?.log("resolve-viewer-candidate", { viewerUrl });

    if (viewerUrl) {
      setProgress(2, "Opening viewer...");
      const viewerHtml = await fetchText(viewerUrl, window.location.href, signal, debug);
      const viewerUrls = extractPageUrls(viewerHtml, viewerUrl);
      debug?.log("resolve-viewer-page", {
        count: viewerUrls.length,
        htmlLength: viewerHtml.length
      });
      if (viewerUrls.length) {
        debug?.log("resolve-done", {
          source: "viewer",
          count: viewerUrls.length,
          referer: viewerUrl
        });
        return {
          pageUrls: viewerUrls,
          referer: viewerUrl
        };
      }
    }

    if (currentUrls.length) {
      debug?.log("resolve-done", {
        source: "current-page-fallback",
        count: currentUrls.length,
        referer: window.location.href
      });
      return {
        pageUrls: currentUrls,
        referer: window.location.href
      };
    }

    throw new Error("Could not find KazNEB page image URLs on this page.");
  }

  function readUint32(bytes, offset) {
    return (
      (bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]
    ) >>> 0;
  }

  function bytesToHex(bytes) {
    let output = "";
    for (const byte of bytes) {
      output += byte.toString(16).padStart(2, "0");
    }
    return output;
  }

  function concatBytes(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  function parsePng(bytes) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < signature.length; i += 1) {
      if (bytes[i] !== signature[i]) {
        throw new Error("Only PNG page images are currently supported.");
      }
    }

    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let palette = null;
    const idatParts = [];

    while (offset + 12 <= bytes.length) {
      const length = readUint32(bytes, offset);
      const type = String.fromCharCode(
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7]
      );
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > bytes.length) {
        throw new Error("Invalid PNG chunk length.");
      }

      const data = bytes.slice(dataStart, dataEnd);
      if (type === "IHDR") {
        width = readUint32(data, 0);
        height = readUint32(data, 4);
        bitDepth = data[8];
        colorType = data[9];
        const compression = data[10];
        const filter = data[11];
        const interlace = data[12];
        if (compression !== 0 || filter !== 0 || interlace !== 0) {
          throw new Error("Unsupported PNG encoding.");
        }
      } else if (type === "PLTE") {
        palette = data;
      } else if (type === "IDAT") {
        idatParts.push(data);
      } else if (type === "IEND") {
        break;
      }
      offset = dataEnd + 4;
    }

    if (!width || !height || !idatParts.length) {
      throw new Error("Invalid PNG file.");
    }

    let colorSpace;
    let colors;
    if (colorType === 3) {
      if (!palette || !palette.length) {
        throw new Error("Indexed PNG is missing its palette.");
      }
      const hival = Math.floor(palette.length / 3) - 1;
      colorSpace = `[/Indexed /DeviceRGB ${hival} <${bytesToHex(palette)}>]`;
      colors = 1;
    } else if (colorType === 0) {
      colorSpace = "/DeviceGray";
      colors = 1;
    } else if (colorType === 2) {
      colorSpace = "/DeviceRGB";
      colors = 3;
    } else {
      throw new Error(`Unsupported PNG color type ${colorType}.`);
    }

    return {
      width,
      height,
      bitDepth,
      colors,
      colorSpace,
      idat: concatBytes(idatParts)
    };
  }

  function pdfNumber(value) {
    return Number(value.toFixed(4)).toString();
  }

  function encodeText(text) {
    return TEXT_ENCODER.encode(text);
  }

  function makeStream(dictionary, data) {
    return concatBytes([
      encodeText(`<< ${dictionary} /Length ${data.length} >>\nstream\n`),
      data,
      encodeText("\nendstream")
    ]);
  }

  function preparePdfPage(page, dpi) {
    if (page.pdfPrepared && page.pdfPrepared.dpi === dpi) {
      return page.pdfPrepared;
    }

    const png = parsePng(new Uint8Array(page.bytes));
    const decodeParms =
      `<< /Predictor 15 /Colors ${png.colors} ` +
      `/BitsPerComponent ${png.bitDepth} /Columns ${png.width} >>`;
    const imageDictionary =
      `/Type /XObject /Subtype /Image /Width ${png.width} /Height ${png.height} ` +
      `/ColorSpace ${png.colorSpace} /BitsPerComponent ${png.bitDepth} ` +
      `/Filter /FlateDecode /DecodeParms ${decodeParms}`;
    const pageWidth = (png.width * 72) / dpi;
    const pageHeight = (png.height * 72) / dpi;
    const content = encodeText(
      `q\n${pdfNumber(pageWidth)} 0 0 ${pdfNumber(pageHeight)} 0 0 cm\n/Im0 Do\nQ\n`
    );

    page.pdfPrepared = {
      contentStream: makeStream("", content),
      dpi,
      imageStream: makeStream(imageDictionary, png.idat),
      pageHeight,
      pageWidth
    };
    return page.pdfPrepared;
  }

  function prebuildPdfPage(page, dpi, debug) {
    if (!page || !page.bytes) {
      return null;
    }
    try {
      return preparePdfPage(page, dpi);
    } catch (error) {
      debug?.log("pdf-prebuild-failed", {
        url: page.url,
        error: serializeError(error)
      });
      return null;
    }
  }

  function warmKaznebTransport() {
    const host = document.head || document.documentElement;
    if (!host || document.getElementById("kazneb-dl-preconnect")) {
      return;
    }

    const preconnect = document.createElement("link");
    preconnect.id = "kazneb-dl-preconnect";
    preconnect.rel = "preconnect";
    preconnect.href = window.location.origin;
    host.appendChild(preconnect);

    const dnsPrefetch = document.createElement("link");
    dnsPrefetch.id = "kazneb-dl-dns-prefetch";
    dnsPrefetch.rel = "dns-prefetch";
    dnsPrefetch.href = window.location.origin;
    host.appendChild(dnsPrefetch);
  }

  function buildPdfFromPngs(pages, dpi, setProgress) {
    if (!pages || !pages.length) {
      throw new Error("No pages were downloaded; refusing to create an empty PDF.");
    }

    const missingIndexes = missingPageIndexes(pages);
    if (missingIndexes.length) {
      const sample = missingIndexes.slice(0, 12).map((index) => index + 1).join(", ");
      throw new Error(
        `Cannot create PDF because ${missingIndexes.length} page${missingIndexes.length === 1 ? "" : "s"} are missing: ${sample}${missingIndexes.length > 12 ? ", ..." : ""}`
      );
    }

    const objects = [null, null];
    const pageIds = [];

    pages.forEach((page, index) => {
      const prepared = preparePdfPage(page, dpi);
      const imageObjectId = objects.length + 1;
      objects.push(prepared.imageStream);

      const contentObjectId = objects.length + 1;
      objects.push(prepared.contentStream);

      const pageObjectId = objects.length + 1;
      pageIds.push(pageObjectId);
      objects.push(
        encodeText(
          `<< /Type /Page /Parent 2 0 R ` +
            `/MediaBox [0 0 ${pdfNumber(prepared.pageWidth)} ${pdfNumber(prepared.pageHeight)}] ` +
            `/Resources << /XObject << /Im0 ${imageObjectId} 0 R >> >> ` +
            `/Contents ${contentObjectId} 0 R >>`
        )
      );

      setProgress(
        100,
        `Compiling PDF ${index + 1}/${pages.length}...`
      );
    });

    objects[0] = encodeText("<< /Type /Catalog /Pages 2 0 R >>");
    objects[1] = encodeText(
      `<< /Type /Pages /Count ${pageIds.length} /Kids [` +
        pageIds.map((pageId) => `${pageId} 0 R`).join(" ") +
        "] >>"
    );

    const parts = [
      concatBytes([encodeText("%PDF-1.4\n%"), new Uint8Array([226, 227, 207, 211]), encodeText("\n")])
    ];
    const offsets = [0];
    let position = parts[0].length;

    objects.forEach((objectBody, index) => {
      const header = encodeText(`${index + 1} 0 obj\n`);
      const footer = encodeText("\nendobj\n");
      offsets.push(position);
      parts.push(header, objectBody, footer);
      position += header.length + objectBody.length + footer.length;
    });

    const xrefOffset = position;
    let xref =
      `xref\n0 ${objects.length + 1}\n` +
      "0000000000 65535 f \n" +
      offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join("") +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`;
    parts.push(encodeText(xref));

    return new Blob(parts, { type: "application/pdf" });
  }

  async function fetchPageBytesOnce(url, referer, signal) {
    const networkProfile = getNetworkProfile();
    const response = await fetchWithTimeout(url, {
      credentials: "include",
      priority: "high",
      referrer: referer
    }, networkProfile.pageFetchTimeoutMs, signal);
    if (!response.ok) {
      if (shouldRetryStatus(response.status)) {
        const error = new Error(`HTTP ${response.status}`);
        error.retryable = true;
        error.response = response;
        throw error;
      }
      throw new Error(`HTTP ${response.status} while downloading ${url}`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType && !contentType.toLowerCase().startsWith("image/")) {
      throw new Error(`Expected an image, got ${contentType}`);
    }
    return response.arrayBuffer();
  }

  async function fetchPageBytesWithRetry(url, referer, options) {
    const { pageNumber, totalPages, signal, setProgress, debug, pacer, workerId } = options;
    let lastError = null;

    for (let attempt = 1; attempt <= PAGE_RETRIES; attempt += 1) {
      throwIfAborted(signal);
      try {
        await pacer?.waitTurn({
          pageNumber,
          attempt,
          workerId
        });
        debug?.log("page-attempt", {
          pageNumber,
          totalPages,
          attempt,
          workerId,
          url
        });
        const bytes = await fetchPageBytesOnce(url, referer, signal);
        debug?.log("page-success", {
          pageNumber,
          totalPages,
          attempt,
          workerId,
          bytes: bytes.byteLength
        });
        return bytes;
      } catch (error) {
        lastError = error;
        const retryable =
          error.retryable ||
          error.name === "TypeError" ||
          /timed out|network/i.test(error.message || "");

        if (error.name === "AbortError" || !retryable || attempt === PAGE_RETRIES) {
          break;
        }

        const waitMs = retryDelayMs(error.response, attempt);
        const status = error.response ? error.response.status : null;
        if (pacer && (status === 429 || status === 503 || status === 504)) {
          pacer.coolDown(Math.max(waitMs, RATE_LIMIT_COOLDOWN_MS), {
            status,
            pageNumber,
            attempt,
            workerId
          });
        }
        debug?.log("page-retry", {
          pageNumber,
          totalPages,
          attempt,
          workerId,
          waitMs,
          error: serializeError(error)
        });
        setProgress(
          null,
          `Retrying page ${pageNumber}/${totalPages} in ${(waitMs / 1000).toFixed(1)}s (${attempt}/${PAGE_RETRIES - 1})...`
        );
        await abortableDelay(waitMs, signal);
      }
    }

    debug?.log("page-failed", {
      pageNumber,
      totalPages,
      error: serializeError(lastError)
    });
    throw lastError || new Error(`Failed to download page ${pageNumber}.`);
  }

  function saveBlobViaAnchor(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    link.style.display = "none";
    (document.body || document.documentElement).appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function downloadAllPages(
    pageUrls,
    referer,
    setProgress,
    signal,
    debug,
    initialPages = null,
    pageLimit = null,
    inFlightPages = null,
    onPageStored = null,
    options = {}
  ) {
    const pages = Array.isArray(initialPages) && initialPages.length === pageUrls.length
      ? initialPages
      : new Array(pageUrls.length).fill(null);
    const errors = new Map();
    const pacer = createRequestPacer(signal, debug);
    const targetPageCount = normalizePageLimit(pageLimit, pageUrls.length);
    const networkProfile = getNetworkProfile();
    const shouldStopScheduling = typeof options.shouldStopScheduling === "function"
      ? options.shouldStopScheduling
      : null;
    let completed = countDownloadedPages(pages, targetPageCount);
    debug?.log("download-cache-state", {
      cachedPages: completed,
      networkProfile,
      targetPages: targetPageCount,
      totalPages: pageUrls.length
    });

    for (let pass = 1; pass <= MISSING_PAGE_PASSES; pass += 1) {
      const missingIndexes = missingPageIndexes(pages, targetPageCount);
      const concurrency = Math.min(networkProfile.pageConcurrency, missingIndexes.length);
      debug?.log("download-pass-start", {
        pass,
        missingCount: missingIndexes.length,
        concurrency,
        completed,
        targetPages: targetPageCount,
        totalPages: pageUrls.length,
        requestStartSpacingMs: REQUEST_START_SPACING_MS
      });

      if (!missingIndexes.length) {
        break;
      }

      if (pass > 1) {
        setProgress(
          5 + Math.round((completed / targetPageCount) * 95),
          `Retrying ${missingIndexes.length} missing page${missingIndexes.length === 1 ? "" : "s"}...`
        );
      }

      let cursor = 0;
      const downloadWorker = async (workerId) => {
        while (cursor < missingIndexes.length) {
          throwIfAborted(signal);
          if (shouldStopScheduling?.()) {
            debug?.log("download-pass-claimed-stop", {
              completed,
              pass,
              targetPages: targetPageCount,
              totalPages: pageUrls.length,
              workerId
            });
            return;
          }
          const index = missingIndexes[cursor];
          cursor += 1;
          const pageNumber = pageNumberFromUrl(pageUrls[index], index + 1);
          if (pages[index] && pages[index].bytes) {
            completed += 1;
            setProgress(
              5 + Math.round((completed / targetPageCount) * 95),
              `Downloading pages ${completed}/${targetPageCount}...`
            );
            debug?.log("page-cache-hit-late", {
              completed,
              index,
              pageNumber,
              targetPages: targetPageCount,
              totalPages: pageUrls.length,
              workerId
            });
            continue;
          }
          const percent = 5 + Math.round((completed / targetPageCount) * 95);
          setProgress(
            percent,
            `Downloading pages ${completed}/${targetPageCount}...`
          );

          try {
            let pagePromise = inFlightPages ? inFlightPages[index] : null;
            if (!pagePromise) {
              if (shouldStopScheduling?.()) {
                debug?.log("page-start-skipped-after-claim", {
                  index,
                  pageNumber,
                  workerId
                });
                return;
              }
              pagePromise = fetchPageBytesWithRetry(pageUrls[index], referer, {
                pageNumber,
                totalPages: pageUrls.length,
                signal,
                setProgress,
                debug,
                pacer,
                workerId
              }).then((bytes) => {
                const page = { url: pageUrls[index], bytes };
                pages[index] = page;
                onPageStored?.(page, index);
                return page;
              }).finally(() => {
                if (inFlightPages && inFlightPages[index] === pagePromise) {
                  inFlightPages[index] = null;
                }
              });
              if (inFlightPages) {
                inFlightPages[index] = pagePromise;
              }
            } else {
              debug?.log("page-await-inflight", {
                pageNumber,
                index,
                workerId
              });
            }
            const page = await abortableResult(pagePromise, signal);
            if (page && page.bytes) {
              pages[index] = page;
            }
            errors.delete(index);
            completed += 1;
            setProgress(
              5 + Math.round((completed / targetPageCount) * 95),
              `Downloading pages ${completed}/${targetPageCount}...`
            );
            debug?.log("page-stored", {
              pageNumber,
              index,
              workerId,
              completed,
              targetPages: targetPageCount,
              totalPages: pageUrls.length
            });
          } catch (error) {
            if (error && error.name === "AbortError") {
              throw error;
            }
            errors.set(index, error);
            debug?.log("page-error-stored", {
              pageNumber,
              index,
              workerId,
              error: serializeError(error)
            });
          }
        }
      };

      await Promise.all(
        Array.from({ length: concurrency }, (_, workerIndex) => downloadWorker(workerIndex + 1))
      );

      if (shouldStopScheduling?.()) {
        debug?.log("download-claimed-stop", {
          completed,
          pass,
          targetPages: targetPageCount,
          totalPages: pageUrls.length
        });
        return pages;
      }
    }

    const stillMissing = missingPageIndexes(pages, targetPageCount).map((index) => index + 1);

    if (stillMissing.length) {
      const sample = stillMissing.slice(0, 12).join(", ");
      debug?.log("download-failed-missing-pages", {
        missingCount: stillMissing.length,
        sample,
        lastErrors: [...errors.entries()].slice(0, 12).map(([index, error]) => ({
          page: index + 1,
          error: serializeError(error)
        }))
      });
      throw new Error(
        `Could not download ${stillMissing.length} page${stillMissing.length === 1 ? "" : "s"} after retries: ${sample}${stillMissing.length > 12 ? ", ..." : ""}`
      );
    }

    debug?.log("download-all-pages-done", {
      completed,
      targetPages: targetPageCount,
      totalPages: pageUrls.length
    });
    return pages;
  }

  function createHoverPrefetchManager(getWarmPages = null) {
    let prefetch = null;
    let cleanupTimer = null;

    const clearCleanupTimer = () => {
      if (cleanupTimer) {
        clearTimeout(cleanupTimer);
        cleanupTimer = null;
      }
    };

    const clearPrefetch = (current = prefetch, releasePages = true) => {
      clearCleanupTimer();
      if (!current) {
        return;
      }
      if (current.controller && !current.controller.signal.aborted) {
        current.controller.abort();
      }
      if (releasePages) {
        releasePageBytes(current.pages);
      }
      if (prefetch === current) {
        prefetch = null;
      }
    };

    const scheduleCleanup = (current, delayMs = PREFETCH_CACHE_TTL_MS) => {
      if (prefetch !== current) {
        return;
      }
      clearCleanupTimer();
      cleanupTimer = setTimeout(() => {
        if (prefetch === current) {
          clearPrefetch(current, true);
        }
      }, delayMs);
      if (typeof cleanupTimer.unref === "function") {
        cleanupTimer.unref();
      }
    };

    const createPrefetchState = (pageLimit) => {
      const controller = new AbortController();
      return {
        controller,
        debug: createDebugCollector(),
        error: null,
        inFlightPages: null,
        pageUrls: null,
        pages: null,
        promise: null,
        referer: null,
        running: false,
        claimed: false,
        targetLimit: normalizePrefetchLimit(pageLimit)
      };
    };

    const targetPagesForPrefetch = (current) => {
      if (!current.pageUrls) {
        return 0;
      }
      return normalizePageLimit(current.targetLimit, current.pageUrls.length);
    };

    const upgradeTarget = (current, pageLimit) => {
      const nextLimit = normalizePrefetchLimit(pageLimit);
      if (current.targetLimit === null) {
        return;
      }
      if (nextLimit === null || nextLimit > current.targetLimit) {
        current.targetLimit = nextLimit;
      }
    };

    const runPrefetch = (current) => {
      if (current.running) {
        return current.promise;
      }

      current.running = true;
      current.promise = (async () => {
        const { controller, debug } = current;
        debug.log("prefetch-start", {
          targetLimit: current.targetLimit
        });
        const warmed = getWarmPages ? await getWarmPages() : null;
        throwIfAborted(controller.signal);
        const resolved = warmed || await resolvePages(() => {}, controller.signal, debug);
        current.pageUrls = resolved.pageUrls;
        current.referer = resolved.referer;
        current.bookId = resolved.bookId || inferBookId(resolved.referer || window.location.href, resolved.pageUrls);
        current.bookTitle = resolved.bookTitle || inferBookTitle(current.bookId);
        if (!current.pages || current.pages.length !== resolved.pageUrls.length) {
          current.pages = new Array(resolved.pageUrls.length).fill(null);
        }
        if (!current.inFlightPages || current.inFlightPages.length !== resolved.pageUrls.length) {
          current.inFlightPages = new Array(resolved.pageUrls.length).fill(null);
        }
        debug.log("prefetch-pages-resolved", {
          count: resolved.pageUrls.length,
          referer: resolved.referer
        });

        while (true) {
          const targetPages = targetPagesForPrefetch(current);
          const cachedBefore = countDownloadedPages(current.pages, targetPages);
          debug.log("prefetch-target-start", {
            cachedPages: cachedBefore,
            targetPages,
            totalPages: resolved.pageUrls.length
          });
          await downloadAllPages(
            resolved.pageUrls,
            resolved.referer,
            () => {},
            controller.signal,
            debug,
            current.pages,
            targetPages,
            current.inFlightPages,
            (page) => prebuildPdfPage(page, 300, debug),
            {
              shouldStopScheduling: () => current.claimed
            }
          );
          const cachedAfter = countDownloadedPages(current.pages, targetPages);
          debug.log("prefetch-target-done", {
            cachedPages: cachedAfter,
            targetPages,
            totalPages: resolved.pageUrls.length
          });
          if (targetPagesForPrefetch(current) <= targetPages) {
            break;
          }
        }

        debug.log("prefetch-done", {
          cachedPages: countDownloadedPages(current.pages),
          totalPages: resolved.pageUrls.length
        });
        scheduleCleanup(current);
      })().catch((error) => {
        current.error = error;
        current.debug.log(error && error.name === "AbortError" ? "prefetch-aborted" : "prefetch-error", {
          cachedPages: countDownloadedPages(current.pages),
          totalPages: current.pageUrls ? current.pageUrls.length : 0,
          error: serializeError(error)
        });
        if (error && error.name !== "AbortError") {
          scheduleCleanup(current, 30_000);
        }
      }).finally(() => {
        current.running = false;
      });

      return current.promise;
    };

    return {
      start(pageLimit = null) {
        if (prefetch && !prefetch.error) {
          upgradeTarget(prefetch, pageLimit);
          return runPrefetch(prefetch);
        }

        clearPrefetch(prefetch, true);
        const current = createPrefetchState(pageLimit);
        prefetch = current;
        return runPrefetch(current);
      },
      take() {
        const current = prefetch;
        if (!current) {
          return null;
        }

        clearCleanupTimer();
        if (prefetch === current) {
          prefetch = null;
        }
        current.claimed = true;

        if (!current.pageUrls || !current.referer || !current.pages) {
          releasePageBytes(current.pages);
          if (current.controller && !current.controller.signal.aborted) {
            current.controller.abort();
          }
          return null;
        }

        const downloaded = countDownloadedPages(current.pages);
        return {
          bookId: current.bookId,
          bookTitle: current.bookTitle,
          controller: current.controller,
          downloaded,
          inFlightPages: current.inFlightPages,
          pageUrls: current.pageUrls,
          pages: current.pages,
          referer: current.referer,
          total: current.pageUrls.length
        };
      },
      abort() {
        clearPrefetch(prefetch, true);
      }
    };
  }

  async function downloadPdf(setProgress, signal, debug, prefetched = null) {
    let pages = [];
    const prefetchController = prefetched && prefetched.controller;
    const abortPrefetch = () => {
      if (prefetchController && !prefetchController.signal.aborted) {
        prefetchController.abort();
      }
    };
    if (signal && prefetchController) {
      signal.addEventListener("abort", abortPrefetch, { once: true });
    }

    try {
      debug?.log("download-start");
      setProgress(1, "Finding pages...");
      const resolvedPages = prefetched && prefetched.pageUrls && prefetched.referer
        ? prefetched
        : await resolvePages(setProgress, signal, debug);
      const { pageUrls, referer } = resolvedPages;
      if (!pageUrls.length) {
        throw new Error("KazNEB exposed zero page URLs.");
      }
      const prefetchedPages = Array.isArray(prefetched?.pages) && prefetched.pages.length === pageUrls.length
        ? prefetched.pages
        : null;
      const inFlightPages = Array.isArray(prefetched?.inFlightPages) && prefetched.inFlightPages.length === pageUrls.length
        ? prefetched.inFlightPages
        : null;
      const prefetchedCount = countDownloadedPages(prefetchedPages);
      const bookId = prefetched?.bookId || inferBookId(referer || window.location.href, pageUrls);
      const bookTitle = prefetched?.bookTitle || inferBookTitle(bookId);
      debug?.log("pages-resolved", {
        bookId,
        bookTitle,
        count: pageUrls.length,
        inFlight: inFlightPages ? inFlightPages.filter(Boolean).length : 0,
        prefetched: prefetchedCount,
        referer,
        firstUrl: pageUrls[0],
        lastUrl: pageUrls[pageUrls.length - 1]
      });
      if (prefetchedCount) {
        setProgress(
          5 + Math.round((prefetchedCount / pageUrls.length) * 95),
          `Using prefetched pages ${prefetchedCount}/${pageUrls.length}...`
        );
      }
      pages = await downloadAllPages(
        pageUrls,
        referer,
        setProgress,
        signal,
        debug,
        prefetchedPages,
        null,
        inFlightPages
      );

      throwIfAborted(signal);
      setProgress(100, "Compiling PDF...");
      debug?.log("compile-start", {
        pageCount: pages.length
      });
      const pdf = buildPdfFromPngs(pages, 300, setProgress);
      const fileName = `${bookTitle}.pdf`;
      throwIfAborted(signal);
      debug?.log("compile-done", {
        fileName,
        pageCount: pages.length,
        pdfBytes: pdf.size
      });
      return {
        pdf,
        fileName,
        pageCount: pages.length
      };
    } finally {
      if (signal && prefetchController) {
        signal.removeEventListener("abort", abortPrefetch);
      }
      abortPrefetch();
      releasePageBytes(pages);
    }
  }

  function findButtonHost() {
    const bookActions = document.querySelector(".book-actions");
    if (bookActions) {
      return bookActions;
    }

    const viewLink = document.querySelector('a[href*="/bookView/view"], a[href*="/bookview/view"]');
    if (viewLink && viewLink.parentElement) {
      return viewLink.parentElement;
    }

    return null;
  }

  function findOfficialDownloadButton() {
    return document.querySelector(
      [
        ".book-actions a.download-ico[href*=\"full.pdf\"]",
        ".book-actions a[href*=\"/FileStore/\"][href*=\"full.pdf\"]",
        "a.download-ico[href*=\"full.pdf\"]"
      ].join(", ")
    );
  }

  function patchOfficialDownloadButton() {
    const officialButton = findOfficialDownloadButton();
    if (!officialButton) {
      return null;
    }

    if (getKaznebLanguage() === "la") {
      const label = officialButton.querySelector("span");
      if (label) {
        label.textContent = "Jukteu";
      } else {
        officialButton.appendChild(document.createTextNode("Jukteu"));
      }
    }

    return officialButton;
  }

  function hideOfficialDownloadButton(officialButton) {
    if (!officialButton) {
      return;
    }

    officialButton.classList.add("kazneb-dl-official-hidden");
    officialButton.hidden = true;
    officialButton.setAttribute("aria-hidden", "true");
    officialButton.setAttribute("tabindex", "-1");
  }

  function removeInlineControls() {
    document.getElementById("kazneb-download-inline-button")?.remove();
    document.querySelector(".kazneb-dl-progress-wrap")?.remove();
  }

  function createInlineControls() {
    const officialButton = patchOfficialDownloadButton();
    const canGeneratePdf =
      /\/bookview\/view/i.test(window.location.pathname) ||
      hasGeneratedPdfSourceInHtml(document.documentElement.outerHTML);

    if (!canGeneratePdf) {
      removeInlineControls();
      return Boolean(officialButton);
    }

    warmKaznebTransport();

    if (document.getElementById("kazneb-download-inline-button")) {
      hideOfficialDownloadButton(officialButton);
      return true;
    }

    const host = findButtonHost();
    if (!host) {
      return false;
    }

    hideOfficialDownloadButton(officialButton);

    const button = document.createElement("a");
    button.id = "kazneb-download-inline-button";
    button.className = "download-ico btn btn-secondary kazneb-dl-inline-button";
    button.href = "#";
    button.setAttribute("role", "button");

    const icon = document.createElement("img");
    icon.src = getDownloadIconUrl();
    icon.alt = "";

    const label = document.createElement("span");
    label.textContent = getDownloadLabel();

    button.appendChild(icon);
    button.appendChild(label);

    const progressWrap = document.createElement("div");
    progressWrap.className = "kazneb-dl-progress-wrap";
    progressWrap.hidden = true;
    progressWrap.innerHTML = `
      <div class="kazneb-dl-status">Ready</div>
      <div class="kazneb-dl-progress" aria-hidden="true"><div></div></div>
      <div class="kazneb-dl-debug" hidden>
        <button class="kazneb-dl-debug-copy" type="button">Copy debug</button>
        <pre class="kazneb-dl-debug-output"></pre>
      </div>
    `;

    host.appendChild(button);

    const status = progressWrap.querySelector(".kazneb-dl-status");
    const progress = progressWrap.querySelector(".kazneb-dl-progress > div");
    const debugWrap = progressWrap.querySelector(".kazneb-dl-debug");
    const debugOutput = progressWrap.querySelector(".kazneb-dl-debug-output");
    const debugCopy = progressWrap.querySelector(".kazneb-dl-debug-copy");
    let activeController = null;
    let currentRunToken = 0;
    let lastPointerEvent = null;
    let warmPages = null;
    let partialPrefetchStarted = false;
    let fullPrefetchStarted = false;
    let pointerProximityArmed = false;
    const warmPagesPromise = resolvePages(() => {}, null, null)
      .then((pages) => {
        const bookId = inferBookId(pages.referer || window.location.href, pages.pageUrls);
        warmPages = {
          ...pages,
          bookId,
          bookTitle: inferBookTitle(bookId)
        };
        return warmPages;
      })
      .catch(() => null);
    const prefetchManager = createHoverPrefetchManager(() => warmPages || warmPagesPromise);

    const setButtonLabel = (text) => {
      label.textContent = text;
    };

    const mountProgress = () => {
      if (!progressWrap.isConnected) {
        button.insertAdjacentElement("afterend", progressWrap);
      }
    };

    const setDebugReport = (report) => {
      if (!debugWrap || !debugOutput) {
        return;
      }
      if (!report) {
        debugOutput.textContent = "";
        debugWrap.hidden = true;
        return;
      }
      debugOutput.textContent = report;
      debugWrap.hidden = false;
      if (debugCopy) {
        debugCopy.textContent = "Copy debug";
      }
    };

    const setProgress = (percent, message, isError = false) => {
      mountProgress();
      progressWrap.hidden = false;
      if (typeof percent === "number") {
        progress.style.width = `${Math.max(0, Math.min(100, percent))}%`;
      }
      status.textContent = message;
      status.classList.toggle("kazneb-dl-error", Boolean(isError));
    };

    const hideProgress = () => {
      progressWrap.hidden = true;
      progress.style.width = "0%";
      status.textContent = "Ready";
      status.classList.remove("kazneb-dl-error");
      setDebugReport(null);
      progressWrap.remove();
    };

    const setBusy = (busy) => {
      button.dataset.running = busy ? "true" : "false";
      button.setAttribute("aria-busy", busy ? "true" : "false");
      setButtonLabel(busy ? getCancelLabel() : getDownloadLabel());
    };

    debugCopy?.addEventListener("click", async (event) => {
      event.preventDefault();
      const text = debugOutput ? debugOutput.textContent : "";
      if (!text) {
        return;
      }

      try {
        await navigator.clipboard.writeText(text);
        debugCopy.textContent = "Copied";
        setTimeout(() => {
          debugCopy.textContent = "Copy debug";
        }, 1500);
      } catch (error) {
        debugCopy.textContent = "Copy failed";
      }
    });

    const startApproachPrefetch = () => {
      if (activeController || partialPrefetchStarted || fullPrefetchStarted) {
        return;
      }
      partialPrefetchStarted = true;
      void prefetchManager.start(PREFETCH_APPROACH_PAGE_LIMIT);
    };

    const startFullPrefetch = () => {
      if (activeController || fullPrefetchStarted) {
        return;
      }
      fullPrefetchStarted = true;
      partialPrefetchStarted = true;
      disarmPointerProximity();
      void prefetchManager.start();
    };

    const handlePointerProximity = (event) => {
      if (!button.isConnected) {
        disarmPointerProximity();
        return;
      }
      const previousPointerEvent = lastPointerEvent;
      lastPointerEvent = {
        clientX: event.clientX,
        clientY: event.clientY
      };
      if (isPointerNearElement(event, button, PREFETCH_CLOSE_PROXIMITY_PX)) {
        startFullPrefetch();
      } else if (isPointerMovingTowardElement(
        previousPointerEvent,
        event,
        button,
        PREFETCH_APPROACH_PROXIMITY_PX,
        PREFETCH_APPROACH_MIN_PROGRESS_PX
      )) {
        startApproachPrefetch();
      }
    };

    const armPointerProximity = () => {
      if (!pointerProximityArmed) {
        document.addEventListener("pointermove", handlePointerProximity, { passive: true });
        pointerProximityArmed = true;
      }
    };

    function disarmPointerProximity() {
      if (pointerProximityArmed) {
        document.removeEventListener("pointermove", handlePointerProximity);
        pointerProximityArmed = false;
      }
    }

    button.addEventListener("pointerenter", startFullPrefetch);
    armPointerProximity();

    button.addEventListener("click", async (event) => {
      event.preventDefault();

      if (activeController) {
        const controller = activeController;
        activeController = null;
        currentRunToken += 1;
        controller.abort();
        prefetchManager.abort();
        partialPrefetchStarted = false;
        fullPrefetchStarted = false;
        lastPointerEvent = null;
        armPointerProximity();
        hideProgress();
        setBusy(false);
        return;
      }

      const runToken = currentRunToken + 1;
      currentRunToken = runToken;
      const debug = createDebugCollector();
      setDebugReport(null);
      activeController = new AbortController();
      setBusy(true);
      const warmed = warmPages;
      const prefetched = prefetchManager.take();
      const setRunProgress = (percent, message, isError = false) => {
        if (runToken === currentRunToken) {
          setProgress(percent, message, isError);
        }
      };

      try {
        if (prefetched) {
          debug.log("prefetch-consumed", {
            cachedPages: prefetched.downloaded,
            totalPages: prefetched.total
          });
        }
        const result = await downloadPdf(setRunProgress, activeController.signal, debug, prefetched || warmed);
        setRunProgress(98, `Starting download for ${result.fileName}...`);
        saveBlobViaAnchor(result.pdf, result.fileName);
        debug.log("save-started", {
          method: "anchor",
          fileName: result.fileName,
          pdfBytes: result.pdf.size
        });
        setRunProgress(
          100,
          `Download started for ${result.fileName} (${formatBytes(result.pdf.size)}, ${result.pageCount} pages).`
        );
        if (runToken === currentRunToken) {
          hideProgress();
        }
      } catch (error) {
        debug.log("download-error", {
          error: serializeError(error)
        });
        if (runToken !== currentRunToken) {
          return;
        } else if (error && error.name === "AbortError") {
          hideProgress();
        } else {
          setRunProgress(100, error && error.message ? error.message : String(error), true);
          setDebugReport(debug.report({ error: serializeError(error) }));
        }
      } finally {
        if (runToken === currentRunToken) {
          activeController = null;
          setBusy(false);
          partialPrefetchStarted = false;
          fullPrefetchStarted = false;
          lastPointerEvent = null;
          armPointerProximity();
        }
      }
    });

    window.addEventListener("beforeunload", () => {
      if (activeController) {
        activeController.abort();
      }
      disarmPointerProximity();
      prefetchManager.abort();
    });

    return true;
  }

  function shouldInject() {
    if (!/kazneb\.kz$/i.test(window.location.hostname)) {
      return false;
    }
    const html = document.documentElement.outerHTML;
    return (
      /\/bookview\/view/i.test(window.location.pathname) ||
      hasDownloadSourceInHtml(html)
    );
  }

  if (window.__kaznebDownloaderExposeTestApi) {
    window.__kaznebDownloaderTestApi = {
      abortableDelay,
      abortableResult,
      buildPdfFromPngs,
      createRequestPacer,
      countDownloadedPages,
      createHoverPrefetchManager,
      downloadAllPages,
      extractPageUrls,
      fetchPageBytesWithRetry,
      getNetworkProfile,
      hasGeneratedPdfSourceInHtml,
      hasDownloadSourceInHtml,
      isPointerNearElement,
      isPointerMovingTowardElement,
      missingPageIndexes,
      pointerDistanceToElement,
      prebuildPdfPage,
      preparePdfPage,
      retryDelayMs,
      shouldInject,
      shouldRetryStatus
    };
  }

  if (!window.__kaznebDownloaderDisableAutoInject && shouldInject()) {
    createInlineControls();
    const observer = new MutationObserver(() => {
      createInlineControls();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    setTimeout(() => observer.disconnect(), 10_000);
  }
})();
