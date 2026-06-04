#!/usr/bin/env python3
"""
Download page images exposed by a KazNEB book viewer and combine them into a PDF.

This script does not derive or forge access keys. It fetches the catalog/viewer
HTML, extracts the image URLs already embedded there, then downloads those URLs.
Use it only for materials you are allowed to access and save.
"""

from __future__ import annotations

import argparse
import html
import http.cookiejar
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from pathlib import Path


DEFAULT_BASE_URL = "https://kazneb.kz"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
)


class DownloadError(RuntimeError):
    pass


def build_opener() -> urllib.request.OpenerDirector:
    cookie_jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))


def request_headers(referer: str | None = None, accept: str = "*/*") -> dict[str, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": accept,
        "Accept-Language": "ru,en-US;q=0.9,en;q=0.8",
    }
    if referer:
        headers["Referer"] = referer
    return headers


def fetch_text(
    opener: urllib.request.OpenerDirector,
    url: str,
    *,
    referer: str | None = None,
    timeout: float,
) -> str:
    req = urllib.request.Request(
        url,
        headers=request_headers(
            referer,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ),
    )
    with opener.open(req, timeout=timeout) as resp:
        raw = resp.read()
        charset = resp.headers.get_content_charset() or "utf-8"
    return raw.decode(charset, errors="replace")


def read_source(
    opener: urllib.request.OpenerDirector,
    source: str,
    *,
    timeout: float,
) -> tuple[str, str]:
    parsed = urllib.parse.urlparse(source)
    if parsed.scheme in {"http", "https"}:
        return fetch_text(opener, source, timeout=timeout), source

    source_path = Path(source).expanduser()
    text = source_path.read_text(encoding="utf-8", errors="replace")
    return text, DEFAULT_BASE_URL + "/"


def extract_page_urls(text: str, base_url: str) -> list[str]:
    urls: list[str] = []

    for match in re.finditer(r"pages\.push\(\s*(['\"])(.*?)\1\s*\)", text, re.S):
        urls.append(match.group(2))

    if not urls:
        urls.extend(
            re.findall(
                r"['\"]([^'\"]*/FileStore/[^'\"]+\.(?:png|jpe?g|webp)(?:\?[^'\"]*)?)['\"]",
                text,
                re.I,
            )
        )

    seen: set[str] = set()
    normalized: list[str] = []
    for url in urls:
        absolute = urllib.parse.urljoin(base_url, html.unescape(url.strip()))
        if absolute not in seen:
            seen.add(absolute)
            normalized.append(absolute)

    return normalized


def ensure_simple_viewer(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
    query.setdefault("simple", "true")
    return urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(query)))


def extract_viewer_url(text: str, base_url: str) -> str | None:
    candidates: list[str] = []
    for match in re.finditer(r"href\s*=\s*(['\"])(.*?)\1", text, re.I | re.S):
        href = html.unescape(match.group(2).strip())
        if re.search(r"/bookview/view|/bookView/view", href, re.I):
            candidates.append(urllib.parse.urljoin(base_url, href))

    if not candidates:
        return None

    candidates.sort(key=lambda item: ("simple=true" not in item.lower(), len(item)))
    return ensure_simple_viewer(candidates[0])


def page_number_from_url(url: str, fallback: int) -> int:
    name = Path(urllib.parse.urlparse(url).path).stem
    return int(name) if name.isdigit() else fallback


def infer_book_id(source: str, page_urls: list[str]) -> str:
    for value in [source, *page_urls[:1]]:
        for pattern in [
            r"[?&]brId=(\d+)",
            r"/catalogue/view/(\d+)",
            r"/FileStore/dataFiles/[^/]+/[^/]+/(\d+)/",
        ]:
            match = re.search(pattern, value)
            if match:
                return match.group(1)
    return "kazneb"


