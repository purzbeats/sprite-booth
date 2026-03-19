# Changelog

## 2.0.0 — 2026-03-19

### Changed
- Fully client-side architecture — no Express server needed
- Browser connects directly to Comfy Cloud via WebSocket for real-time progress
- Gallery stored in browser IndexedDB instead of server filesystem
- API key stored in browser localStorage only
- Deployed as static site (Cloudflare Pages) + thin CORS proxy (Cloudflare Worker)

### Removed
- Express server (`server.js`)
- Server-side WebSocket bridging and SSE
- Server-side file storage
- Node.js dependencies (express, multer, ws)

## 1.0.0 — 2026-03-19

### Features
- Camera capture and file upload with square crop
- Custom action prompt input (dancing, fighting, running, etc.)
- Real-time progress via Server-Sent Events with activity log
- Pixel art particle effects during processing
- 8-frame sprite sheet output (PNG with transparency)
- Animated GIF and WebP exports
- Local gallery with history of past generations
- User-provided API key via browser UI (stored in localStorage)
- Optional server-side API key via environment variable
- Cancel button during processing
- Auto-retry after 120-second timeout
