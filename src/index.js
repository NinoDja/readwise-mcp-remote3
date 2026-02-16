import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import crypto from "crypto";
import { z } from "zod";

// =============================================================================
// CONFIGURACIÓN Y CREDENCIALES
// =============================================================================

const READWISE_API_KEY = process.env.READWISE_API_KEY;
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
const PORT = process.env.PORT || 3000;

// Validar variables requeridas
if (!READWISE_API_KEY) {
  console.error("❌ READWISE_API_KEY environment variable is required");
  process.exit(1);
}

if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
  console.error("❌ OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET are required for security");
  console.error("   Set these in Render environment variables");
  process.exit(1);
}

console.log("✅ Security credentials configured");

// =============================================================================
// ALMACENAMIENTO DE TOKENS (en memoria - se reinicia con el servidor)
// =============================================================================

// Códigos de autorización temporales (válidos 10 minutos)
const authCodes = new Map(); // code -> { clientId, redirectUri, createdAt }

// Access tokens válidos (válidos 24 horas)
const validTokens = new Map(); // token -> { clientId, createdAt }

// Limpiar tokens expirados cada 5 minutos
setInterval(() => {
  const now = Date.now();

  // Limpiar auth codes (10 min)
  for (const [code, data] of authCodes) {
    if (now - data.createdAt > 10 * 60 * 1000) {
      authCodes.delete(code);
    }
  }

  // Limpiar access tokens (24 horas)
  for (const [token, data] of validTokens) {
    if (now - data.createdAt > 24 * 60 * 60 * 1000) {
      validTokens.delete(token);
    }
  }
}, 5 * 60 * 1000);

// =============================================================================
// FUNCIONES DE AUTENTICACIÓN
// =============================================================================

function validateClientCredentials(clientId, clientSecret) {
  return clientId === OAUTH_CLIENT_ID && clientSecret === OAUTH_CLIENT_SECRET;
}

function validateAccessToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  const token = authHeader.slice(7);
  const tokenData = validTokens.get(token);

  if (!tokenData) {
    return false;
  }

  // Verificar que no haya expirado (24 horas)
  if (Date.now() - tokenData.createdAt > 24 * 60 * 60 * 1000) {
    validTokens.delete(token);
    return false;
  }

  return true;
}

// =============================================================================
// READWISE API HELPERS
// =============================================================================

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

// =============================================================================
// MCP SERVER FACTORY
// =============================================================================

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

// =============================================================================
// EXPRESS APP
// =============================================================================

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
app.use(express.urlencoded({ extended: true }));

// =============================================================================
// HEALTH CHECK (público)
// =============================================================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    server: "readwise-mcp-remote",
    version: "1.0.0",
    transport: "streamable-http",
    auth: "oauth2"
  });
});

// =============================================================================
// OAUTH 2.0 ENDPOINTS
// =============================================================================

// Step 1: Authorization - claude.ai redirige aquí
app.get("/authorize", (req, res) => {
  const { client_id, redirect_uri, response_type, state } = req.query;

  console.log(`🔐 OAuth authorize request: client_id=${client_id}`);

  // Validar client_id
  if (client_id !== OAUTH_CLIENT_ID) {
    console.log(`❌ Invalid client_id: ${client_id}`);
    return res.status(401).json({ error: "invalid_client", message: "Invalid client_id" });
  }

  // Generar código de autorización
  const code = crypto.randomUUID();
  authCodes.set(code, {
    clientId: client_id,
    redirectUri: redirect_uri,
    createdAt: Date.now()
  });

  console.log(`✅ Auth code generated for client: ${client_id}`);

  // Redirigir de vuelta a claude.ai con el código
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);

  res.redirect(redirectUrl.toString());
});

// Step 2: Token exchange - claude.ai intercambia código por token
app.post("/token", (req, res) => {
  const { grant_type, code, client_id, client_secret, refresh_token } = req.body;

  console.log(`🔐 OAuth token request: grant_type=${grant_type}`);

  // Validar credenciales del cliente
  if (!validateClientCredentials(client_id, client_secret)) {
    console.log(`❌ Invalid client credentials`);
    return res.status(401).json({ error: "invalid_client", message: "Invalid client credentials" });
  }

  if (grant_type === "authorization_code") {
    // Validar código de autorización
    const authData = authCodes.get(code);
    if (!authData) {
      console.log(`❌ Invalid or expired auth code`);
      return res.status(400).json({ error: "invalid_grant", message: "Invalid or expired authorization code" });
    }

    // Verificar que el client_id coincide
    if (authData.clientId !== client_id) {
      console.log(`❌ Client ID mismatch`);
      return res.status(400).json({ error: "invalid_grant", message: "Client ID mismatch" });
    }

    // Eliminar código usado (solo se puede usar una vez)
    authCodes.delete(code);

  } else if (grant_type === "refresh_token") {
    // Para refresh, solo validamos las credenciales (ya validadas arriba)
    console.log(`🔄 Refreshing token`);
  } else {
    return res.status(400).json({ error: "unsupported_grant_type" });
  }

  // Generar nuevo access token
  const accessToken = crypto.randomUUID();
  const refreshTokenNew = crypto.randomUUID();

  // Almacenar token válido
  validTokens.set(accessToken, {
    clientId: client_id,
    createdAt: Date.now()
  });

  console.log(`✅ Access token issued for client: ${client_id}`);

  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 86400, // 24 horas
    refresh_token: refreshTokenNew
  });
});

// =============================================================================
// MCP ENDPOINT (protegido con Bearer token)
// =============================================================================

app.post("/mcp", async (req, res) => {
  // Validar token de acceso
  if (!validateAccessToken(req.headers.authorization)) {
    console.log(`❌ MCP request rejected: invalid or missing token`);
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: invalid or missing access token" },
      id: null
    });
  }

  console.log("✅ MCP request authenticated");
  console.log("Body:", JSON.stringify(req.body, null, 2));

  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    res.on("close", () => {
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

// GET y DELETE para /mcp
app.get("/mcp", (req, res) => {
  res.status(405).json({ error: "Method not allowed - use POST" });
});

app.delete("/mcp", (req, res) => {
  res.status(405).json({ error: "Method not allowed - stateless server" });
});

// =============================================================================
// OTROS ENDPOINTS
// =============================================================================

// SSE deprecado
app.get("/sse", (req, res) => {
  res.status(410).json({
    error: "SSE transport deprecated",
    message: "Please use /mcp endpoint with POST method"
  });
});

// Root
app.get("/", (req, res) => {
  res.json({
    name: "Readwise MCP Remote",
    version: "1.0.0",
    status: "running",
    transport: "streamable-http",
    auth: "oauth2",
    endpoints: {
      mcp: "/mcp (POST, requires Bearer token)",
      health: "/health",
      oauth: "/authorize, /token"
    }
  });
});

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Readwise MCP Server running on port ${PORT}`);
  console.log(`🔒 OAuth2 authentication ENABLED`);
  console.log(`📡 Transport: Streamable HTTP`);
  console.log(`🎯 MCP endpoint: /mcp`);
});
