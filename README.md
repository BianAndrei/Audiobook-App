# Classic Bookshelf

A private, offline ebook reader and AI audiobook narrator with a clean, modern, minimal design. The library has a sidebar and a cover grid; the reader is a full-window, distraction-free page with soft materials, and it follows your Mac's light/dark mode. Narration comes from **Kokoro-82M** running on this Mac, so it works without internet and has no usage limits.

## Start and stop

Click **Bookshelf** in your Dock (see *Mac app* below). Quitting it (**⌘Q**, or closing its window) saves your place and stops the reader and the narrator.

Without the Mac app: double-click **`Start Classic Bookshelf.command`** in Finder to start the narrator and the local server and open Bookshelf; **`Stop Classic Bookshelf.command`** shuts everything down.

Or use the terminal, from this folder:

```sh
./bookshelf start            # starts Kokoro (if needed) + the reader, opens http://localhost:4173
./bookshelf stop             # stops the reader and Kokoro (frees ~1–2 GB of memory)
./bookshelf stop --keep-voice   # stops only the reader
./bookshelf status
```

The app address is **http://localhost:4173**. It is reachable only from this computer.

## Mac app

`./scripts/make-dock-app.sh` builds **`~/Applications/Bookshelf.app`** and pins it to your Dock. It's a small native app (`mac/Bookshelf.swift`, compiled with Apple's command line tools), not a browser window:

- It has its own window, Dock icon, menu bar and **⌘Q**, separate from Chrome.
- Opening it starts the local server and the narrator. The library shows right away, and the narrator dot turns green once Kokoro is ready (about 30 s after a cold start).
- It reopens the book you had open, on the same page. If you were in the library, it opens the library.
- Quitting saves your place, then stops the reader and Kokoro to free memory.

The first time, macOS may ask whether Bookshelf may access your Downloads folder (where this project lives); click **OK**. Run the script again if you move this folder or change `mac/Bookshelf.swift`.

## Install as a Chrome web app (alternative)

1. Start Bookshelf once (above).
2. In **Google Chrome**, click **Install App** at the bottom of the sidebar (or the install icon in the address bar). Bookshelf then appears in your Dock, Launchpad and `~/Applications/Chrome Apps`, with its own window and icon.
   - In **Safari**, use **File → Add to Dock** instead. Safari's web apps keep their own library, so pick one browser and stay with it.
3. From then on, `Start Classic Bookshelf.command` opens the installed app directly.
4. You can open the app even when the server is stopped. Your library and reading still work; narration and the `Books/` folder sync need **Start** first.
5. To open an EPUB, PDF or TXT with Bookshelf from Finder, right-click it → **Open With → Bookshelf** (Chrome-installed app).

Your books stay in this folder's `Books/`. Your place in each book, notes, highlights, reading stats and settings are also saved in `Books/.bookshelf-state.json`, so the Mac app, a browser tab and a fresh install all pick up where you left off.

## Adding books

- Drag EPUB, PDF or TXT files onto the window, or click **Add Books**. A copy goes into the **`Books/`** folder.
- Or copy files into the **`Books/`** folder here. They appear on the shelf automatically the next time the app opens or regains focus.
- EPUB covers and illustrations are extracted. A PDF's first page becomes its cover. Books without art get a clean generated cover with the title.
- PDFs need a text layer. Scanned image-only PDFs must be OCR'd first.

## Library

- **Continue Reading** shows books you're in the middle of. **Resume** opens one where you left off; **Listen** opens it and starts narration straight away.
- The sidebar filters by All Books, Reading Now, Finished, Books, PDFs and Text Files. **Reading Goals** shows your daily ring, streak and weekly stats.
- Search by title or author. Switch between grid and list. The **•••** menu on each book has Listen, Mark as Finished/Unread and Remove.

## Reading

| Action | How |
|---|---|
| Turn pages | ← / →, click a page **corner** (it peels up when you hover), click the left/right margins, or swipe once on the trackpad / one mouse-wheel notch (one swipe = exactly one page) |
| Back to the library | **‹ Library** (top left, always faintly visible) or **Esc** |
| Toolbar | Fades away while you read; move the mouse to bring it back |
| Contents · Bookmarks · Notes | The list or notes button (top left) opens the side panel |
| Search in the book | Magnifier (or ⌘F) |
| Bookmark | Bookmark button (or `B`) |
| Highlight / note | Select text → pick a colour, **Add Note**, **Listen** or **Copy** |
| Appearance (`AA`) | Text size; themes Auto, Original, Paper, Calm, Quiet, Focus, Night; fonts Charter, Iowan, New York, Palatino, Baskerville, Georgia, Garamond, San Francisco; line spacing, margins, scrolling view, justification, page-turn animation |