def content_type_for_path(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".webp":
        return "image/webp"
    return "image/png"


def looks_like_image(path: Path) -> bool:
    if not path.exists() or path.stat().st_size == 0:
        return False
    try:
        with path.open("rb") as handle:
            header = handle.read(16)
    except OSError:
        return False
    return (
        header.startswith(b"\x89PNG\r\n\x1a\n")
        or header.startswith(b"\xff\xd8\xff")
        or header.startswith(b"RIFF")
    )


def download_one(
    opener: urllib.request.OpenerDirector,
    url: str,
    dest: Path,
    *,
    referer: str,
    timeout: float,
) -> None:
    req = urllib.request.Request(
        url,
        headers=request_headers(
            referer,
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        ),
    )
    tmp = dest.with_suffix(dest.suffix + ".part")
    with opener.open(req, timeout=timeout) as resp, tmp.open("wb") as handle:
        status = getattr(resp, "status", 200)
        if status >= 400:
            raise DownloadError(f"HTTP {status} for {url}")
        content_type = resp.headers.get("Content-Type", "")
        if content_type and not content_type.lower().startswith("image/"):
            raise DownloadError(f"Expected image, got {content_type!r} for {url}")
        while True:
            chunk = resp.read(1024 * 128)
            if not chunk:
                break
            handle.write(chunk)

    if not looks_like_image(tmp):
        tmp.unlink(missing_ok=True)
        raise DownloadError(f"Downloaded file does not look like an image: {url}")
    tmp.replace(dest)


def extension_from_url(url: str) -> str:
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    return suffix if suffix in {".png", ".jpg", ".jpeg", ".webp"} else ".png"


def download_pages(
    opener: urllib.request.OpenerDirector,
    page_urls: list[str],
    images_dir: Path,
    *,
    referer: str,
    timeout: float,
    retries: int,
    delay: float,
    overwrite: bool,
) -> list[Path]:
    images_dir.mkdir(parents=True, exist_ok=True)
    width = max(4, len(str(len(page_urls))))
    image_paths: list[Path] = []

    for index, url in enumerate(page_urls, start=1):
        page_no = page_number_from_url(url, index)
        dest = images_dir / f"{page_no:0{width}d}{extension_from_url(url)}"
        image_paths.append(dest)

        if not overwrite and looks_like_image(dest):
            print(f"[{index}/{len(page_urls)}] exists {dest.name}")
            continue

        last_error: Exception | None = None
        for attempt in range(1, retries + 1):
            try:
                download_one(opener, url, dest, referer=referer, timeout=timeout)
                print(f"[{index}/{len(page_urls)}] saved {dest.name}")
                last_error = None
                break
            except (urllib.error.URLError, OSError, DownloadError) as exc:
                last_error = exc
                if attempt < retries:
                    sleep_for = delay * attempt
                    print(
                        f"[{index}/{len(page_urls)}] retry {attempt}/{retries}: {exc}; "
                        f"sleeping {sleep_for:.1f}s",
                        file=sys.stderr,
                    )
                    time.sleep(sleep_for)

        if last_error is not None:
            raise DownloadError(f"Failed to download page {index}: {last_error}") from last_error

        if delay > 0:
            time.sleep(delay)

    return image_paths


def image_to_rgb(path: Path):
    try:
        from PIL import Image
    except ImportError as exc:
        raise SystemExit(
            "Pillow is required to build the PDF. Install it with:\n"
            "  python3 -m pip install Pillow"
        ) from exc

    image = Image.open(path)
    try:
        image.load()
        if image.mode == "RGBA":
            background = Image.new("RGB", image.size, "white")
            background.paste(image, mask=image.getchannel("A"))
            return background
        if image.mode != "RGB":
            return image.convert("RGB")
        return image.copy()
    finally:
        image.close()


def pdf_number(value: float) -> str:
    text = f"{value:.4f}".rstrip("0").rstrip(".")
    return text or "0"


def pdf_stream(dictionary_items: bytes, data: bytes) -> bytes:
    return (
        b"<< "
        + dictionary_items
        + f" /Length {len(data)}".encode("ascii")
        + b" >>\nstream\n"
        + data
        + b"\nendstream"
    )


def image_xobject(path: Path) -> tuple[bytes, int, int]:
    try:
        from PIL import Image
    except ImportError as exc:
        raise SystemExit(
            "Pillow is required to build the PDF. Install it with:\n"
            "  python3 -m pip install Pillow"
        ) from exc

    image = Image.open(path)
    try:
        image.load()
        width, height = image.size

        if image.mode == "P" and "transparency" not in image.info:
            data = image.tobytes()
            hival = max(data) if data else 0
            palette = image.getpalette() or []
            palette_bytes = bytes((palette + [0] * 768)[: 3 * (hival + 1)])
            color_space = (
                b"[/Indexed /DeviceRGB "
                + str(hival).encode("ascii")
                + b" <"
                + palette_bytes.hex().encode("ascii")
                + b">]"
            )
            dictionary = (
                f"/Type /XObject /Subtype /Image /Width {width} /Height {height} "
                f"/ColorSpace ".encode("ascii")
                + color_space
                + b" /BitsPerComponent 8 /Filter /FlateDecode"
            )
            return pdf_stream(dictionary, zlib.compress(data, 9)), width, height

        if image.mode in {"1", "L"}:
            converted = image.convert("L")
            data = converted.tobytes()
            dictionary = (
                f"/Type /XObject /Subtype /Image /Width {width} /Height {height} "
                f"/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode"
            ).encode("ascii")
            return pdf_stream(dictionary, zlib.compress(data, 9)), width, height

        converted = image_to_rgb(path)
        try:
            data = converted.tobytes()
        finally:
            converted.close()
        dictionary = (
            f"/Type /XObject /Subtype /Image /Width {width} /Height {height} "
            f"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode"
        ).encode("ascii")
        return pdf_stream(dictionary, zlib.compress(data, 9)), width, height
    finally:
        image.close()


def write_compact_image_pdf(image_paths: list[Path], output_pdf: Path, *, dpi: int) -> None:
    if not image_paths:
        raise DownloadError("No images to write")

    output_pdf.parent.mkdir(parents=True, exist_ok=True)
    objects: list[bytes | None] = [None, None]
    page_ids: list[int] = []

    for path in image_paths:
        image_obj, width, height = image_xobject(path)
        image_obj_id = len(objects) + 1
        objects.append(image_obj)

        page_width = width * 72.0 / dpi
        page_height = height * 72.0 / dpi
        content = (
            f"q\n{pdf_number(page_width)} 0 0 {pdf_number(page_height)} 0 0 cm\n"
            f"/Im0 Do\nQ\n"
        ).encode("ascii")
        content_obj_id = len(objects) + 1
        objects.append(pdf_stream(b"", content))

        page_obj_id = len(objects) + 1
        page_ids.append(page_obj_id)
        page_obj = (
            f"<< /Type /Page /Parent 2 0 R "
            f"/MediaBox [0 0 {pdf_number(page_width)} {pdf_number(page_height)}] "
            f"/Resources << /XObject << /Im0 {image_obj_id} 0 R >> >> "
            f"/Contents {content_obj_id} 0 R >>"
        ).encode("ascii")
        objects.append(page_obj)

    objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    kids = " ".join(f"{page_id} 0 R" for page_id in page_ids)
    objects[1] = f"<< /Type /Pages /Count {len(page_ids)} /Kids [{kids}] >>".encode(
        "ascii"
    )

    with output_pdf.open("wb") as handle:
        handle.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = [0]
        for object_id, body in enumerate(objects, start=1):
            if body is None:
                raise AssertionError(f"PDF object {object_id} was not populated")
            offsets.append(handle.tell())
            handle.write(f"{object_id} 0 obj\n".encode("ascii"))
            handle.write(body)
            handle.write(b"\nendobj\n")

        xref_offset = handle.tell()
        handle.write(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
        handle.write(b"0000000000 65535 f \n")
        for offset in offsets[1:]:
            handle.write(f"{offset:010d} 00000 n \n".encode("ascii"))
        handle.write(
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n".encode("ascii")
        )


def write_pdf(
    image_paths: list[Path],
    output_pdf: Path,
    *,
    dpi: int,
    quality: int,
    engine: str,
) -> None:
    if engine == "compact":
        write_compact_image_pdf(image_paths, output_pdf, dpi=dpi)
        return

    if not image_paths:
        raise DownloadError("No images to write")

    output_pdf.parent.mkdir(parents=True, exist_ok=True)
    images = [image_to_rgb(path) for path in image_paths]
    first, rest = images[0], images[1:]
    try:
        first.save(
            output_pdf,
            "PDF",
            resolution=float(dpi),
            save_all=True,
            append_images=rest,
            quality=quality,
        )
    finally:
        for image in images:
            image.close()


def resolve_pages(
    opener: urllib.request.OpenerDirector,
    source: str,
    *,
    timeout: float,
) -> tuple[list[str], str]:
    source_html, source_base = read_source(opener, source, timeout=timeout)
    page_urls = extract_page_urls(source_html, source_base)
    if page_urls and re.search(r"pages\.push", source_html):
        return page_urls, source_base

    viewer_url = extract_viewer_url(source_html, source_base)
    if viewer_url:
        viewer_html = fetch_text(opener, viewer_url, referer=source_base, timeout=timeout)
        viewer_page_urls = extract_page_urls(viewer_html, viewer_url)
        if not viewer_page_urls:
            raise DownloadError(f"Found viewer URL but no page images in it: {viewer_url}")
        return viewer_page_urls, viewer_url

    if page_urls:
        return page_urls, source_base

    if not viewer_url:
        raise DownloadError(
            "Could not find embedded page URLs or a KazNEB bookView link in the source."
        )


def slice_pages(page_urls: list[str], start: int | None, end: int | None) -> list[str]:
    if start is None and end is None:
        return page_urls
    start_index = 0 if start is None else max(start - 1, 0)
    end_index = len(page_urls) if end is None else min(end, len(page_urls))
    if start_index >= end_index:
        raise DownloadError("--start/--end selected no pages")
    return page_urls[start_index:end_index]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download KazNEB viewer page images and combine them into a PDF."
    )
    parser.add_argument(
        "source",
        help="KazNEB catalog/viewer URL, or a saved viewer HTML file.",
    )
    parser.add_argument("-o", "--output", help="Output PDF path.")
    parser.add_argument(
        "--work-dir",
        default="output/kazneb",
        help="Directory for downloaded page images. Default: output/kazneb",
    )
    parser.add_argument("--start", type=int, help="First 1-based page to include.")
    parser.add_argument("--end", type=int, help="Last 1-based page to include.")
    parser.add_argument("--delay", type=float, default=0.15, help="Delay between requests.")
    parser.add_argument("--timeout", type=float, default=30.0, help="HTTP timeout in seconds.")
    parser.add_argument("--retries", type=int, default=3, help="Retries per page.")
    parser.add_argument("--dpi", type=int, default=300, help="PDF image DPI metadata.")
    parser.add_argument("--quality", type=int, default=95, help="PDF JPEG quality.")
    parser.add_argument(
        "--pdf-engine",
        choices=["compact", "pillow"],
        default="compact",
        help="PDF writer to use. compact preserves indexed PNG pages efficiently.",
    )
    parser.add_argument("--overwrite", action="store_true", help="Re-download existing images.")
    parser.add_argument("--no-pdf", action="store_true", help="Only download page images.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.retries < 1:
        raise SystemExit("--retries must be at least 1")

    opener = build_opener()
    page_urls, referer = resolve_pages(opener, args.source, timeout=args.timeout)
    page_urls = slice_pages(page_urls, args.start, args.end)

    book_id = infer_book_id(args.source, page_urls)
    work_root = Path(args.work_dir).expanduser()
    images_dir = work_root / book_id / "pages"
    output_pdf = (
        Path(args.output).expanduser()
        if args.output
        else work_root / book_id / f"{book_id}.pdf"
    )

    print(f"Found {len(page_urls)} page image URLs")
    print(f"Saving images to {images_dir}")
    image_paths = download_pages(
        opener,
        page_urls,
        images_dir,
        referer=referer,
        timeout=args.timeout,
        retries=args.retries,
        delay=args.delay,
        overwrite=args.overwrite,
    )

    if args.no_pdf:
        print("Skipped PDF creation")
        return 0

    print(f"Writing PDF to {output_pdf}")
    write_pdf(
        image_paths,
        output_pdf,
        dpi=args.dpi,
        quality=args.quality,
        engine=args.pdf_engine,
    )
    size_mb = output_pdf.stat().st_size / (1024 * 1024)
    print(f"Done: {output_pdf} ({size_mb:.1f} MB)")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit("\nInterrupted")
    except DownloadError as exc:
        raise SystemExit(f"error: {exc}")
