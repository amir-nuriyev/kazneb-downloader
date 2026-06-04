# KazNEB Downloader

Tools for downloading KazNEB page-image books into PDFs.

## Chrome Extension

The Chrome extension adds an inline `Download` button to KazNEB catalogue pages.
It discovers the page image URLs exposed by the KazNEB viewer, downloads pages in
parallel with retry/backoff handling, embeds the original PNG streams into a PDF,
and starts one final PDF download.

Install it from Chrome:

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select `dist/kazneb_chrome_extension`.

## Python / Windows Helper

The original Python downloader is available as `kazneb_to_pdf.py`.

The Windows helper package is in `dist/kazneb_downloader_windows` and includes
batch files for installing requirements and running the downloader.

## Tests

Run the extension regression tests with:

```bash
npm test
```

The tests cover URL extraction, retry/backoff behavior, rate-limit cooldowns,
missed-page retry passes, and PDF guard behavior.