## Listening (the floating player)

| Action | How |
|---|---|
| Play / pause | ▶ or **Space**. Starts at the top of the page, or at a sentence you clicked |
| Start at a sentence | **Double-click** it, or select text → **Listen** |
| Jump while playing | Click any sentence |
| Previous / next sentence | ⏮ ⏭ or **Shift + ← / →** |
| Voice | Click the voice name; each voice has a ▶ preview |
| Speed | The `1×` button: slider from 0.75× to 2× plus presets |
| Auto page-turn | Book icon. When on, pages turn by themselves as the narrator moves on; when off, a "Return to narration" button appears |

The sentence being read gets a soft amber highlight. The small dot on the voice avatar is green when the Kokoro narrator is running.

## How it works

```
Browser (index.html, js/*)  ──►  server.py :4173  ──►  Kokoro-FastAPI :8880 (Metal GPU)
  IndexedDB: books, covers,        static files, Books/ listing,
  progress, notes, stats           validated /api/tts proxy
```

- **`js/book-parser.js`** turns EPUB (JSZip), PDF (pdf.js) and TXT into chapters of sentences. For PDFs it rebuilds paragraphs, removes running headers, page numbers and footnote markers, and uses the PDF outline for chapters.
- **`js/tts-engine.js`** sends one sentence at a time to Kokoro and keeps 3 sentences ready ahead. It plays them back-to-back on the Web Audio clock with no gaps. Skipping cancels stale requests (`AbortController`). Audio buffers are released after playing, so no object URLs leak.
- **`js/reader-view.js`** paginates with CSS columns: two columns on wide windows, one on narrow ones. Pages slide horizontally when they turn.
- **`js/storage.js`** keeps the library in IndexedDB. **`js/sync.js`** merges reading positions, notes, stats, settings and the open book with `Books/.bookshelf-state.json` (through `/api/state`); the newest change wins.
- All libraries (`vendor/`) and fallback fonts (`assets/fonts/`: EB Garamond, Literata, Inter, all OFL) are bundled, so the app works with no internet. Charter, Iowan, New York, Palatino, Baskerville, Georgia and San Francisco come with macOS.
- The server listens on 127.0.0.1 only, checks the `Host` and `Origin` headers, serves only whitelisted folders, and sends a strict Content-Security-Policy. Book text is never inserted as HTML.

## Where things live

- This folder: the app, your `Books/` (not uploaded to Git), the sample book (`samples/alice.epub`, public domain, Standard Ebooks), and logs in `.run/`.
- The Kokoro engine and model, about 2–3 GB, stay where they were installed: `~/local-ai-book-reader/Kokoro-FastAPI`. They run through the LaunchAgent `local.aibookreader.kokoro`, which also starts at login. Set `KOKORO_DIR` to use a different location.

## Setting up on a new Mac

You need Python 3, Git and an internet connection once; after that everything runs offline. On Apple Silicon:

```sh
git clone https://github.com/BianAndrei/Audiobook-App.git "AudioBook App"

# Kokoro-FastAPI (the narrator), about 2–3 GB including PyTorch
mkdir -p ~/local-ai-book-reader && cd ~/local-ai-book-reader
git clone --branch v0.9.2 --depth 1 https://github.com/remsky/Kokoro-FastAPI.git
python3 -m venv bootstrap && bootstrap/bin/pip install uv
bootstrap/bin/uv python install 3.12
cd Kokoro-FastAPI
../bootstrap/bin/uv venv --python 3.12 .venv
../bootstrap/bin/uv pip install --python .venv/bin/python -e .
.venv/bin/python -c 'from docker.scripts.download_model import download_model; download_model("api/src/models/v1_0")'
```

Then double-click `Start Classic Bookshelf.command`. Without a LaunchAgent, it runs Kokoro through `scripts/start-kokoro.sh` (Metal GPU, offline mode). Use `KOKORO_DIR=/path/to/Kokoro-FastAPI` if you put it elsewhere.

## Troubleshooting

- **No sound, or the narrator dot is red:** run `./bookshelf start` and wait about 15 s. Logs: `~/local-ai-book-reader/kokoro.log` and `.run/`.
- **The app doesn't update after a change:** quit and reopen it; the service worker loads the latest files whenever the server is running.
- **Port in use:** `BOOKSHELF_PORT=4180 ./bookshelf start`.
- **Start over with an empty library:** in the browser, open DevTools → Application → IndexedDB and delete `classic-bookshelf`.
