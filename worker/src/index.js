const CLOUD_BASE = "https://cloud.comfy.org";

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "*";
  const allowed = env.ALLOWED_ORIGIN || "*";
  // Allow configured origin, localhost for dev, or match any if wildcard
  const isAllowed =
    allowed === "*" ||
    origin === allowed ||
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:");
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Comfy-Api-Key",
    "Access-Control-Max-Age": "86400",
  };
}

function getApiKey(request) {
  return request.headers.get("X-Comfy-Api-Key") || "";
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const apiKey = getApiKey(request);

    if (!apiKey) {
      return new Response(JSON.stringify({ error: "No API key provided" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders(request, env) },
      });
    }

    try {
      let upstream;

      // POST /api/upload/image
      if (path === "/api/upload/image" && request.method === "POST") {
        upstream = await fetch(`${CLOUD_BASE}/api/upload/image`, {
          method: "POST",
          headers: { "X-API-Key": apiKey },
          body: request.body,
          duplex: "half",
        });
      }

      // POST /api/prompt
      else if (path === "/api/prompt" && request.method === "POST") {
        upstream = await fetch(`${CLOUD_BASE}/api/prompt`, {
          method: "POST",
          headers: {
            "X-API-Key": apiKey,
            "Content-Type": "application/json",
          },
          body: request.body,
          duplex: "half",
        });
      }

      // GET /api/history_v2/:id
      else if (path.startsWith("/api/history_v2/") && request.method === "GET") {
        upstream = await fetch(`${CLOUD_BASE}${path}`, {
          headers: { "X-API-Key": apiKey },
        });
      }

      // GET /api/view?...
      else if (path === "/api/view" && request.method === "GET") {
        upstream = await fetch(`${CLOUD_BASE}/api/view${url.search}`, {
          headers: { "X-API-Key": apiKey },
          redirect: "follow",
        });
      }

      // 404
      else {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...corsHeaders(request, env) },
        });
      }

      // Forward upstream response with CORS headers
      const responseHeaders = new Headers(upstream.headers);
      for (const [k, v] of Object.entries(corsHeaders(request, env))) {
        responseHeaders.set(k, v);
      }
      return new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders(request, env) },
      });
    }
  },
};
