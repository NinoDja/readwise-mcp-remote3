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

if (!READWISE_API_KEY) {
  console.error("❌ READWISE_API_KEY environment variable is required");
  process.exit(1);
}

if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
  console.error("❌ OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET are required");
  process.exit(1);
}

console.log("✅ Credentials configured");

// =============================================================================
// AUTENTICACIÓN OAUTH
// =============================================================================

const authCodes = new Map();
const validTokens = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [code, data] of authCodes) {
    if (now - data.createdAt > 10 * 60 * 1000) authCodes.delete(code);
  }
  for (const [token, data] of validTokens) {
    if (now - data.createdAt > 24 * 60 * 60 * 1000) validTokens.delete(token);
  }
}, 5 * 60 * 1000);

function validateCredentials(clientId, clientSecret) {
  return clientId === OAUTH_CLIENT_ID && clientSecret === OAUTH_CLIENT_SECRET;
}

function validateToken(authHeader) {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  const data = validTokens.get(token);
  if (!data) return false;
  if (Date.now() - data.createdAt > 24 * 60 * 60 * 1000) {
    validTokens.delete(token);
    return false;
  }
  return true;
}

// =============================================================================
// READWISE API HELPERS
// =============================================================================

const READWISE_V2 = "https://readwise.io/api/v2";
const READWISE_V3 = "https://readwise.io/api/v3";

async function apiV2(endpoint, options = {}) {
  const { method = "GET", params = {}, body = null } = options;

  const url = new URL(`${READWISE_V2}${endpoint}`);
  if (method === "GET") {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
  }

  const opts = {
    method,
    headers: {
      Authorization: `Token ${READWISE_API_KEY}`,
      "Content-Type": "application/json",
    },
  };

  if (body && method !== "GET") {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url.toString(), opts);

  if (res.status === 204) return { success: true };
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Readwise v2 API error: ${res.status} ${text}`);
  }

  return res.json();
}

async function apiV3(endpoint, options = {}) {
  const { method = "GET", params = {}, body = null } = options;

  const url = new URL(`${READWISE_V3}${endpoint}`);
  if (method === "GET") {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
  }

  const opts = {
    method,
    headers: {
      Authorization: `Token ${READWISE_API_KEY}`,
      "Content-Type": "application/json",
    },
  };

  if (body && method !== "GET") {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url.toString(), opts);

  if (res.status === 204) return { success: true };
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Readwise v3 API error: ${res.status} ${text}`);
  }

  return res.json();
}

// =============================================================================
// MCP SERVER CON 33 TOOLS
// =============================================================================

