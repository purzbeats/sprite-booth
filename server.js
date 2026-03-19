import express from "express";
import { readFileSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { WebSocket } from "ws";
import multer from "multer";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const SERVER_API_KEY = process.env.COMFY_CLOUD_API_KEY || "";
const CLOUD_BASE = "https://cloud.comfy.org";

// ── Verbose logging helper ──
function log(tag, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}]`, ...args);
}

// Helper: resolve API key from request header, falling back to server env var
function getApiKey(req) {
  return req.headers["x-comfy-api-key"] || SERVER_API_KEY;
}

if (!SERVER_API_KEY) {
  log("INIT", "No server-side COMFY_CLOUD_API_KEY set — users must provide their own key via the UI");
}

// Load workflow template once at startup
const workflowTemplate = JSON.parse(
  readFileSync(
    "workflow/template_purz_nb2_single_image_sprite_sheet-api.json",
    "utf-8"
  )
);
log("INIT", `Loaded workflow template with ${Object.keys(workflowTemplate).length} nodes`);

// Friendly names for workflow nodes so users see readable progress
const NODE_NAMES = {
  "14": "Loading your photo",
  "98": "Generating sprite sheet with AI",
  "93:37": "Splitting image channels",
  "93:86": "Removing background",
  "93:34": "Calculating frame dimensions",
  "93:33": "Computing grid layout",
  "93:38": "Computing grid layout",
  "93:39": "Computing grid layout",
  "93:41": "Computing grid layout",
  "93:53": "Computing grid layout",
  "93:32": "Cropping frame 1 of 8",
  "93:45": "Cropping frame 2 of 8",
  "93:46": "Cropping frame 3 of 8",
  "93:48": "Cropping frame 4 of 8",
  "93:70": "Cropping frame 5 of 8",
  "93:71": "Cropping frame 6 of 8",
  "93:72": "Cropping frame 7 of 8",
  "93:73": "Cropping frame 8 of 8",
  "93:81": "Batching animation frames",
  "93:65": "Preview",
  "93:66": "Preview",
  "93:67": "Preview",
  "93:68": "Preview",
  "2": "Saving sprite sheet",
  "64": "Saving sprite sheet with transparency",
  "57": "Saving frame 1",
  "58": "Saving frame 2",
  "59": "Saving frame 3",
  "61": "Saving frame 4",
  "74": "Saving frame 5",
  "75": "Saving frame 6",
  "76": "Saving frame 7",
  "77": "Saving frame 8",
  "82": "Encoding GIF animation",
  "87": "Encoding WebP animation",
};

const TOTAL_NODES = Object.keys(workflowTemplate).length;

// Track active jobs for SSE
const activeJobs = new Map();

// Hold input photo buffers in memory until the job completes
const pendingInputs = new Map();

// Create outputs directory at startup
const OUTPUTS_DIR = join(import.meta.dirname, "outputs");
mkdirSync(OUTPUTS_DIR, { recursive: true });
log("INIT", `Outputs directory: ${OUTPUTS_DIR}`);

app.use(express.static("public"));
app.use("/outputs", express.static(OUTPUTS_DIR));
app.use(express.json({ limit: "20mb" }));

// Log all incoming requests
app.use((req, res, next) => {
  log("HTTP", `${req.method} ${req.url}`);
  next();
});

// Upload image to ComfyUI Cloud, then submit the workflow
app.post("/api/generate", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) {
      log("GENERATE", "No photo file in request");
      return res.status(400).json({ error: "No photo provided" });
    }

    const apiKey = getApiKey(req);
    if (!apiKey) {
      return res.status(401).json({ error: "No API key provided. Please add your Comfy Cloud API key in settings." });
    }

    const clientId = randomUUID();
    log("GENERATE", `New job clientId=${clientId}, photo=${req.file.size} bytes`);

    // 1. Upload the image to ComfyUI Cloud
    log("UPLOAD", `Uploading image to ${CLOUD_BASE}/api/upload/image...`);
    const formData = new FormData();
    formData.append(
      "image",
      new Blob([req.file.buffer], { type: req.file.mimetype }),
      "nb2-single_image_sprite_sheet-input.png"
    );

    const uploadRes = await fetch(`${CLOUD_BASE}/api/upload/image`, {
      method: "POST",
      headers: { "X-API-Key": apiKey },
      body: formData,
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      log("UPLOAD", `FAILED ${uploadRes.status}: ${text}`);
      return res.status(502).json({ error: "Failed to upload image to cloud" });
    }

    const uploadData = await uploadRes.json();
    const imageName = uploadData.name;
    log("UPLOAD", `Success! Image name: ${imageName}`);
    log("UPLOAD", `Full response: ${JSON.stringify(uploadData)}`);

    // 2. Build the prompt with the uploaded image name
    const prompt = JSON.parse(JSON.stringify(workflowTemplate));
    prompt["14"].inputs.image = imageName;
    const seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    prompt["98"].inputs.seed = seed;

    // Replace "dancing" with user-provided action
    const action = (req.body?.action || "dancing").trim() || "dancing";
    prompt["98"].inputs.prompt = prompt["98"].inputs.prompt.replace(
      /\n\ndancing$/,
      `\n\n${action}`
    );
    log("PROMPT", `Set image=${imageName}, seed=${seed}, action="${action}"`);

    // 3. Connect WebSocket for real-time progress BEFORE submitting
    const wsUrl = `wss://cloud.comfy.org/ws?clientId=${clientId}&token=***`;
    log("WS", `Connecting WebSocket: ${wsUrl}`);

    const jobState = {
      status: "submitted",
      nodesCompleted: 0,
      currentNode: null,
      currentNodeName: null,
      progress: null,
      events: [],
      listeners: new Set(),
      ws: null,
      promptId: null,
      clientId,
      apiKey,
    };

    const ws = new WebSocket(
      `wss://cloud.comfy.org/ws?clientId=${clientId}&token=${apiKey}`
    );
    jobState.ws = ws;

    ws.on("open", async () => {
      log("WS", `Connected for clientId=${clientId}`);

      // 4. Submit the workflow once WS is connected
      try {
        log("SUBMIT", `Submitting prompt to ${CLOUD_BASE}/api/prompt...`);
        const promptRes = await fetch(`${CLOUD_BASE}/api/prompt`, {
          method: "POST",
          headers: {
            "X-API-Key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt,
            client_id: clientId,
            extra_data: { api_key_comfy_org: apiKey },
          }),
        });

        if (!promptRes.ok) {
          const text = await promptRes.text();
          log("SUBMIT", `FAILED ${promptRes.status}: ${text}`);
          broadcastEvent(jobState, {
            type: "error",
            message: "Failed to submit workflow",
          });
          ws.close();
          return;
        }

        const data = await promptRes.json();
        jobState.promptId = data.prompt_id;
        activeJobs.set(data.prompt_id, jobState);
        log("SUBMIT", `Success! prompt_id=${data.prompt_id}`);
        log("SUBMIT", `Full response: ${JSON.stringify(data)}`);

        broadcastEvent(jobState, {
          type: "submitted",
          prompt_id: data.prompt_id,
        });
      } catch (err) {
        log("SUBMIT", `ERROR: ${err.message}`);
        broadcastEvent(jobState, {
          type: "error",
          message: "Failed to submit workflow",
        });
        ws.close();
      }
    });

    ws.on("message", (raw) => {
      const str = raw.toString();
      try {
        const msg = JSON.parse(str);
        log("WS:MSG", `type=${msg.type} ${JSON.stringify(msg.data || {}).slice(0, 200)}`);
        handleWSMessage(jobState, msg);
      } catch {
        log("WS:MSG", `Non-JSON message: ${str.slice(0, 200)}`);
      }
    });

    ws.on("error", (err) => {
      log("WS", `ERROR: ${err.message}`);
      broadcastEvent(jobState, {
        type: "error",
        message: "Lost connection to cloud",
      });
    });

    ws.on("close", (code, reason) => {
      log("WS", `Closed code=${code} reason=${reason || "none"}`);
      setTimeout(() => {
        if (jobState.promptId) activeJobs.delete(jobState.promptId);
        activeJobs.delete(clientId);
        log("CLEANUP", `Removed job clientId=${clientId}`);
      }, 60000);
    });

    activeJobs.set(clientId, jobState);
    log("GENERATE", `Returning client_id=${clientId} to frontend`);
    res.json({ client_id: clientId });
  } catch (err) {
    log("GENERATE", `UNCAUGHT ERROR: ${err.message}\n${err.stack}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

function handleWSMessage(jobState, msg) {
  const { type, data } = msg;

  switch (type) {
    case "status": {
      const queueRemaining = data?.status?.exec_info?.queue_remaining;
      if (queueRemaining !== undefined) {
        log("JOB", `Queue remaining: ${queueRemaining}`);
        broadcastEvent(jobState, {
          type: "queue",
          queue_remaining: queueRemaining,
        });
      }
      break;
    }

    case "execution_start": {
      jobState.status = "running";
      jobState.nodesCompleted = 0;
      log("JOB", "=== Execution started ===");
      broadcastEvent(jobState, { type: "started" });
      break;
    }

    case "executing": {
      const nodeId = data?.node;
      if (nodeId) {
        jobState.currentNode = nodeId;
        jobState.currentNodeName =
          NODE_NAMES[nodeId] ||
          workflowTemplate[nodeId]?._meta?.title ||
          nodeId;
        jobState.progress = null;
        log(
          "JOB",
          `Executing node ${nodeId}: ${jobState.currentNodeName} (${jobState.nodesCompleted}/${TOTAL_NODES})`
        );
        broadcastEvent(jobState, {
          type: "node_start",
          node_id: nodeId,
          node_name: jobState.currentNodeName,
          nodes_completed: jobState.nodesCompleted,
          nodes_total: TOTAL_NODES,
        });
      } else {
        jobState.status = "completed";
        log("JOB", "=== Execution finished (node=null) ===");
        broadcastEvent(jobState, {
          type: "completed",
          prompt_id: jobState.promptId,
        });
        jobState.ws?.close();
      }
      break;
    }

    case "progress": {
      jobState.progress = { value: data.value, max: data.max };
      log(
        "JOB",
        `Progress: ${data.value}/${data.max} on node ${jobState.currentNode} (${jobState.currentNodeName})`
      );
      broadcastEvent(jobState, {
        type: "progress",
        node_id: jobState.currentNode,
        node_name: jobState.currentNodeName,
        value: data.value,
        max: data.max,
        nodes_completed: jobState.nodesCompleted,
        nodes_total: TOTAL_NODES,
      });
      break;
    }

    case "executed": {
      jobState.nodesCompleted++;
      const nodeId = data?.node;
      const nodeName =
        NODE_NAMES[nodeId] ||
        workflowTemplate[nodeId]?._meta?.title ||
        nodeId;
      log(
        "JOB",
        `Node done: ${nodeId} (${nodeName}) — ${jobState.nodesCompleted}/${TOTAL_NODES}`
      );
      broadcastEvent(jobState, {
        type: "node_done",
        node_id: nodeId,
        node_name: nodeName,
        nodes_completed: jobState.nodesCompleted,
        nodes_total: TOTAL_NODES,
      });
      break;
    }

    case "execution_success": {
      jobState.status = "completed";
      log("JOB", "=== Execution success ===");
      broadcastEvent(jobState, {
        type: "completed",
        prompt_id: jobState.promptId || data?.prompt_id,
      });
      jobState.ws?.close();
      break;
    }

    case "execution_error": {
      jobState.status = "failed";
      log(
        "JOB",
        `!!! Execution ERROR: ${data?.exception_message || "unknown"} at node ${data?.node_id}`
      );
      log("JOB", `Full error data: ${JSON.stringify(data)}`);
      broadcastEvent(jobState, {
        type: "error",
        message: data?.exception_message || "Workflow execution failed",
        node_id: data?.node_id,
        node_name: data?.node_id ? NODE_NAMES[data.node_id] : undefined,
      });
      jobState.ws?.close();
      break;
    }

    case "execution_cached": {
      const cachedNodes = data?.nodes || [];
      jobState.nodesCompleted += cachedNodes.length;
      log(
        "JOB",
        `Cached ${cachedNodes.length} nodes: [${cachedNodes.join(", ")}] — ${jobState.nodesCompleted}/${TOTAL_NODES}`
      );
      broadcastEvent(jobState, {
        type: "cached",
        count: cachedNodes.length,
        nodes_completed: jobState.nodesCompleted,
        nodes_total: TOTAL_NODES,
      });
      break;
    }

    default:
      log("WS:MSG", `Unknown event type: ${type}`);
      broadcastEvent(jobState, { type: "info", message: type, data });
      break;
  }
}

function broadcastEvent(jobState, event) {
  jobState.events.push(event);
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  const listenerCount = jobState.listeners.size;
  for (const res of jobState.listeners) {
    res.write(payload);
  }
  log(
    "SSE",
    `Broadcast ${event.type} to ${listenerCount} listener(s)`
  );
}

// SSE endpoint for real-time progress
app.get("/api/progress/:clientId", (req, res) => {
  const jobState = activeJobs.get(req.params.clientId);
  if (!jobState) {
    log("SSE", `Client ${req.params.clientId} not found in activeJobs (${activeJobs.size} active)`);
    return res.status(404).json({ error: "Job not found" });
  }

  log("SSE", `Client connected for ${req.params.clientId}, replaying ${jobState.events.length} past events`);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  for (const event of jobState.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  jobState.listeners.add(res);
  log("SSE", `Listener count: ${jobState.listeners.size}`);

  req.on("close", () => {
    jobState.listeners.delete(res);
    log("SSE", `Client disconnected, ${jobState.listeners.size} remaining`);
  });
});

// Get job outputs
app.get("/api/history/:promptId", async (req, res) => {
  try {
    const apiKey = getApiKey(req);
    if (!apiKey) return res.status(401).json({ error: "No API key" });

    log("HISTORY", `Fetching history for ${req.params.promptId}`);
    const historyRes = await fetch(
      `${CLOUD_BASE}/api/history_v2/${req.params.promptId}`,
      { headers: { "X-API-Key": apiKey } }
    );
    if (!historyRes.ok) {
      log("HISTORY", `FAILED ${historyRes.status}`);
      return res.status(502).json({ error: "Failed to get history" });
    }
    const raw = await historyRes.json();
    log("HISTORY", `Raw response keys: ${Object.keys(raw)}`);
    // history_v2 nests under the prompt_id key
    const entry = raw[req.params.promptId] || raw;
    const outputs = entry.outputs || {};
    log("HISTORY", `Output node IDs: [${Object.keys(outputs).join(", ")}]`);
    for (const [nid, out] of Object.entries(outputs)) {
      log("HISTORY", `  Node ${nid}: ${JSON.stringify(out).slice(0, 300)}`);
    }
    res.json({ outputs });
  } catch (err) {
    log("HISTORY", `ERROR: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Proxy file downloads (keeps API key server-side)
app.get("/api/view", async (req, res) => {
  try {
    const apiKey = getApiKey(req);
    if (!apiKey) return res.status(401).json({ error: "No API key" });

    const params = new URLSearchParams(req.query);
    log("VIEW", `Fetching file: ${params.toString()}`);
    const viewRes = await fetch(`${CLOUD_BASE}/api/view?${params}`, {
      headers: { "X-API-Key": apiKey },
      redirect: "follow",
    });

    if (!viewRes.ok) {
      log("VIEW", `FAILED ${viewRes.status}`);
      return res.status(502).json({ error: "Failed to fetch file" });
    }

    const contentType = viewRes.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);

    const buffer = Buffer.from(await viewRes.arrayBuffer());
    log("VIEW", `Serving ${buffer.length} bytes (${contentType})`);
    res.send(buffer);
  } catch (err) {
    log("VIEW", `ERROR: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Save input photo to pending map ──
app.post("/api/save-input", upload.single("photo"), (req, res) => {
  const clientId = req.body.client_id;
  if (!clientId || !req.file) {
    return res.status(400).json({ error: "Missing client_id or photo" });
  }
  pendingInputs.set(clientId, req.file.buffer);
  log("SAVE", `Stored input photo for clientId=${clientId} (${req.file.buffer.length} bytes)`);
  res.json({ ok: true });
});

// ── Save outputs to disk ──
app.post("/api/save-outputs/:promptId", express.json(), async (req, res) => {
  const { promptId } = req.params;
  const { clientId } = req.body;
  const dir = join(OUTPUTS_DIR, promptId);
  mkdirSync(dir, { recursive: true });

  // Resolve API key: from job state, request header, or server env
  const jobState = activeJobs.get(clientId) || activeJobs.get(promptId);
  const apiKey = jobState?.apiKey || getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: "No API key" });

  log("SAVE", `Saving outputs for promptId=${promptId}`);

  // Save input photo from pending map
  const inputBuf = pendingInputs.get(clientId);
  if (inputBuf) {
    writeFileSync(join(dir, "input.png"), inputBuf);
    pendingInputs.delete(clientId);
    log("SAVE", `Wrote input.png (${inputBuf.length} bytes)`);
  }

  // Fetch history to get output file references
  try {
    const historyRes = await fetch(
      `${CLOUD_BASE}/api/history_v2/${promptId}`,
      { headers: { "X-API-Key": apiKey } }
    );
    if (!historyRes.ok) {
      log("SAVE", `Failed to fetch history: ${historyRes.status}`);
      return res.status(502).json({ error: "Failed to fetch history" });
    }

    const raw = await historyRes.json();
    const entry = raw[promptId] || raw;
    const outputs = entry.outputs || {};

    const getFile = (nodeId) => {
      const out = outputs[nodeId];
      if (!out) return null;
      if (out.gifs?.length) return out.gifs[0];
      if (out.images?.length) return out.images[0];
      return null;
    };

    const buildCloudUrl = (f) =>
      `${CLOUD_BASE}/api/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder || "")}&type=${encodeURIComponent(f.type || "output")}`;

    const filesToSave = [
      { key: "gif", file: getFile("82"), localName: "sprite-animation.gif" },
      { key: "webp", file: getFile("87"), localName: "sprite-animation.webp" },
      { key: "sheet", file: getFile("64") || getFile("2"), localName: "sprite-sheet.png" },
    ];

    const meta = {
      promptId,
      timestamp: new Date().toISOString(),
      hasInput: !!inputBuf,
      hasGif: false,
      hasWebp: false,
      hasSheet: false,
    };

    for (const { key, file, localName } of filesToSave) {
      if (!file) continue;
      try {
        const url = buildCloudUrl(file);
        const dlRes = await fetch(url, {
          headers: { "X-API-Key": apiKey },
          redirect: "follow",
        });
        if (dlRes.ok) {
          const buf = Buffer.from(await dlRes.arrayBuffer());
          writeFileSync(join(dir, localName), buf);
          meta[`has${key.charAt(0).toUpperCase() + key.slice(1)}`] = true;
          log("SAVE", `Wrote ${localName} (${buf.length} bytes)`);
        }
      } catch (err) {
        log("SAVE", `Failed to download ${localName}: ${err.message}`);
      }
    }

    writeFileSync(join(dir, "metadata.json"), JSON.stringify(meta, null, 2));
    log("SAVE", `Wrote metadata.json for ${promptId}`);
    res.json({ ok: true, dir: `/outputs/${promptId}` });
  } catch (err) {
    log("SAVE", `ERROR: ${err.message}`);
    res.status(500).json({ error: "Failed to save outputs" });
  }
});

// ── Gallery listing ──
app.get("/api/gallery", (req, res) => {
  try {
    const entries = [];
    if (!existsSync(OUTPUTS_DIR)) return res.json([]);

    for (const name of readdirSync(OUTPUTS_DIR, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const metaPath = join(OUTPUTS_DIR, name.name, "metadata.json");
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        entries.push(meta);
      } catch {
        // skip malformed metadata
      }
    }

    // Sort newest first
    entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(entries);
  } catch (err) {
    log("GALLERY", `ERROR: ${err.message}`);
    res.status(500).json({ error: "Failed to list gallery" });
  }
});

// Cancel a running job
app.post("/api/cancel/:clientId", (req, res) => {
  const jobState = activeJobs.get(req.params.clientId);
  if (!jobState) {
    return res.status(404).json({ error: "Job not found" });
  }
  log("CANCEL", `Cancelling job clientId=${req.params.clientId}`);
  broadcastEvent(jobState, { type: "error", message: "Job cancelled" });
  if (jobState.ws) {
    jobState.ws.close();
    jobState.ws = null;
  }
  if (jobState.promptId) activeJobs.delete(jobState.promptId);
  activeJobs.delete(req.params.clientId);
  res.json({ ok: true });
});

// Endpoint to check if a server-side API key is configured
app.get("/api/has-server-key", (req, res) => {
  res.json({ hasKey: !!SERVER_API_KEY });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log("INIT", `Sprite Booth running at http://localhost:${PORT}`);
  if (SERVER_API_KEY) {
    log("INIT", `Server API key: ${SERVER_API_KEY.slice(0, 8)}...${SERVER_API_KEY.slice(-4)}`);
  } else {
    log("INIT", "No server API key — users will need to provide their own");
  }
});
