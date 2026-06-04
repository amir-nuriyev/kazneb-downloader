const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { TextEncoder } = require("node:util");

const CONTENT_PATH = path.join(
  __dirname,
  "..",
  "content.js"
);

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function createElement(tagName) {
  if (tagName === "textarea") {
    let value = "";
    return {
      set innerHTML(input) {
        value = decodeEntities(input);
      },
      get value() {
        return value;
      }
    };
  }

  return {
    tagName: String(tagName).toUpperCase(),
    children: [],
    classList: {
      add() {},
      remove() {},
      toggle() {}
    },
    style: {},
    hidden: false,
    textContent: "",
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      return child;
    },
    click() {},
    getAttribute() {
      return null;
    },
    insertAdjacentElement(_position, child) {
      this.children.push(child);
      child.parentElement = this;
    },
    querySelector() {
      return null;
    },
    remove() {
      this.removed = true;
    },
    setAttribute(name, value) {
      this[name] = value;
    }
  };
}

function loadExtension({
  connection,
  fetchImpl,
  html = "",
  random = () => 0,
  url = "https://example.test/ru/catalogue/view/1"
} = {}) {
  const code = fs.readFileSync(CONTENT_PATH, "utf8");
  const location = new URL(url);
  const document = {
    title: "Fallback title | KazNEB",
    body: createElement("body"),
    documentElement: {
      lang: "",
      outerHTML: html
    },
    createElement,
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    }
  };
  const math = Object.create(Math);
  math.random = random;
  const context = {
    AbortController,
    Blob,
    Date,
    DOMException,
    DOMParser: class {
      parseFromString() {
        return {
          querySelectorAll() {
            return [];
          }
        };
      }
    },
    Math: math,
    MutationObserver: class {
      disconnect() {}
      observe() {}
    },
    TextEncoder,
    URL,
    chrome: {
      runtime: {
        getManifest() {
          return { version: "test" };
        }
      }
    },
    clearTimeout,
    console,
    document,
    fetch: fetchImpl || (() => {
      throw new Error("Unexpected fetch call.");
    }),
    navigator: {
      connection,
      userAgent: "node-test"
    },
    setTimeout,
    window: {
      __kaznebDownloaderDisableAutoInject: true,
      __kaznebDownloaderExposeTestApi: true,
      location
    }
  };
  context.window.document = document;

  vm.createContext(context);
  vm.runInContext(code, context, { filename: CONTENT_PATH });
  return context.window.__kaznebDownloaderTestApi;
}

function response({
  status = 200,
  bytes = Uint8Array.of(1),
  contentType = "image/png",
  retryAfter = null,
  text = ""
} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const normalized = String(name).toLowerCase();
        if (normalized === "content-type") {
          return contentType;
        }
        if (normalized === "retry-after") {
          return retryAfter;
        }
        return null;
      }
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async text() {
      return text;
    }
  };
}

function testDebug() {
  const entries = [];
  return {
    entries,
    log(event, data = {}) {
      entries.push({ event, ...data });
    }
  };
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]);
}

function tinyPngBytes() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", Buffer.from([120, 156, 99, 0, 0, 0, 1])),
      pngChunk("IEND")
    ])
  );
}

test("extractPageUrls decodes HTML entities and de-duplicates URLs", () => {
  const api = loadExtension();
  const html = `
    pages.push("/FileStore/dataFiles/aa/bb/1/content/0001.png?time=1&amp;key=a");
    pages.push("/FileStore/dataFiles/aa/bb/1/content/0001.png?time=1&amp;key=a");
    pages.push("/FileStore/dataFiles/aa/bb/1/content/0002.png?time=2&amp;key=b");
  `;

  assert.deepEqual(
    Array.from(api.extractPageUrls(html, "https://kazneb.kz/ru/bookView/view?brId=1")),
    [
      "https://kazneb.kz/FileStore/dataFiles/aa/bb/1/content/0001.png?time=1&key=a",
      "https://kazneb.kz/FileStore/dataFiles/aa/bb/1/content/0002.png?time=2&key=b"
    ]
  );
});

