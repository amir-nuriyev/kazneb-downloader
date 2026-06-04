#!/usr/bin/env node
"use strict";

const { performance } = require("node:perf_hooks");

const BOOK_IDS = ["1104863", "1571396"];
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
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
    const absolute = new URL(decodeHtml(url), baseUrl).href;
    if (!seen.has(absolute)) {
      seen.add(absolute);
      normalized.push(absolute);
    }
  }
  return normalized;
}

function extractViewerUrl(html, baseUrl, bookId) {
  const linkPattern = /<a[^>]+href=(['"])([^'"]*\/bookView\/view[^'"]*)\1/i;
  const match = linkPattern.exec(html) || /<a[^>]+href=(['"])([^'"]*\/bookview\/view[^'"]*)\1/i.exec(html);
  if (match) {
    const viewerUrl = new URL(decodeHtml(match[2]), baseUrl);
    if (!viewerUrl.searchParams.has("simple")) {
      viewerUrl.searchParams.set("simple", "true");
    }
    return viewerUrl.href;
  }

  return new URL(`/ru/bookView/view?brId=${bookId}&simple=true`, "https://kazneb.kz").href;
}

async function fetchText(url, referer) {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      referer
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }
  return response.text();
}

async function resolveBook(bookId) {
  const catalogueUrl = `https://kazneb.kz/ru/catalogue/view/${bookId}`;
  const startedAt = performance.now();
  const catalogueHtml = await fetchText(catalogueUrl, "https://kazneb.kz/");
  const viewerUrl = extractViewerUrl(catalogueHtml, catalogueUrl, bookId);
  const viewerHtml = await fetchText(viewerUrl, catalogueUrl);
  const pageUrls = extractPageUrls(viewerHtml, viewerUrl);
  const elapsedMs = performance.now() - startedAt;
  if (!pageUrls.length) {
    throw new Error(`No page URLs found for ${bookId}`);
  }
  return {
    bookId,
    catalogueUrl,
    elapsedMs,
    pageUrls,
    viewerUrl
  };
}

async function delay(ms) {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadBook(book, options) {
  const { concurrency, startSpacingMs } = options;
  const startedAt = performance.now();
  let cursor = 0;
  let startGate = Promise.resolve();
  let nextStartAt = 0;
  let completed = 0;
  let bytes = 0;
  let failures = 0;

  async function waitForStartSlot() {
    const run = startGate.then(async () => {
      const now = performance.now();
      const waitMs = Math.max(0, nextStartAt - now);
      await delay(waitMs);
      nextStartAt = performance.now() + startSpacingMs;
    });
    startGate = run.catch(() => {});
    return run;
  }

  async function worker() {
    while (cursor < book.pageUrls.length) {
      const index = cursor;
      cursor += 1;
      await waitForStartSlot();
      const url = book.pageUrls[index];
      try {
        const response = await fetch(url, {
          headers: {
            "user-agent": USER_AGENT,
            referer: book.viewerUrl
          }
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        bytes += arrayBuffer.byteLength;
        completed += 1;
      } catch (error) {
        failures += 1;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, book.pageUrls.length) }, () => worker())
  );

  const elapsedMs = performance.now() - startedAt;
  return {
    bookId: book.bookId,
    bytes,
    completed,
    concurrency,
    elapsedMs,
    failures,
    pages: book.pageUrls.length,
    startSpacingMs
  };
}

function parseVariants() {
  const argument = process.argv.find((item) => item.startsWith("--variants="));
  const raw = argument
    ? argument.split("=")[1]
    : "32:10,64:0,96:0,128:0,192:0";

  return raw.split(",").map((entry) => {
    const [concurrency, startSpacingMs = "0"] = entry.split(":");
    return {
      concurrency: Number(concurrency),
      startSpacingMs: Number(startSpacingMs)
    };
  });
}

function mb(value) {
  return value / (1024 * 1024);
}

function printResult(result) {
  const seconds = result.elapsedMs / 1000;
  const throughput = result.bytes / seconds;
  console.log(
    [
      `book=${result.bookId}`,
      `pages=${result.completed}/${result.pages}`,
      `bytes=${result.bytes}`,
      `MiB=${mb(result.bytes).toFixed(2)}`,
      `concurrency=${result.concurrency}`,
      `spacingMs=${result.startSpacingMs}`,
      `downloadMs=${result.elapsedMs.toFixed(1)}`,
      `seconds=${seconds.toFixed(3)}`,
      `MiBps=${mb(throughput).toFixed(2)}`,
      `failures=${result.failures}`
    ].join(" ")
  );
}

async function main() {
  const variants = parseVariants();
  const resolveStartedAt = performance.now();
  const books = [];
  for (const bookId of BOOK_IDS) {
    const book = await resolveBook(bookId);
    books.push(book);
    console.log(
      `resolved book=${book.bookId} pages=${book.pageUrls.length} resolveMs=${book.elapsedMs.toFixed(1)} viewer=${book.viewerUrl}`
    );
  }
  console.log(`resolveTotalMs=${(performance.now() - resolveStartedAt).toFixed(1)}`);

  for (const variant of variants) {
    console.log(`\nvariant concurrency=${variant.concurrency} spacingMs=${variant.startSpacingMs}`);
    const variantStartedAt = performance.now();
    let totalBytes = 0;
    let totalPages = 0;
    let totalFailures = 0;
    for (const book of books) {
      const result = await downloadBook(book, variant);
      totalBytes += result.bytes;
      totalPages += result.completed;
      totalFailures += result.failures;
      printResult(result);
      await delay(750);
    }
    const elapsedMs = performance.now() - variantStartedAt;
    console.log(
      [
        `variantTotal concurrency=${variant.concurrency}`,
        `spacingMs=${variant.startSpacingMs}`,
        `pages=${totalPages}`,
        `bytes=${totalBytes}`,
        `MiB=${mb(totalBytes).toFixed(2)}`,
        `elapsedMs=${elapsedMs.toFixed(1)}`,
        `seconds=${(elapsedMs / 1000).toFixed(3)}`,
        `MiBps=${mb(totalBytes / (elapsedMs / 1000)).toFixed(2)}`,
        `failures=${totalFailures}`
      ].join(" ")
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
