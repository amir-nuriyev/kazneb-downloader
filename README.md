# KazNEB Chrome Extension

The Chrome extension adds an inline `Download` button to KazNEB catalogue pages.
It discovers the page image URLs exposed by the KazNEB viewer, downloads pages in
parallel with retry/backoff handling, embeds the original PNG streams into a PDF,
and starts one final PDF download.

Generated PDFs are built only from viewer page images. Native `full.pdf` links
are not used because they are slower; if KazNEB shows only a native PDF button,
the extension leaves it as the site's own download. Cover images such as
`bigcover.png` are not treated as downloadable book pages.

The extension may warm the viewer page list when the button is inserted, but it
does not prefetch page image bytes until the user hovers over, or moves the
pointer near, the injected download button.

Pointer intent has two stages: movement toward the button prefetches the first
20 pages, while hovering or moving very close upgrades that same cache to the
full book. Click-time downloads reuse completed and in-flight prefetch requests,
and prefetched pages have their PDF objects prepared before the final click.
The extension also adds same-origin preconnect hints for the page-image requests.
On slow reported connections such as 3G, it automatically lowers page-image
parallelism and extends page-image request timeouts so Chrome throttling does
not cause queued requests to abort and restart repeatedly.
When the user clicks during prefetch, the visible download claims the prefetch
cache, reuses in-flight page requests, and stops the background prefetch
scheduler from starting competing work.

## Install From Releases

1. Download `kazneb-chrome-extension-vX.Y.Z.zip` from the latest GitHub release.
2. Unzip it.
3. Open Chrome and go to `chrome://extensions`.
4. Enable `Developer mode`.
5. Click `Load unpacked`.
6. Select the unzipped `kazneb_chrome_extension` folder.

## Source Install

You can also load the extension directly from this repository by selecting the
repository root in Chrome's `Load unpacked` picker.

## Tests

Run the extension regression tests with:

```bash
npm test
```

The tests cover URL extraction, retry/backoff behavior, rate-limit cooldowns,
missed-page retry passes, and PDF guard behavior.

## Benchmarking

Benchmark the real KazNEB page-image downloads for the current test books:

```bash
npm run benchmark
```

The benchmark reports page counts, bytes, exact elapsed download time, and
throughput for configurable concurrency/pacing variants.

## Release Packaging

Pushing a tag such as `v1.0.14` runs the release workflow. It validates the
extension, creates a zip containing the `kazneb_chrome_extension` folder, and
uploads that zip to the GitHub release.