test("cover images alone are not treated as downloadable page images", () => {
  const api = loadExtension();
  const html = `
    <img src="/FileStore/dataFiles/60/4d/414682/content/bigcover.png?time=1&amp;key=cover">
    <source srcset="/FileStore/dataFiles/60/4d/414682/content/bigcover.png?time=1&amp;key=cover">
  `;

  assert.deepEqual(Array.from(api.extractPageUrls(html, "https://kazneb.kz/ru/catalogue/view/414682")), []);
  assert.equal(api.hasDownloadSourceInHtml(html), false);
});

test("catalogue pages without a viewer, official PDF, or page images do not inject", () => {
  const api = loadExtension({
    url: "https://kazneb.kz/ru/catalogue/view/414682",
    html: `
      <div class="book-actions"></div>
      <img src="/FileStore/dataFiles/60/4d/414682/content/bigcover.png?time=1&amp;key=cover">
    `
  });

  assert.equal(api.shouldInject(), false);
});

test("native PDF alone is not treated as a generated-PDF source", () => {
  const api = loadExtension({
    url: "https://kazneb.kz/ru/catalogue/view/999",
    html: '<a class="download-ico" href="/FileStore/dataFiles/a/b/999/content/full.pdf">Download</a>'
  });

  assert.equal(api.hasDownloadSourceInHtml('<a href="/content/full.pdf">Download</a>'), true);
  assert.equal(api.hasGeneratedPdfSourceInHtml('<a href="/content/full.pdf">Download</a>'), false);
  assert.equal(api.shouldInject(), true);
});

test("catalogue pages with a viewer link still inject", () => {
  const api = loadExtension({
    url: "https://kazneb.kz/ru/catalogue/view/1658804",
    html: '<a href="/ru/bookView/view?brId=1658804&amp;simple=true">Просмотр</a>'
  });

  assert.equal(api.shouldInject(), true);
});

test("numeric FileStore page images still count as downloadable sources", () => {
  const api = loadExtension();
  const html = '<script>const p="/FileStore/dataFiles/aa/bb/1/content/0001.png?time=1&amp;key=a";</script>';

  assert.deepEqual(
    Array.from(api.extractPageUrls(html, "https://kazneb.kz/ru/bookView/view?brId=1")),
    ["https://kazneb.kz/FileStore/dataFiles/aa/bb/1/content/0001.png?time=1&key=a"]
  );
  assert.equal(api.hasDownloadSourceInHtml(html), true);
});

test("retry status and backoff calculations match the intended policy", () => {
  const api = loadExtension({ random: () => 0 });

  assert.equal(api.shouldRetryStatus(408), true);
  assert.equal(api.shouldRetryStatus(429), true);
  assert.equal(api.shouldRetryStatus(503), true);
  assert.equal(api.shouldRetryStatus(404), false);

  assert.equal(api.retryDelayMs(response({ retryAfter: "2" }), 1), 2000);
  assert.equal(api.retryDelayMs(response({ retryAfter: "999" }), 1), 12000);
  assert.equal(api.retryDelayMs(null, 3), 3200);
});

test("network profile lowers concurrency and extends page timeouts on slow links", () => {
  const fast = loadExtension().getNetworkProfile();
  assert.equal(fast.slow, false);
  assert.equal(fast.pageConcurrency, 64);
  assert.equal(fast.pageFetchTimeoutMs, 60000);

  const slow3g = loadExtension({
    connection: {
      downlink: 0.4,
      effectiveType: "3g",
      rtt: 500,
      saveData: false
    }
  }).getNetworkProfile();
  assert.equal(slow3g.slow, true);
  assert.equal(slow3g.pageConcurrency, 8);
  assert.equal(slow3g.pageFetchTimeoutMs, 180000);

  const saveData = loadExtension({
    connection: {
      effectiveType: "4g",
      saveData: true
    }
  }).getNetworkProfile();
  assert.equal(saveData.slow, true);
});

test("fetchPageBytesWithRetry retries retryable HTTP errors", async () => {
  let calls = 0;
  const api = loadExtension({
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? response({ status: 408, retryAfter: "0" })
        : response({ bytes: Uint8Array.of(7, 8, 9) });
    }
  });

  const bytes = await api.fetchPageBytesWithRetry("https://kazneb.kz/page.png", "https://kazneb.kz/", {
    debug: testDebug(),
    pacer: { waitTurn: async () => {} },
    pageNumber: 1,
    setProgress: () => {},
    signal: new AbortController().signal,
    totalPages: 1,
    workerId: 1
  });

  assert.equal(calls, 2);
  assert.deepEqual([...new Uint8Array(bytes)], [7, 8, 9]);
});

