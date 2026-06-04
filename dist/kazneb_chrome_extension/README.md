# KazNEB Downloader Chrome Extension

Adds an inline **Download** button next to KazNEB's existing **View** and
**3D View** buttons. It finds the page image URLs already exposed by the KazNEB
viewer, keeps the page images internal while it works, and creates a compact
PDF.

The button label follows KazNEB's active language:
`Download`, `Скачать`, `Жүктеу`, or `Jukteu`.

When KazNEB already provides an official `full.pdf` download button, this
extension hides the official button and leaves its own generated-PDF button in
place. On Kazakh Latin pages it still fixes the official button label from
`Download` to `Jukteu` before hiding it.

If a catalogue page has no viewer, no native PDF, and no numeric page image
URLs, the extension does not add a download button. Cover images such as
`bigcover.png` do not count as book pages.

## Install

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `kazneb_chrome_extension` folder.

## Use

1. Open a KazNEB catalogue page, for example:
   `https://kazneb.kz/ru/catalogue/view/1658804`
2. Click **Download** beside the existing **View** and **3D View** buttons.
3. Watch the progress text:
   - `Finding pages...`
   - `Downloading pages 42/178...`
   - `Compiling PDF...`

The progress bar is removed from the page after the download starts or
immediately after you cancel, so the KazNEB button row snaps back to its
original layout.

The extension does not save intermediate page files. Chrome shows one final
download for the compiled PDF. If Chrome is configured to ask where to save
downloads, it will show the normal Save As prompt.

It should not trigger Chrome's "allow multiple downloads" prompt because it
does not start one download per page. It makes a single final PDF download.

The generated PDF filename uses KazNEB's book title. If the title cannot be
found, the extension falls back to the numeric book ID.

## Failure handling

- Click the button again while it is running to cancel the current download.
- Page images download with up to 32 parallel workers.
- New page requests are lightly paced instead of all starting at once.
- Each page request has a 30 second timeout.
- Page downloads retry transient failures up to 4 times.
- `408`, `425`, `429`, `500`, `502`, `503`, and `504` responses are retried.
- `Retry-After` is respected when the server sends it; otherwise retries use
  exponential backoff with jitter.
- `429`, `503`, and `504` responses also trigger a shared cooldown before more
  page requests start.
- After the first pass, missing pages get another retry pass. The PDF is not
  created unless every page was downloaded.
- The PDF compiler refuses to create a 0-page PDF.
- If a failure occurs, the extension shows a **Copy debug** button with page
  discovery, retry, and error details.
- If the tab is closed or reloaded, Chrome clears the page memory and the run
  must be started again. There is no persistent resume because no intermediate
  files are written.

## Notes

- The extension does not guess or generate KazNEB access keys.
- Chrome does not allow extensions to write into their own installed extension
  folder at runtime, so intermediate pages stay in browser memory instead.
- It embeds the original PNG image streams into the PDF where possible, so the
  PDF should stay close to the source image size and should not blur the scans.
