# Sprite Booth

A photo booth web app that turns you into an animated pixel art sprite sheet using AI.

Snap a photo (or upload one), pick an action like "dancing" or "riding a horse," and Sprite Booth generates an 8-frame pixel art sprite sheet with GIF and WebP animations — powered by [Comfy Cloud](https://cloud.comfy.org).

## Architecture

- **`site/`** — Static frontend (HTML/JS), deployed to Cloudflare Pages
- **`worker/`** — Thin CORS proxy, deployed as a Cloudflare Worker

No backend server needed. The browser connects directly to Comfy Cloud via WebSocket for real-time progress. The worker just proxies REST API calls to avoid CORS restrictions.

## Deploy to Cloudflare

### 1. Deploy the Worker (CORS proxy)

```bash
cd worker
npm install
npx wrangler login        # one-time auth
npx wrangler deploy
```

Note the worker URL it prints (e.g. `https://sprite-booth-proxy.<you>.workers.dev`).

### 2. Set the Worker URL in the site

Edit the `<meta name="worker-url">` tag in `site/index.html`:

```html
<meta name="worker-url" content="https://sprite-booth-proxy.<you>.workers.dev">
```

### 3. Deploy the Site (Cloudflare Pages)

```bash
npx wrangler pages deploy site --project-name sprite-booth
```

### 4. (Optional) Lock down the Worker origin

In `worker/wrangler.toml`, set `ALLOWED_ORIGIN` to your Pages URL:

```toml
[vars]
ALLOWED_ORIGIN = "https://sprite-booth.pages.dev"
```

Then redeploy the worker: `cd worker && npx wrangler deploy`

## Local Development

Run both in separate terminals:

```bash
npm run dev:worker   # starts worker at localhost:8787
npm run dev:site     # starts site at localhost:8788
```

For local dev, update the `<meta name="worker-url">` to `http://localhost:8787`.

## API Key

You need a free [Comfy Cloud](https://platform.comfy.org/login) API key. On first visit, the app prompts you to enter it. The key is stored in your browser's `localStorage` only — never saved to any file or server.

## Features

- Camera capture or file upload
- Custom action prompt (dancing, fighting, running, etc.)
- Real-time progress via direct WebSocket to Comfy Cloud
- 8-frame sprite sheet output (PNG with transparency)
- Animated GIF and WebP exports
- Browser-local gallery (IndexedDB)
- Auto-retry on 120s timeout
- Cancel button during processing

## License

MIT