test("429 responses trigger a shared cooldown before retrying", async () => {
  let calls = 0;
  const cooldowns = [];
  const api = loadExtension({
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? response({ status: 429, retryAfter: "0" })
        : response({ bytes: Uint8Array.of(4) });
    }
  });

  await api.fetchPageBytesWithRetry("https://kazneb.kz/page.png", "https://kazneb.kz/", {
    debug: testDebug(),
    pacer: {
      coolDown(ms, context) {
        cooldowns.push({ ms, context });
      },
      waitTurn: async () => {}
    },
    pageNumber: 1,
    setProgress: () => {},
    signal: new AbortController().signal,
    totalPages: 1,
    workerId: 3
  });

  assert.equal(calls, 2);
  assert.equal(cooldowns.length, 1);
  assert.equal(cooldowns[0].ms, 5000);
  assert.equal(cooldowns[0].context.status, 429);
});

test("non-retryable HTTP errors fail without per-request retry", async () => {
  let calls = 0;
  const api = loadExtension({
    fetchImpl: async () => {
      calls += 1;
      return response({ status: 404 });
    }
  });

  await assert.rejects(
    () => api.fetchPageBytesWithRetry("https://kazneb.kz/missing.png", "https://kazneb.kz/", {
      debug: testDebug(),
      pacer: { waitTurn: async () => {} },
      pageNumber: 1,
      setProgress: () => {},
      signal: new AbortController().signal,
      totalPages: 1,
      workerId: 1
    }),
    /HTTP 404/
  );
  assert.equal(calls, 1);
});

test("downloadAllPages retries pages missed in the first pass", async () => {
  const callsByUrl = new Map();
  const urls = [1, 2, 3].map((page) => `https://kazneb.kz/FileStore/book/${String(page).padStart(4, "0")}.png`);
  const api = loadExtension({
    fetchImpl: async (url) => {
      const calls = (callsByUrl.get(url) || 0) + 1;
      callsByUrl.set(url, calls);
      if (url === urls[1] && calls === 1) {
        return response({ status: 404 });
      }
      return response({ bytes: Uint8Array.of(Number(url.match(/(\d+)\.png$/)[1])) });
    }
  });

  const pages = await api.downloadAllPages(
    urls,
    "https://kazneb.kz/",
    () => {},
    new AbortController().signal,
    testDebug()
  );

  assert.equal(pages.length, 3);
  assert.deepEqual(Array.from(pages, (page) => page.url), urls);
  assert.equal(callsByUrl.get(urls[1]), 2);
});

test("downloadAllPages reuses prefetched pages and downloads only missing pages", async () => {
  const urls = [1, 2, 3].map((page) => `https://kazneb.kz/FileStore/book/${String(page).padStart(4, "0")}.png`);
  const calls = [];
  const api = loadExtension({
    fetchImpl: async (url) => {
      calls.push(url);
      return response({ bytes: Uint8Array.of(Number(url.match(/(\d+)\.png$/)[1])) });
    }
  });
  const initialPages = [
    { url: urls[0], bytes: Uint8Array.of(1).buffer },
    null,
    { url: urls[2], bytes: Uint8Array.of(3).buffer }
  ];

  const pages = await api.downloadAllPages(
    urls,
    "https://kazneb.kz/",
    () => {},
    new AbortController().signal,
    testDebug(),
    initialPages
  );

  assert.equal(pages, initialPages);
  assert.deepEqual(calls, [urls[1]]);
  assert.equal(api.countDownloadedPages(pages), 3);
});

test("downloadAllPages can target only the first N pages for approach prefetch", async () => {
  const urls = [1, 2, 3, 4].map((page) => `https://kazneb.kz/FileStore/book/${String(page).padStart(4, "0")}.png`);
  const calls = [];
  const api = loadExtension({
    fetchImpl: async (url) => {
      calls.push(url);
      return response({ bytes: Uint8Array.of(Number(url.match(/(\d+)\.png$/)[1])) });
    }
  });

  const pages = await api.downloadAllPages(
    urls,
    "https://kazneb.kz/",
    () => {},
    new AbortController().signal,
    testDebug(),
    null,
    2
  );

  assert.deepEqual(calls.sort(), urls.slice(0, 2).sort());
  assert.equal(api.countDownloadedPages(pages), 2);
  assert.deepEqual(Array.from(api.missingPageIndexes(pages, 2)), []);
  assert.deepEqual(Array.from(api.missingPageIndexes(pages)), [2, 3]);
});

