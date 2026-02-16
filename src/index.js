import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
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

const app = express();
const transports = {};

app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "readwise-mcp-remote", version: "1.0.0" });
});

app.get("/sse", async (req, res) => {
  console.log("New SSE connection");
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => {
    console.log(`SSE closed: ${transport.sessionId}`);
    delete transports[transport.sessionId];
  });
  await server.connect(transport);
});

app.post("/messages", express.json(), async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(404).json({ error: "Session not found" });
  await transport.handlePostMessage(req, res);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Readwise MCP Server running on port ${PORT}`);
});
