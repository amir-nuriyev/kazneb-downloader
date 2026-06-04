KazNEB Downloader for Windows
=============================

What this does
--------------
This downloads page images that are already exposed by a KazNEB book viewer and
combines them into a compact PDF. It does not create or guess KazNEB access
keys.

Requirements
------------
Windows with Python 3.10 or newer installed.

If Python is not installed:
1. Download it from https://www.python.org/downloads/windows/
2. During install, tick "Add python.exe to PATH".
3. Then run install_windows.bat again.

First-time setup
----------------
Double-click:

    install_windows.bat

This creates a local .venv folder and installs the required Python library:

    Pillow

Normal use
----------
Double-click:

    run_download.bat

Paste a KazNEB catalog URL such as:

    https://kazneb.kz/ru/catalogue/view/1658804

For the sample item already discussed, double-click:

    download_1658804.bat

Images only
-----------
To download the page images without creating a PDF, double-click:

    run_download_images_only.bat

Output
------
Downloaded page images and PDFs are written under:

    output\kazneb\<book_id>\

For example:

    output\kazneb\1658804\1658804.pdf

Resume behavior
---------------
If the download is interrupted, run the same command again. Existing downloaded
page images are reused.

Command-line use
----------------
After installing, this also works from Command Prompt:

    .venv\Scripts\python.exe kazneb_to_pdf.py "https://kazneb.kz/ru/catalogue/view/1658804"

Useful options:

    --start 1 --end 10       Download only pages 1 through 10
    --no-pdf                 Download images only
    --overwrite              Re-download existing images
    -o my_book.pdf           Choose an output PDF path