test("downloadAllPages reuses in-flight page downloads instead of restarting them", async () => {
  const urls = [1, 2].map((page) => `https://kazneb.kz/FileStore/book/${String(page).padStart(4, "0")}.png`);
  const calls = [];
  let resolveInFlight;
  const inFlightPages = [
    null,
    new Promise((resolve) => {
      resolveInFlight = () => resolve({ url: urls[1], bytes: Uint8Array.of(2).buffer });
    })
  ];
  const api = loadExtension({
    fetchImpl: async (url) => {
      calls.push(url);
      return response({ bytes: Uint8Array.of(1) });
    }
  });

  const downloadPromise = api.downloadAllPages(
    urls,
    "https://kazneb.kz/",
    () => {},
    new AbortController().signal,
    testDebug(),
    null,
    null,
    inFlightPages
  );
  resolveInFlight();
  const pages = await downloadPromise;

  assert.deepEqual(calls, [urls[0]]);
  assert.equal(api.countDownloadedPages(pages), 2);
  assert.equal(new Uint8Array(pages[1].bytes)[0], 2);
});

test("downloadAllPages can stop scheduling after a prefetch is claimed", async () => {
  const urls = [1, 2, 3].map((page) => `https://kazneb.kz/FileStore/book/${String(page).padStart(4, "0")}.png`);
  const calls = [];
  const api = loadExtension({
    fetchImpl: async (url) => {
      calls.push(url);
      return response({ bytes: Uint8Array.of(1) });
    }
  });

  const pages = await api.downloadAllPages(
    urls,
    "https://kazneb.kz/",
    () => {},
    new AbortController().signal,
    testDebug(),
    null,
    null,
    null,
    null,
    { shouldStopScheduling: () => true }
  );

  assert.deepEqual(calls, []);
  assert.equal(api.countDownloadedPages(pages), 0);
});

