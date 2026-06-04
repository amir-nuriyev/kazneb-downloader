const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { TextEncoder } = require("node:util");

const CONTENT_PATH = path.join(
  __dirname,
  "..",
  "dist",
  "kazneb_chrome_extension",
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

function loadExtension({ fetchImpl, random = () => 0 } = {}) {
  const code = fs.readFileSync(CONTENT_PATH, "utf8");
  const location = new URL("https://example.test/ru/catalogue/view/1");
  const document = {
    title: "Fallback title | KazNEB",
    body: createElement("body"),
    documentElement: {
      lang: "",
      outerHTML: ""
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
      userAgent: "node-test"
    },
    setTimeout,
    window: {
      __kaznebDownloaderExposeTestApi: true,
      location
    }
  };
  context.window.document = document;

  vm.createContext(context);
  vm.runInContext(code, context, { filename: CONTENT_PATH });
  return context.window.__kaznebDownloaderTestApi;
}

function response({ status = 200, bytes = Uint8Array.of(1), contentType = "image/png", retryAfter = null } = {}) {
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
      return "";
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
