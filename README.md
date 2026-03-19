# Sprite Booth

A photo booth web app that turns you into an animated pixel art sprite sheet using AI.

Snap a photo (or upload one), pick an action like "dancing" or "riding a horse," and Sprite Booth generates an 8-frame pixel art sprite sheet with GIF and WebP animations — all powered by [Comfy Cloud](https://cloud.comfy.org).

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## API Key Setup

Sprite Booth uses [Comfy Cloud](https://platform.comfy.org/login) for AI image generation. You'll need a free API key.

**Option A — Browser (recommended):**
On first visit, the app will prompt you to enter your API key. It's stored in your browser's `localStorage` only — never saved to any file or sent anywhere except Comfy Cloud.

**Option B — Environment variable:**
Copy `.env.example` to `.env` and add your key:

```bash
cp .env.example .env
# Edit .env and add your key
```

## Features

- Camera capture or file upload
- Custom action prompt (dancing, fighting, running, etc.)
- Real-time progress tracking with pixel art particle effects
- 8-frame sprite sheet output (PNG with transparency)
- Animated GIF and WebP exports
- Local generation history/gallery
- Auto-retry on timeout (120s)
- API key stored safely in browser localStorage

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** Vanilla JS (no framework)
- **AI:** Comfy Cloud (ComfyUI workflow)
- **Styling:** Pixel art theme with Press Start 2P font

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start the server |
| `npm run dev` | Start with auto-reload (--watch) |

## License

MIT