test("claimed prefetch in-flight pages are reused without duplicate fetches", async () => {
  const pageUrls = [1, 2, 3, 4].map((page) => `https://kazneb.kz/FileStore/book/${String(page).padStart(4, "0")}.png`);
  const calls = [];
  const api = loadExtension({
    fetchImpl: async (url) => {
      calls.push(url);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response({ bytes: tinyPngBytes() });
    }
  });
  const manager = api.createHoverPrefetchManager(() => Promise.resolve({
    pageUrls,
    referer: "https://kazneb.kz/ru/bookView/view?brId=1&simple=true"
  }));

  const prefetchPromise = manager.start(2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const prefetched = manager.take();

  const pages = await api.downloadAllPages(
    pageUrls,
    prefetched.referer,
    () => {},
    new AbortController().signal,
    testDebug(),
    prefetched.pages,
    null,
    prefetched.inFlightPages
  );
  await prefetchPromise;

  assert.equal(api.countDownloadedPages(pages), 4);
  assert.equal(calls.length, 4);
  assert.deepEqual(new Set(calls), new Set(pageUrls));
});

test("hover prefetch uses a warmed page list but does not download images before start", async () => {
  const pageUrls = [1, 2].map((page) => `https://kazneb.kz/FileStore/book/${String(page).padStart(4, "0")}.png`);
  const calls = [];
  const api = loadExtension({
    fetchImpl: async (url) => {
      calls.push(url);
      return response({ bytes: tinyPngBytes() });
    }
  });
  const manager = api.createHoverPrefetchManager(() => Promise.resolve({
    pageUrls,
    referer: "https://kazneb.kz/ru/bookView/view?brId=1&simple=true"
  }));

  assert.deepEqual(calls, []);

  await manager.start();
  const prefetched = manager.take();

  assert.deepEqual(calls.sort(), [...pageUrls].sort());
  assert.equal(prefetched.downloaded, 2);
  assert.equal(prefetched.total, 2);
  assert.equal(api.countDownloadedPages(prefetched.pages), 2);
  assert.ok(prefetched.pages[0].pdfPrepared);
});

test("approach prefetch downloads a capped page set and can upgrade to full", async () => {
  const pageUrls = [1, 2, 3, 4].map((page) => `https://kazneb.kz/FileStore/book/${String(page).padStart(4, "0")}.png`);
  const calls = [];
  const api = loadExtension({
    fetchImpl: async (url) => {
      calls.push(url);
      return response({ bytes: tinyPngBytes() });
    }
  });
  const manager = api.createHoverPrefetchManager(() => Promise.resolve({
    pageUrls,
    referer: "https://kazneb.kz/ru/bookView/view?brId=1&simple=true"
  }));

  await manager.start(2);
  let prefetched = manager.take();

  assert.equal(prefetched.downloaded, 2);
  assert.equal(prefetched.total, 4);
  assert.deepEqual(calls.sort(), pageUrls.slice(0, 2).sort());
  assert.ok(prefetched.pages[0].pdfPrepared);

  const manager2 = api.createHoverPrefetchManager(() => Promise.resolve({
    pageUrls,
    referer: "https://kazneb.kz/ru/bookView/view?brId=1&simple=true"
  }));
  calls.length = 0;
  await manager2.start(2);
  await manager2.start();
  prefetched = manager2.take();

  assert.equal(prefetched.downloaded, 4);
  assert.equal(prefetched.total, 4);
  assert.deepEqual(calls.sort(), pageUrls.sort());
});

test("pointer proximity treats nearby cursor positions as download intent", () => {
  const api = loadExtension();
  const element = {
    getBoundingClientRect() {
      return {
        bottom: 140,
        left: 100,
        right: 220,
        top: 100
      };
    }
  };

  assert.equal(api.isPointerNearElement({ clientX: 80, clientY: 120 }, element, 25), true);
  assert.equal(api.isPointerNearElement({ clientX: 246, clientY: 120 }, element, 25), false);
  assert.equal(api.isPointerNearElement({ clientX: 150, clientY: 70 }, element, 35), true);
  assert.equal(api.isPointerNearElement({ clientX: 150, clientY: 64 }, element, 35), false);
  assert.equal(api.isPointerNearElement({ clientX: 150, clientY: 120 }, null, 35), false);
  assert.equal(api.pointerDistanceToElement({ clientX: 50, clientY: 120 }, element), 50);
  assert.equal(
    api.isPointerMovingTowardElement(
      { clientX: 20, clientY: 120 },
      { clientX: 70, clientY: 120 },
      element,
      560,
      18
    ),
    true
  );
  assert.equal(
    api.isPointerMovingTowardElement(
      { clientX: 70, clientY: 120 },
      { clientX: 60, clientY: 120 },
      element,
      560,
      18
    ),
    false
  );
});

test("downloadAllPages reports pages that remain missing after retry passes", async () => {
  const urls = [1, 2].map((page) => `https://kazneb.kz/FileStore/book/${String(page).padStart(4, "0")}.png`);
  const callsByUrl = new Map();
  const api = loadExtension({
    fetchImpl: async (url) => {
      callsByUrl.set(url, (callsByUrl.get(url) || 0) + 1);
      return url === urls[1]
        ? response({ status: 404 })
        : response({ bytes: Uint8Array.of(1) });
    }
  });

  await assert.rejects(
    () => api.downloadAllPages(urls, "https://kazneb.kz/", () => {}, new AbortController().signal, testDebug()),
    /Could not download 1 page after retries: 2/
  );
  assert.equal(callsByUrl.get(urls[1]), 2);
});

test("PDF builder refuses empty or incomplete page sets", () => {
  const api = loadExtension();

  assert.throws(
    () => api.buildPdfFromPngs([], 300, () => {}),
    /No pages were downloaded/
  );
  assert.throws(
    () => api.buildPdfFromPngs([null], 300, () => {}),
    /1 page.*missing/
  );
});

test("PDF compilation keeps the progress bar full after downloads are complete", async () => {
  const api = loadExtension();
  const progresses = [];
  const pdf = api.buildPdfFromPngs(
    [{ url: "https://kazneb.kz/1.png", bytes: tinyPngBytes().buffer }],
    300,
    (percent) => progresses.push(percent)
  );

  assert.equal(pdf.type, "application/pdf");
  assert.ok(pdf.size > 0);
  assert.deepEqual(progresses, [100]);
});
