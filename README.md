# Seeker Browser

A Windows web browser built on Chromium (via Electron) with:

- **Full browsing**: tabs (pin, mute, duplicate, drag to reorder, reopen closed, search tabs), sleeping tabs to save RAM, bookmarks bar & manager (import from Chrome/Edge/Firefox), history, session restore, incognito windows, find in page, zoom, print, save page, screenshots, PDF viewer, spell-check, site permissions, ad & tracker blocking, dev tools, unpacked Chrome extensions (partial).
- **Seeker Download Manager** (IDM-style): up to 32 connections per file with dynamic segmentation, pause/resume (also after restart), queue, global and per-file speed limits, scheduler, category folders, clipboard link catching, batch downloads (`file[001-100].jpg`), video/audio grabber incl. HLS (`.m3u8`) streams, refresh expired links, SHA-256 verify, keeps downloading from the tray after you close the window.
- **Tor windows** (`Ctrl+Shift+U`): built-in Tor, `.onion` sites, New identity, Safest mode (JavaScript off), WebRTC leak protection, nothing saved after closing.
- **Gestures**: touchpad two-finger swipe back/forward, pinch zoom, mouse gestures (hold right button and draw), rocker gestures, right-button + wheel to switch tabs, mouse side buttons.
- **AI assistant** (`Ctrl+Shift+Space`, or type `? question` in the address bar): summarise / explain / translate pages and selections. Works with **free** models (Ollama, LM Studio, OpenRouter free models, Groq, Gemini free tier) and **paid** ones (OpenAI, Anthropic Claude, any OpenAI-compatible server). Keys are encrypted with Windows secure storage.
- **Seeker search** (new-tab page and address bar), **no AI**:
  - Searches **DuckDuckGo, Bing, Mojeek and Marginalia** at once and merges the rankings. Mojeek and Marginalia crawl independently, so it reaches small sites and blogs the big engines skip.
  - **Reads the top pages** itself, then summarises them with an extractive summariser (TextRank + BM25 + cross-source agreement + MMR). You get one answer, cited key points, and "✓ confirmed by N sources".
  - Exact answers for dates, numbers, how-to **steps**, **X vs Y** comparison tables, Stack Overflow answers for code, and Wikidata **quick facts**.
  - **Understands everyday English**: fixes shorthand and typos ("whos the cm of punjab", "hw to make choclate cake plz") and suggests spellings from the words in the results. It turns questions like *who is the CM of X / when was X born / who invented X / how old is X* into exact facts, written as proper sentences. Extracted sentences are tidied: "He/It" is replaced with the name, and a/an and punctuation are fixed.
  - **Blogs** tab: independent blogs, Medium/Substack/Blogger/WordPress posts, Hacker News and Reddit, plus a summary of what bloggers say.
  - **`site:anyblog.com topic`** or **Search this site** asks the website directly (WordPress search API, Blogger feed, RSS/Atom, sitemaps). This finds posts no search engine has indexed.
  - **Private page memory**: pages you visit are searchable later, stored only on your PC. It never stores incognito/Tor, login, banking or email pages, and you can switch it off in Settings.
  - News and Images tabs, plus a calculator, units (incl. bigha/kanal/marla), currency, dates ("days until Diwali"-style), weather, time and dictionary.

## Install

Go to **Releases** → download `Seeker-Setup-x.y.z.exe` → run it.
Windows may say *“Windows protected your PC”* because the installer isn't code-signed: click **More info → Run anyway**.

To make it your default browser: Settings → General → **Make default…** and pick Seeker.

## Gestures

| Gesture | Action |
|---|---|
| Two-finger swipe right / left (touchpad) | Back / Forward |
| Pinch, or Ctrl + wheel | Zoom |
| Right-drag ← / → | Back / Forward |
| Right-drag ↑ / ↓ | Scroll to top / bottom |
| Right-drag ↑↓ | Reload |
| Right-drag ↓→ | Close tab |
| Right-drag ↑← | Reopen closed tab |
| Right-drag ↑→ | New tab |
| Right-drag →← / ←→ | Previous / next tab |
| Hold right + click left / hold left + click right | Forward / Back |
| Hold right + wheel, or wheel over the tab strip | Switch tabs |

## Keyboard

Ctrl+T new tab · Ctrl+W close · Ctrl+Shift+T reopen · Ctrl+Tab / Ctrl+1…9 switch · Ctrl+L address bar · Ctrl+F find · Ctrl+D bookmark · Ctrl+Shift+B bookmarks bar · Ctrl+H history · Ctrl+J downloads · Ctrl+N window · Ctrl+Shift+N incognito · Ctrl+Shift+U Tor · Ctrl+Shift+Space AI · Ctrl+Shift+A search tabs · Ctrl+Shift+S screenshot · Ctrl+P print · Ctrl+S save · F11 full screen · F12 dev tools

## Free AI on your own PC

1. Install [Ollama](https://ollama.com) and run `ollama pull llama3.2:3b` (good for 8 GB RAM).
2. In Seeker, open the ✦ AI panel → ⚙ → Provider **Ollama** → pick the model.

## Honest limits

- **Tor**: traffic is routed through Tor, but a Chromium-based browser can't match the official Tor Browser's anti-fingerprinting. Use Tor Browser for high-risk anonymity.
- **Google sign-in** may sometimes warn that the browser “may not be secure” (Google restricts embedded Chromium browsers). Signing in on other sites works normally.
- **Extensions**: unpacked Chrome extensions load with partial support (no toolbar pop-ups). No Chrome Web Store.
- **DRM video** (Netflix etc.) won't play, and protected streams can't be downloaded.
- No built-in password manager or sync yet.

## Build it yourself

```
npm install
npm test
npm start          # run in development
npm run dist       # build the Windows installer into dist/
```

Every push to `main` builds the installer with GitHub Actions (bundling the official, checksum-verified Tor Expert Bundle) and publishes it as a release.
