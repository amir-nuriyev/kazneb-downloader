# KazNEB Chrome Extension

The Chrome extension adds an inline `Download` button to KazNEB catalogue pages.
It discovers the page image URLs exposed by the KazNEB viewer, downloads pages in
parallel with retry/backoff handling, embeds the original PNG streams into a PDF,
and starts one final PDF download.

## Install From Releases

1. Download `kazneb-chrome-extension-vX.Y.Z.zip` from the latest GitHub release.
2. Unzip it.
3. Open Chrome and go to `chrome://extensions`.
4. Enable `Developer mode`.
5. Click `Load unpacked`.
6. Select the unzipped `kazneb_chrome_extension` folder.

## Source Install

You can also load the extension directly from this repository by selecting
`dist/kazneb_chrome_extension` in Chrome's `Load unpacked` picker.

## Tests

Run the extension regression tests with:

```bash
npm test
```

The tests cover URL extraction, retry/backoff behavior, rate-limit cooldowns,
missed-page retry passes, and PDF guard behavior.

## Release Packaging

Pushing a tag such as `v1.0.14` runs the release workflow. It validates the
extension, creates a zip containing the `kazneb_chrome_extension` folder, and
uploads that zip to the GitHub release.
