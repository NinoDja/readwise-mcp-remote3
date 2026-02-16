import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import crypto from "crypto";
import { z } from "zod";

const READWISE_API_KEY = process.env.READWISE_API_KEY;
const PORT = process.env.PORT || 3000;

if (!READWISE_API_KEY) {
  console.error("READWISE_API_KEY environment variable is required");
  process.exit(1);
}

const READWISE_BASE = "https://readwise.io/api/v2";
const READER_BASE = "https://readwise.io/api/v3";

async function readwiseV2(endpoint, params = {}) {
  const url = new URL(`${READWISE_BASE}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Token ${READWISE_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Readwise API error: ${res.status} ${await res.text()}`);
  return res.json();
}

async function readerV3(endpoint, params = {}, method = "GET", body = null) {
  const url = new URL(`${READER_BASE}${endpoint}`);
  if (method === "GET") {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });
  }
  const opts = {
    method,
    headers: {
      Authorization: `Token ${READWISE_API_KEY}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url.toString(), opts);
  if (!res.ok) throw new Error(`Reader API error: ${res.status} ${await res.text()}`);
  return res.json();
}

function createMcpServer() {
  const server = new McpServer({ name: "readwise-remote", version: "1.0.0" });

  server.tool("get_books", "Get books and sources from Readwise library", {
    page: z.number().optional(),
    page_size: z.number().optional(),
    category: z.string().optional(),
    source: z.string().optional(),
  }, async ({ page, page_size, category, source }) => {
    const data = await readwiseV2("/books/", { page, page_size, category, source });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("get_highlights", "Get highlights from Readwise", {
    page: z.number().optional(),
    page_size: z.number().optional(),
    book_id: z.number().optional(),
    search: z.string().optional(),
  }, async ({ page, page_size, book_id, search }) => {
    const data = await readwiseV2("/highlights/", { page, page_size, book_id, search });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("get_documents", "List documents from Readwise Reader", {
    location: z.enum(["new", "later", "shortlist", "archive", "feed"]).optional(),
    category: z.string().optional(),
    updatedAfter: z.string().optional(),
    pageCursor: z.string().optional(),
  }, async ({ location, category, updatedAfter, pageCursor }) => {
    const params = {};
    if (location) params.location = location;
    if (category) params.category = category;
    if (updatedAfter) params.updatedAfter = updatedAfter;
    if (pageCursor) params.pageCursor = pageCursor;
    const data = await readerV3("/list/", params);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("save_document", "Save a URL to Readwise Reader", {
    url: z.string(),
    title: z.string().optional(),
    author: z.string().optional(),
    summary: z.string().optional(),
    tags: z.array(z.string()).optional(),
    location: z.enum(["new", "later", "shortlist", "archive", "feed"]).optional(),
    notes: z.string().optional(),
  }, async (args) => {
    const data = await readerV3("/save/", {}, "POST", args);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("search_highlights", "Search through all highlights", {
    query: z.string(),
    page: z.number().optional(),
    page_size: z.number().optional(),
  }, async ({ query, page, page_size }) => {
    const data = await readwiseV2("/highlights/", { search: query, page, page_size });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("get_daily_review", "Get daily review highlights", {}, async () => {
    const data = await readwiseV2("/review/");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("export_highlights", "Export all highlights", {
    updatedAfter: z.string().optional(),
    ids: z.string().optional(),
    pageCursor: z.string().optional(),
  }, async ({ updatedAfter, ids, pageCursor }) => {
    const data = await readwiseV2("/export/", { updatedAfter, ids, pageCursor });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("get_document_by_id", "Get a specific Reader document by ID", {
    id: z.string(),
  }, async ({ id }) => {
    const data = await readerV3("/list/", { id });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("get_tags", "Get all tags from Readwise", {}, async () => {
    const data = await readwiseV2("/tags/");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool("create_highlight", "Create highlights in Readwise", {
    highlights: z.array(z.object({
      text: z.string(),
      title: z.string().optional(),
      source_url: z.string().optional(),
      author: z.string().optional(),
      note: z.string().optional(),
    })),
  }, async ({ highlights }) => {
    const res = await fetch(`${READWISE_BASE}/highlights/`, {
      method: "POST",
      headers: { Authorization: `Token ${READWISE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ highlights }),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  return server;
}

const app = express();

// CORS middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Mcp-Session-Id");
  res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "readwise-mcp-remote", version: "1.0.0", transport: "streamable-http" });
});

// OAuth endpoints for claude.ai compatibility
app.get("/authorize", (req, res) => {
  const { redirect_uri, state } = req.query;
  console.log(`OAuth authorize: redirect_uri=${redirect_uri}`);
  const code = crypto.randomUUID();
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);
  res.redirect(redirectUrl.toString());
});

app.post("/token", (req, res) => {
  console.log(`OAuth token request`);
  res.json({
    access_token: crypto.randomUUID(),
    token_type: "Bearer",
    expires_in: 86400,
    refresh_token: crypto.randomUUID(),
  });
});

// Streamable HTTP MCP endpoint
app.post("/mcp", async (req, res) => {
  console.log("MCP POST request received");
  console.log("Body:", JSON.stringify(req.body, null, 2));

  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    res.on("close", () => {
      console.log("MCP connection closed");
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET endpoint for server-initiated messages (optional)
app.get("/mcp", async (req, res) => {
  console.log("MCP GET request received");
  res.status(405).json({ error: "Method not allowed - use POST" });
});

// DELETE endpoint for session termination
app.delete("/mcp", async (req, res) => {
  console.log("MCP DELETE request received");
  res.status(405).json({ error: "Method not allowed - stateless server" });
});

// Keep SSE endpoint for backwards compatibility
app.get("/sse", (req, res) => {
  console.log("SSE endpoint hit - redirecting to use /mcp with POST");
  res.status(410).json({
    error: "SSE transport deprecated",
    message: "Please use /mcp endpoint with POST method (Streamable HTTP transport)"
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    name: "Readwise MCP Remote",
    version: "1.0.0",
    status: "running",
    transport: "streamable-http",
    endpoints: {
      mcp: "/mcp (POST)",
      health: "/health",
      oauth: "/authorize, /token"
    }
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Readwise MCP Server running on port ${PORT}`);
  console.log(`Transport: Streamable HTTP`);
  console.log(`MCP endpoint: /mcp`);
});