function createMcpServer() {
  const server = new McpServer({
    name: "readwise-mcp-enhanced",
    version: "2.1.0"
  });

  // ===========================================================================
  // HIGHLIGHTS - 11 tools
  // ===========================================================================

  // 1. get_highlights
  server.tool("get_highlights", "Retrieve highlights from your Readwise library with optional filtering", {
    page: z.number().optional().describe("Page number for pagination"),
    page_size: z.number().optional().describe("Number of results per page (max 1000)"),
    book_id: z.number().optional().describe("Filter by specific book ID"),
    updated__gt: z.string().optional().describe("Filter highlights updated after this date (ISO 8601)"),
    updated__lt: z.string().optional().describe("Filter highlights updated before this date (ISO 8601)"),
  }, async (params) => {
    const data = await apiV2("/highlights/", { params });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 2. search_highlights
  server.tool("search_highlights", "Search for highlights in your Readwise library by keyword", {
    query: z.string().describe("Search query"),
    page: z.number().optional(),
    page_size: z.number().optional(),
  }, async ({ query, page, page_size }) => {
    const data = await apiV2("/highlights/", { params: { search: query, page, page_size } });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 3. create_highlight
  server.tool("create_highlight", "Create a new highlight in your Readwise library", {
    text: z.string().describe("The highlight text (required, max 8191 chars)"),
    title: z.string().optional().describe("Source title (book, article, etc.)"),
    author: z.string().optional().describe("Author name"),
    source_url: z.string().optional().describe("URL of the source"),
    source_type: z.string().optional().describe("Type: kindle, instapaper, pocket, etc."),
    category: z.enum(["books", "articles", "tweets", "podcasts"]).optional(),
    note: z.string().optional().describe("Personal note on the highlight"),
    location: z.number().optional().describe("Location in the source"),
    location_type: z.enum(["page", "location", "order", "time_offset"]).optional(),
    highlighted_at: z.string().optional().describe("When highlighted (ISO 8601)"),
    image_url: z.string().optional().describe("Image URL for the source"),
  }, async (params) => {
    const highlight = { ...params };
    const data = await apiV2("/highlights/", {
      method: "POST",
      body: { highlights: [highlight] }
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 4. update_highlight
  server.tool("update_highlight", "Update an existing highlight in your Readwise library", {
    highlight_id: z.number().describe("ID of the highlight to update"),
    text: z.string().optional().describe("New highlight text"),
    note: z.string().optional().describe("New note"),
    location: z.number().optional().describe("New location"),
    color: z.enum(["yellow", "blue", "pink", "orange", "green", "purple"]).optional(),
  }, async ({ highlight_id, ...updates }) => {
    const data = await apiV2(`/highlights/${highlight_id}/`, {
      method: "PATCH",
      body: updates
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 5. delete_highlight
  server.tool("delete_highlight", "Delete a highlight from your Readwise library", {
    highlight_id: z.number().describe("ID of the highlight to delete"),
    confirm: z.boolean().describe("Confirm deletion (must be true)"),
  }, async ({ highlight_id, confirm }) => {
    if (!confirm) {
      return { content: [{ type: "text", text: "Deletion not confirmed. Set confirm=true to delete." }] };
    }
    await apiV2(`/highlights/${highlight_id}/`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Highlight ${highlight_id} deleted successfully.` }] };
  });

  // 6. create_note
  server.tool("create_note", "Create or update a note on an existing highlight", {
    highlight_id: z.number().describe("ID of the highlight"),
    note: z.string().describe("Note text to add"),
  }, async ({ highlight_id, note }) => {
    const data = await apiV2(`/highlights/${highlight_id}/`, {
      method: "PATCH",
      body: { note }
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 7. advanced_search
  server.tool("advanced_search", "Search highlights with advanced filters and facets", {
    query: z.string().optional().describe("Search query"),
    book_id: z.number().optional().describe("Filter by book ID"),
    tag: z.string().optional().describe("Filter by tag name"),
    color: z.enum(["yellow", "blue", "pink", "orange", "green", "purple"]).optional(),
    highlighted_at__gt: z.string().optional().describe("Highlighted after (ISO 8601)"),
    highlighted_at__lt: z.string().optional().describe("Highlighted before (ISO 8601)"),
    updated__gt: z.string().optional().describe("Updated after (ISO 8601)"),
    updated__lt: z.string().optional().describe("Updated before (ISO 8601)"),
    page: z.number().optional(),
    page_size: z.number().optional(),
  }, async ({ query, tag, ...params }) => {
    const searchParams = { ...params };
    if (query) searchParams.search = query;
    // Note: tag filtering might need to be done client-side after fetching
    const data = await apiV2("/highlights/", { params: searchParams });

    // Filter by tag if specified
    if (tag && data.results) {
      data.results = data.results.filter(h =>
        h.tags?.some(t => t.name.toLowerCase() === tag.toLowerCase())
      );
    }

    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 8. search_by_tag
  server.tool("search_by_tag", "Search highlights by tag name", {
    tag: z.string().describe("Tag name to search for"),
    page: z.number().optional(),
    page_size: z.number().optional(),
  }, async ({ tag, page, page_size }) => {
    // Fetch highlights and filter by tag
    const data = await apiV2("/highlights/", { params: { page, page_size: page_size || 1000 } });

    if (data.results) {
      data.results = data.results.filter(h =>
        h.tags?.some(t => t.name.toLowerCase().includes(tag.toLowerCase()))
      );
      data.count = data.results.length;
    }

    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 9. search_by_date
  server.tool("search_by_date", "Search highlights by date range", {
    start_date: z.string().describe("Start date (ISO 8601, e.g., 2024-01-01)"),
    end_date: z.string().optional().describe("End date (ISO 8601)"),
    date_field: z.enum(["highlighted_at", "updated"]).optional().describe("Which date to filter by"),
    page: z.number().optional(),
    page_size: z.number().optional(),
  }, async ({ start_date, end_date, date_field = "highlighted_at", page, page_size }) => {
    const params = { page, page_size };
    params[`${date_field}__gt`] = start_date;
    if (end_date) params[`${date_field}__lt`] = end_date;

    const data = await apiV2("/highlights/", { params });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 10. export_highlights
  server.tool("export_highlights", "Export all highlights with optional filtering", {
    updated_after: z.string().optional().describe("Only export highlights updated after this date (ISO 8601)"),
    book_ids: z.string().optional().describe("Comma-separated list of book IDs to export"),
    page_cursor: z.string().optional().describe("Pagination cursor"),
  }, async ({ updated_after, book_ids, page_cursor }) => {
    const params = {};
    if (updated_after) params.updatedAfter = updated_after;
    if (book_ids) params.ids = book_ids;
    if (page_cursor) params.pageCursor = page_cursor;

    const data = await apiV2("/export/", { params });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 11. get_daily_review
  server.tool("get_daily_review", "Get your daily review highlights for spaced repetition learning", {}, async () => {
    const data = await apiV2("/review/");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // ===========================================================================
  // BOOKS - 2 tools
  // ===========================================================================

  // 12. get_books
  server.tool("get_books", "Get a list of books from your Readwise library", {
    page: z.number().optional(),
    page_size: z.number().optional(),
    category: z.enum(["books", "articles", "tweets", "supplementals", "podcasts"]).optional(),
    source: z.string().optional().describe("Filter by source (kindle, instapaper, etc.)"),
    updated__gt: z.string().optional(),
    updated__lt: z.string().optional(),
  }, async (params) => {
    const data = await apiV2("/books/", { params });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 13. get_book
  server.tool("get_book", "Get details of a specific book by ID", {
    book_id: z.number().describe("ID of the book"),
  }, async ({ book_id }) => {
    const data = await apiV2(`/books/${book_id}/`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // ===========================================================================
  // DOCUMENTS (Reader) - 10 tools
  // ===========================================================================

  // 14. get_documents
  server.tool("get_documents", "Retrieve documents from your Readwise Reader library", {
    location: z.enum(["new", "later", "shortlist", "archive", "feed"]).optional(),
    category: z.enum(["article", "email", "rss", "highlight", "note", "pdf", "epub", "tweet", "video"]).optional(),
    updated_after: z.string().optional().describe("Filter by update date (ISO 8601)"),
    page_cursor: z.string().optional(),
  }, async ({ location, category, updated_after, page_cursor }) => {
    const params = {};
    if (location) params.location = location;
    if (category) params.category = category;
    if (updated_after) params.updatedAfter = updated_after;
    if (page_cursor) params.pageCursor = page_cursor;

    const data = await apiV3("/list/", { params });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 15. get_document
  server.tool("get_document", "Get a specific document by ID from Readwise Reader", {
    document_id: z.string().describe("ID of the document"),
    with_html: z.boolean().optional().describe("Include HTML content"),
  }, async ({ document_id, with_html }) => {
    const params = { id: document_id };
    if (with_html) params.withHtmlContent = true;

    const data = await apiV3("/list/", { params });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 16. save_document
  server.tool("save_document", "Save a new document to Readwise Reader. Can save by URL or by providing HTML content directly (bypasses bot protection)", {
    url: z.string().describe("URL of the document. For generated content, use a placeholder like 'https://claude.ai/generated/TIMESTAMP'"),
    html: z.string().optional().describe("HTML content to save directly. When provided, Readwise uses this instead of fetching the URL. Wrap text in basic HTML tags."),
    title: z.string().optional().describe("Title of the document (required when using html parameter)"),
    author: z.string().optional().describe("Author name (e.g., 'Claude AI')"),
    summary: z.string().optional(),
    published_date: z.string().optional().describe("Publication date (ISO 8601)"),
    image_url: z.string().optional(),
    location: z.enum(["new", "later", "archive", "feed"]).optional(),
    category: z.enum(["article", "email", "rss", "highlight", "note", "pdf", "epub", "tweet", "video"]).optional(),
    tags: z.array(z.string()).optional(),
    notes: z.string().optional().describe("Top-level note for the document"),
  }, async (params) => {
    const data = await apiV3("/save/", { method: "POST", body: params });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 16b. save_text_content - Convenience tool for saving generated text
  server.tool("save_text_content", "Save text content directly to Readwise Reader (perfect for Claude-generated content, bypasses bot protection)", {
    content: z.string().describe("The text content to save (plain text or markdown)"),
    title: z.string().describe("Title of the document"),
    author: z.string().optional().default("Claude AI").describe("Author name"),
    summary: z.string().optional().describe("Brief summary of the content"),
    tags: z.array(z.string()).optional().describe("Tags to apply"),
    location: z.enum(["new", "later", "archive"]).optional().default("new"),
    source: z.string().optional().default("Claude Mobile").describe("Source application name"),
  }, async ({ content, title, author, summary, tags, location, source }) => {
    // Convert markdown-like content to basic HTML
    const htmlContent = content
      .split('\n\n').map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');

    const html = `<!DOCTYPE html>
<html>
<head><title>${title}</title></head>
<body>
<article>
<h1>${title}</h1>
${author ? `<p><em>By ${author}</em></p>` : ''}
${htmlContent}
</article>
</body>
</html>`;

    const timestamp = Date.now();
    const data = await apiV3("/save/", {
      method: "POST",
      body: {
        url: `https://claude.ai/conversation/${timestamp}`,
        html,
        title,
        author: author || "Claude AI",
        summary,
        tags,
        location: location || "new",
        saved_using: source || "Claude Mobile",
        category: "article"
      }
    });

    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 17. update_document
  server.tool("update_document", "Update metadata for an existing document in Readwise Reader", {
    document_id: z.string().describe("ID of the document to update"),
    title: z.string().optional(),
    author: z.string().optional(),
    summary: z.string().optional(),
    published_date: z.string().optional(),
    image_url: z.string().optional(),
    location: z.enum(["new", "later", "shortlist", "archive", "feed"]).optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    notes: z.string().optional(),
    seen: z.boolean().optional().describe("Mark as read/unread"),
  }, async ({ document_id, ...updates }) => {
    const data = await apiV3(`/update/${document_id}/`, { method: "PATCH", body: updates });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 18. delete_document
  server.tool("delete_document", "Delete a document from your Readwise Reader library", {
    document_id: z.string().describe("ID of the document to delete"),
    confirm: z.boolean().describe("Confirm deletion (must be true)"),
  }, async ({ document_id, confirm }) => {
    if (!confirm) {
      return { content: [{ type: "text", text: "Deletion not confirmed. Set confirm=true to delete." }] };
    }
    await apiV3(`/delete/${document_id}/`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Document ${document_id} deleted successfully.` }] };
  });

  // 19. document_tags
  server.tool("document_tags", "Get, add, or update tags for a document in Readwise Reader", {
    document_id: z.string().describe("ID of the document"),
    action: z.enum(["get", "set", "add", "remove"]).describe("Action to perform"),
    tags: z.array(z.string()).optional().describe("Tags to set/add/remove"),
  }, async ({ document_id, action, tags }) => {
    if (action === "get") {
      const data = await apiV3("/list/", { params: { id: document_id } });
      const doc = data.results?.[0];
      return { content: [{ type: "text", text: JSON.stringify(doc?.tags || [], null, 2) }] };
    }

    if (!tags || tags.length === 0) {
      return { content: [{ type: "text", text: "Tags array required for this action." }] };
    }

    if (action === "set") {
      const data = await apiV3(`/update/${document_id}/`, { method: "PATCH", body: { tags } });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (action === "add" || action === "remove") {
      // First get current tags
      const current = await apiV3("/list/", { params: { id: document_id } });
      const doc = current.results?.[0];
      let currentTags = doc?.tags || [];

      if (action === "add") {
        currentTags = [...new Set([...currentTags, ...tags])];
      } else {
        currentTags = currentTags.filter(t => !tags.includes(t));
      }

      const data = await apiV3(`/update/${document_id}/`, { method: "PATCH", body: { tags: currentTags } });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    return { content: [{ type: "text", text: "Invalid action" }] };
  });

  // 20. bulk_save_documents
  server.tool("bulk_save_documents", "Save multiple documents to Readwise Reader in bulk", {
    documents: z.array(z.object({
      url: z.string(),
      title: z.string().optional(),
      author: z.string().optional(),
      tags: z.array(z.string()).optional(),
      location: z.enum(["new", "later", "archive", "feed"]).optional(),
    })).describe("Array of documents to save"),
    confirm: z.boolean().describe("Confirm bulk operation (must be true)"),
  }, async ({ documents, confirm }) => {
    if (!confirm) {
      return { content: [{ type: "text", text: `Bulk save not confirmed. This will save ${documents.length} documents. Set confirm=true.` }] };
    }

    const results = [];
    for (const doc of documents) {
      try {
        const data = await apiV3("/save/", { method: "POST", body: doc });
        results.push({ url: doc.url, success: true, data });
      } catch (error) {
        results.push({ url: doc.url, success: false, error: error.message });
      }
    }

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  // 21. bulk_update_documents
  server.tool("bulk_update_documents", "Update multiple documents in Readwise Reader in bulk", {
    updates: z.array(z.object({
      document_id: z.string(),
      title: z.string().optional(),
      author: z.string().optional(),
      location: z.enum(["new", "later", "shortlist", "archive", "feed"]).optional(),
      tags: z.array(z.string()).optional(),
      seen: z.boolean().optional(),
    })).describe("Array of updates"),
    confirm: z.boolean().describe("Confirm bulk operation (must be true)"),
  }, async ({ updates, confirm }) => {
    if (!confirm) {
      return { content: [{ type: "text", text: `Bulk update not confirmed. This will update ${updates.length} documents. Set confirm=true.` }] };
    }

    const results = [];
    for (const { document_id, ...updateData } of updates) {
      try {
        const data = await apiV3(`/update/${document_id}/`, { method: "PATCH", body: updateData });
        results.push({ document_id, success: true, data });
      } catch (error) {
        results.push({ document_id, success: false, error: error.message });
      }
    }

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  // 22. bulk_delete_documents
  server.tool("bulk_delete_documents", "Delete multiple documents from Readwise Reader in bulk", {
    document_ids: z.array(z.string()).describe("Array of document IDs to delete"),
    confirm: z.boolean().describe("Confirm bulk deletion (must be true)"),
  }, async ({ document_ids, confirm }) => {
    if (!confirm) {
      return { content: [{ type: "text", text: `Bulk delete not confirmed. This will DELETE ${document_ids.length} documents permanently. Set confirm=true.` }] };
    }

    const results = [];
    for (const document_id of document_ids) {
      try {
        await apiV3(`/delete/${document_id}/`, { method: "DELETE" });
        results.push({ document_id, success: true });
      } catch (error) {
        results.push({ document_id, success: false, error: error.message });
      }
    }

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  // 23. get_recent_content
  server.tool("get_recent_content", "Get the most recently added or updated content from your Readwise library", {
    hours_ago: z.number().optional().describe("Get content from the last N hours (default 24)"),
    category: z.string().optional(),
    location: z.enum(["new", "later", "shortlist", "archive", "feed"]).optional(),
  }, async ({ hours_ago = 24, category, location }) => {
    const date = new Date(Date.now() - hours_ago * 60 * 60 * 1000);
    const params = { updatedAfter: date.toISOString() };
    if (category) params.category = category;
    if (location) params.location = location;

    const data = await apiV3("/list/", { params });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // ===========================================================================
  // TAGS - 2 tools
  // ===========================================================================

  // 24. get_tags
  server.tool("get_tags", "Get a list of all tags from your Readwise library", {
    page_cursor: z.string().optional(),
  }, async ({ page_cursor }) => {
    const params = {};
    if (page_cursor) params.pageCursor = page_cursor;

    const data = await apiV3("/tags/", { params });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 25. bulk_tags
  server.tool("bulk_tags", "Add tags to multiple documents in Readwise Reader", {
    document_ids: z.array(z.string()).describe("Array of document IDs"),
    tags: z.array(z.string()).describe("Tags to add to all documents"),
    confirm: z.boolean().describe("Confirm bulk operation (must be true)"),
  }, async ({ document_ids, tags, confirm }) => {
    if (!confirm) {
      return { content: [{ type: "text", text: `Bulk tag not confirmed. This will add tags to ${document_ids.length} documents. Set confirm=true.` }] };
    }

    const results = [];
    for (const document_id of document_ids) {
      try {
        // Get current tags
        const current = await apiV3("/list/", { params: { id: document_id } });
        const doc = current.results?.[0];
        const currentTags = doc?.tags || [];
        const newTags = [...new Set([...currentTags, ...tags])];

        const data = await apiV3(`/update/${document_id}/`, { method: "PATCH", body: { tags: newTags } });
        results.push({ document_id, success: true });
      } catch (error) {
        results.push({ document_id, success: false, error: error.message });
      }
    }

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  // ===========================================================================
  // READING PROGRESS - 3 tools
  // ===========================================================================

  // 26. get_reading_progress
  server.tool("get_reading_progress", "Get the reading progress of a document", {
    document_id: z.string().describe("ID of the document"),
  }, async ({ document_id }) => {
    const data = await apiV3("/list/", { params: { id: document_id } });
    const doc = data.results?.[0];

    if (!doc) {
      return { content: [{ type: "text", text: "Document not found" }] };
    }

    return { content: [{ type: "text", text: JSON.stringify({
      document_id: doc.id,
      title: doc.title,
      reading_progress: doc.reading_progress,
      word_count: doc.word_count,
      location: doc.location,
      seen: doc.seen,
    }, null, 2) }] };
  });

  // 27. update_reading_progress
  server.tool("update_reading_progress", "Update the reading progress of a document", {
    document_id: z.string().describe("ID of the document"),
    reading_progress: z.number().min(0).max(1).describe("Progress from 0.0 to 1.0"),
    seen: z.boolean().optional().describe("Mark as seen/read"),
  }, async ({ document_id, reading_progress, seen }) => {
    const body = { reading_progress };
    if (seen !== undefined) body.seen = seen;

    const data = await apiV3(`/update/${document_id}/`, { method: "PATCH", body });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 28. get_reading_list
  server.tool("get_reading_list", "Get a list of documents with their reading progress", {
    location: z.enum(["new", "later", "shortlist", "archive", "feed"]).optional(),
    min_progress: z.number().optional().describe("Minimum reading progress (0.0-1.0)"),
    max_progress: z.number().optional().describe("Maximum reading progress (0.0-1.0)"),
    page_cursor: z.string().optional(),
  }, async ({ location, min_progress, max_progress, page_cursor }) => {
    const params = {};
    if (location) params.location = location;
    if (page_cursor) params.pageCursor = page_cursor;

    const data = await apiV3("/list/", { params });

    // Filter by progress if specified
    if (data.results && (min_progress !== undefined || max_progress !== undefined)) {
      data.results = data.results.filter(doc => {
        const progress = doc.reading_progress || 0;
        if (min_progress !== undefined && progress < min_progress) return false;
        if (max_progress !== undefined && progress > max_progress) return false;
        return true;
      });
    }

    // Return simplified reading list
    const readingList = data.results?.map(doc => ({
      id: doc.id,
      title: doc.title,
      author: doc.author,
      reading_progress: doc.reading_progress,
      word_count: doc.word_count,
      location: doc.location,
      category: doc.category,
    }));

    return { content: [{ type: "text", text: JSON.stringify({
      count: readingList?.length,
      results: readingList,
      nextPageCursor: data.nextPageCursor
    }, null, 2) }] };
  });

  // ===========================================================================
  // VIDEOS - 6 tools
  // ===========================================================================

  // 29. get_videos
  server.tool("get_videos", "Get videos from your Readwise Reader library", {
    location: z.enum(["new", "later", "shortlist", "archive", "feed"]).optional(),
    page_cursor: z.string().optional(),
  }, async ({ location, page_cursor }) => {
    const params = { category: "video" };
    if (location) params.location = location;
    if (page_cursor) params.pageCursor = page_cursor;

    const data = await apiV3("/list/", { params });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 30. get_video
  server.tool("get_video", "Get details of a specific video by document ID", {
    document_id: z.string().describe("ID of the video document"),
  }, async ({ document_id }) => {
    const data = await apiV3("/list/", { params: { id: document_id } });
    const video = data.results?.[0];

    if (!video || video.category !== "video") {
      return { content: [{ type: "text", text: "Video not found or document is not a video" }] };
    }

    return { content: [{ type: "text", text: JSON.stringify(video, null, 2) }] };
  });

  // 31. create_video_highlight
  server.tool("create_video_highlight", "Create a highlight on a video at a specific timestamp", {
    video_title: z.string().describe("Title of the video"),
    video_url: z.string().describe("URL of the video"),
    text: z.string().describe("Highlight text/transcript"),
    timestamp_seconds: z.number().describe("Timestamp in seconds"),
    note: z.string().optional().describe("Personal note"),
    author: z.string().optional().describe("Video creator/channel"),
  }, async ({ video_title, video_url, text, timestamp_seconds, note, author }) => {
    const highlight = {
      text,
      title: video_title,
      source_url: video_url,
      source_type: "video",
      category: "podcasts", // Videos are stored as podcasts in v2
      location: timestamp_seconds,
      location_type: "time_offset",
      note,
      author,
    };

    const data = await apiV2("/highlights/", {
      method: "POST",
      body: { highlights: [highlight] }
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 32. get_video_highlights
  server.tool("get_video_highlights", "Get all highlights from a specific video", {
    book_id: z.number().describe("Book/source ID of the video in Readwise"),
    page: z.number().optional(),
    page_size: z.number().optional(),
  }, async ({ book_id, page, page_size }) => {
    const data = await apiV2("/highlights/", { params: { book_id, page, page_size } });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // 33. update_video_position
  server.tool("update_video_position", "Update the playback position of a video", {
    document_id: z.string().describe("ID of the video document"),
    position_seconds: z.number().describe("Current position in seconds"),
    duration_seconds: z.number().optional().describe("Total video duration"),
  }, async ({ document_id, position_seconds, duration_seconds }) => {
    // Calculate progress if duration provided
    let reading_progress;
    if (duration_seconds && duration_seconds > 0) {
      reading_progress = Math.min(position_seconds / duration_seconds, 1);
    }

    const body = {};
    if (reading_progress !== undefined) body.reading_progress = reading_progress;

    const data = await apiV3(`/update/${document_id}/`, { method: "PATCH", body });
    return { content: [{ type: "text", text: JSON.stringify({
      document_id,
      position_seconds,
      reading_progress,
      ...data
    }, null, 2) }] };
  });

  // 34. get_video_position (bonus tool)
  server.tool("get_video_position", "Get the current playback position of a video", {
    document_id: z.string().describe("ID of the video document"),
  }, async ({ document_id }) => {
    const data = await apiV3("/list/", { params: { id: document_id } });
    const video = data.results?.[0];

    if (!video) {
      return { content: [{ type: "text", text: "Video not found" }] };
    }

    return { content: [{ type: "text", text: JSON.stringify({
      document_id: video.id,
      title: video.title,
      reading_progress: video.reading_progress,
      word_count: video.word_count,
      // Estimate position if we have word_count (duration proxy)
      estimated_position: video.reading_progress && video.word_count
        ? Math.round(video.reading_progress * video.word_count)
        : null,
    }, null, 2) }] };
  });

  return server;
}

// =============================================================================
// EXPRESS APP
// =============================================================================

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Mcp-Session-Id");
  res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    server: "readwise-mcp-enhanced",
    version: "2.1.0",
    tools: 35,
    auth: "oauth2",
    transport: "streamable-http"
  });
});

app.get("/authorize", (req, res) => {
  const { client_id, redirect_uri, state } = req.query;
  if (client_id !== OAUTH_CLIENT_ID) {
    return res.status(401).json({ error: "invalid_client" });
  }
  const code = crypto.randomUUID();
  authCodes.set(code, { clientId: client_id, createdAt: Date.now() });
  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(url.toString());
});

app.post("/token", (req, res) => {
  const { grant_type, code, client_id, client_secret } = req.body;
  if (!validateCredentials(client_id, client_secret)) {
    return res.status(401).json({ error: "invalid_client" });
  }
  if (grant_type === "authorization_code") {
    const authData = authCodes.get(code);
    if (!authData || authData.clientId !== client_id) {
      return res.status(400).json({ error: "invalid_grant" });
    }
    authCodes.delete(code);
  }
  const accessToken = crypto.randomUUID();
  validTokens.set(accessToken, { clientId: client_id, createdAt: Date.now() });
  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 86400,
    refresh_token: crypto.randomUUID()
  });
});

app.post("/mcp", async (req, res) => {
  if (!validateToken(req.headers.authorization)) {
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null
    });
  }

  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
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
        error: { code: -32603, message: "Internal error" },
        id: null
      });
    }
  }
});

app.get("/mcp", (req, res) => res.status(405).json({ error: "Use POST" }));

app.get("/", (req, res) => {
  res.json({
    name: "Readwise MCP Enhanced",
    version: "2.1.0",
    tools: 35,
    status: "running",
    auth: "oauth2"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Readwise MCP Enhanced v2.0.0 running on port ${PORT}`);
  console.log(`📚 34 tools available`);
  console.log(`🔒 OAuth2 authentication enabled`);
});
