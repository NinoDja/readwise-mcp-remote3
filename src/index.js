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
    version: "2.4.0"
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

  // 16b. save_text_content - Save formatted content to Reader
  server.tool("save_text_content", "Save text/markdown content to Readwise Reader with beautiful formatting. Supports: # headings, **bold**, *italic*, - lists, > quotes, ```code blocks```", {
    content: z.string().describe("Content in Markdown format"),
    title: z.string().describe("Title of the document"),
    author: z.string().optional().describe("Author name (default: Claude AI)"),
    summary: z.string().optional().describe("Brief summary"),
    tags: z.array(z.string()).optional().describe("Tags to apply"),
    location: z.enum(["new", "later", "archive"]).optional(),
  }, async ({ content, title, author = "Claude AI", summary, tags, location = "new" }) => {

    // Markdown to HTML converter
    function md2html(text) {
      let h = text;

      // Escape HTML entities first
      h = h.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      // Code blocks ```
      h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) =>
        `<pre style="background:#f6f8fa;padding:16px;border-radius:8px;overflow-x:auto;font-size:14px;line-height:1.5"><code>${code.trim()}</code></pre>`);

      // Inline code `
      h = h.replace(/`([^`]+)`/g, '<code style="background:#f0f0f0;padding:2px 6px;border-radius:4px;font-size:0.9em">$1</code>');

      // Headings
      h = h.replace(/^#### (.+)$/gm, '<h4 style="font-size:1.1em;margin:1.5em 0 0.5em;color:#24292f">$1</h4>');
      h = h.replace(/^### (.+)$/gm, '<h3 style="font-size:1.25em;margin:1.5em 0 0.5em;color:#24292f">$1</h3>');
      h = h.replace(/^## (.+)$/gm, '<h2 style="font-size:1.5em;margin:1.5em 0 0.5em;color:#24292f;border-bottom:1px solid #eee;padding-bottom:0.3em">$1</h2>');
      h = h.replace(/^# (.+)$/gm, '<h2 style="font-size:1.5em;margin:1.5em 0 0.5em;color:#24292f;border-bottom:1px solid #eee;padding-bottom:0.3em">$1</h2>');

      // Bold & Italic
      h = h.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
      h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
      h = h.replace(/_(.+?)_/g, '<em>$1</em>');

      // Links [text](url)
      h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#0969da;text-decoration:none">$1</a>');

      // Blockquotes
      h = h.replace(/^&gt; (.+)$/gm, '<blockquote style="border-left:4px solid #ddd;margin:1em 0;padding:0.5em 1em;color:#656d76;background:#f6f8fa">$1</blockquote>');

      // Unordered lists
      h = h.replace(/^[\-\*] (.+)$/gm, '<li style="margin:0.25em 0">$1</li>');

      // Ordered lists
      h = h.replace(/^\d+\. (.+)$/gm, '<li style="margin:0.25em 0">$1</li>');

      // Wrap consecutive <li> in <ul>
      h = h.replace(/((?:<li[^>]*>.*<\/li>\s*)+)/g, '<ul style="margin:1em 0;padding-left:2em">$1</ul>');

      // Horizontal rules
      h = h.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #eee;margin:2em 0">');

      // Paragraphs
      const blocks = h.split(/\n\n+/);
      h = blocks.map(block => {
        block = block.trim();
        if (!block) return '';
        if (/^<(h[1-6]|ul|ol|pre|blockquote|hr)/i.test(block)) return block;
        return `<p style="margin:1em 0;line-height:1.7">${block.replace(/\n/g, '<br>')}</p>`;
      }).join('\n');

      return h;
    }

    const htmlContent = md2html(content);
    const now = new Date();
    const dateStr = now.toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${title}</title>
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#1f2328;background:#fff">
<article>
<h1 style="font-size:2em;margin:0 0 0.5em;color:#1f2328;font-weight:600">${title}</h1>
<p style="color:#656d76;font-size:0.9em;margin-bottom:2em;padding-bottom:1em;border-bottom:1px solid #eee">
${author} · ${dateStr}
</p>
${htmlContent}
</article>
</body>
</html>`;

    const timestamp = Date.now();
    const data = await apiV3("/save/", {
      method: "POST",
      body: {
        url: `https://claude.ai/generated/${timestamp}`,
        html,
        title,
        author,
        summary,
        tags,
        location,
        saved_using: "Claude Mobile",
        category: "article"
      }
    });

    return { content: [{ type: "text", text: `✅ Saved "${title}" to Readwise Reader\n\n${JSON.stringify(data, null, 2)}` }] };
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

  // 17b. expand_document - Append content to document notes (for iterative workflow)
  server.tool("expand_document", "Append new content to an existing document's notes. Perfect for iterative analysis: you highlight in Readwise, Claude analyzes and appends insights to the same document.", {
    document_id: z.string().describe("ID of the document to expand"),
    content: z.string().describe("New content to append (supports markdown: # headings, **bold**, *italic*, - lists)"),
    section_title: z.string().optional().describe("Optional title for this section (e.g., 'Analysis #2 - Feb 16')"),
    separator: z.boolean().optional().describe("Add a visual separator before new content (default: true)"),
  }, async ({ document_id, content, section_title, separator = true }) => {
    // 1. Fetch current document to get existing notes
    const docResponse = await apiV3("/list/", { params: { id: document_id } });
    const results = docResponse.results || [docResponse];
    const doc = results[0];

    if (!doc) {
      return { content: [{ type: "text", text: `❌ Document ${document_id} not found` }] };
    }

    const existingNotes = doc.notes || doc.document_note || "";
    const now = new Date();
    const timestamp = now.toLocaleString('es-ES', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    // 2. Build new content block
    let newBlock = "";
    if (separator) {
      newBlock += "\n\n───────────────────────────\n\n";
    }
    if (section_title) {
      newBlock += `## ${section_title}\n`;
    }
    newBlock += `*${timestamp}*\n\n`;
    newBlock += content;

    // 3. Combine existing + new
    const updatedNotes = existingNotes + newBlock;

    // 4. Update document
    const updateResponse = await apiV3(`/update/${document_id}/`, {
      method: "PATCH",
      body: { notes: updatedNotes }
    });

    return {
      content: [{
        type: "text",
        text: `✅ Document expanded successfully!\n\n**Document:** ${doc.title}\n**Section added:** ${section_title || '(unnamed)'}\n**Total notes length:** ${updatedNotes.length} chars\n\nThe document notes now contain your accumulated analysis.`
      }]
    };
  });

  // 17c. get_document_with_highlights - Get document + all highlights for analysis
  server.tool("get_document_for_analysis", "Get a document with all its highlights and notes - perfect for Claude to analyze your annotations", {
    document_id: z.string().describe("ID of the document to analyze"),
  }, async ({ document_id }) => {
    // Fetch document
    const docResponse = await apiV3("/list/", { params: { id: document_id } });
    const results = docResponse.results || [docResponse];
    const doc = results[0];

    if (!doc) {
      return { content: [{ type: "text", text: `❌ Document ${document_id} not found` }] };
    }

    // Fetch highlights for this document
    const highlightsData = await apiV2("/highlights/", {
      params: { book_id: document_id, page_size: 100 }
    });

    // Also try to get from export endpoint for better data
    let highlights = highlightsData.results || [];

    // Format output for Claude to analyze
    let output = `# ${doc.title}\n`;
    output += `**Author:** ${doc.author || 'Unknown'}\n`;
    output += `**URL:** ${doc.url || doc.source_url || 'N/A'}\n`;
    output += `**Reading Progress:** ${doc.reading_progress ? Math.round(doc.reading_progress * 100) + '%' : 'Unknown'}\n\n`;

    if (doc.summary) {
      output += `## Summary\n${doc.summary}\n\n`;
    }

    if (doc.notes || doc.document_note) {
      output += `## Document Notes\n${doc.notes || doc.document_note}\n\n`;
    }

    output += `## Your Highlights & Annotations (${highlights.length})\n\n`;

    highlights.forEach((h, i) => {
      output += `### Highlight ${i + 1}\n`;
      output += `> ${h.text}\n\n`;
      if (h.note) {
        output += `**Your note:** ${h.note}\n\n`;
      }
      if (h.tags && h.tags.length > 0) {
        output += `**Tags:** ${h.tags.map(t => t.name || t).join(', ')}\n\n`;
      }
    });

    return { content: [{ type: "text", text: output }] };
  });

  // 17d. create_continuation - Create a linked follow-up document for iterative workflow
  server.tool("create_continuation", "Create a new document as part of a series. Perfect for Claude ↔ Readwise iterative workflow: Claude's analysis becomes a new document you can highlight and annotate.", {
    original_document_id: z.string().describe("ID of the original/previous document in the series"),
    content: z.string().describe("Content for the new document (Markdown supported)"),
    part_number: z.number().optional().describe("Part number in series (auto-detected if not provided)"),
    custom_title: z.string().optional().describe("Custom title (default: auto-generated from original)"),
  }, async ({ original_document_id, content, part_number, custom_title }) => {
    // 1. Fetch original document to get title and tags
    const docResponse = await apiV3("/list/", { params: { id: original_document_id } });
    const results = docResponse.results || [docResponse];
    const originalDoc = results[0];

    if (!originalDoc) {
      return { content: [{ type: "text", text: `❌ Original document ${original_document_id} not found` }] };
    }

    // 2. Determine series info
    const originalTitle = originalDoc.title || "Untitled";
    // Extract base title (remove existing "Part X" or "Análisis #X" suffix)
    const baseTitle = originalTitle.replace(/\s*[-–—]\s*(Part|Parte|Análisis|Analysis)\s*#?\d+.*$/i, '').trim();

    // Auto-detect part number by searching for existing parts
    let detectedPart = part_number;
    if (!detectedPart) {
      try {
        const seriesSearch = await apiV3("/list/", { params: { category: "article" } });
        const seriesDocs = (seriesSearch.results || []).filter(d =>
          d.title && d.title.includes(baseTitle) && d.title.match(/(Part|Parte|Análisis|Analysis)\s*#?\d+/i)
        );
        detectedPart = seriesDocs.length + 2; // +2 because original is Part 1
      } catch (e) {
        detectedPart = 2;
      }
    }

    // 3. Generate new title
    const newTitle = custom_title || `${baseTitle} - Análisis #${detectedPart}`;

    // 4. Convert markdown content to HTML
    function md2html(text) {
      let h = text;
      h = h.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      h = h.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre style="background:#f6f8fa;padding:16px;border-radius:8px;overflow-x:auto"><code>$2</code></pre>');
      h = h.replace(/`([^`]+)`/g, '<code style="background:#f0f0f0;padding:2px 6px;border-radius:4px">$1</code>');
      h = h.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
      h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      h = h.replace(/^# (.+)$/gm, '<h2>$1</h2>');
      h = h.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
      h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
      h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
      h = h.replace(/^&gt; (.+)$/gm, '<blockquote style="border-left:4px solid #ddd;padding-left:1em;color:#666">$1</blockquote>');
      h = h.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
      h = h.replace(/((?:<li>.*<\/li>\s*)+)/g, '<ul style="margin:1em 0;padding-left:2em">$1</ul>');
      h = h.replace(/^---$/gm, '<hr>');
      const blocks = h.split(/\n\n+/);
      h = blocks.map(block => {
        block = block.trim();
        if (!block) return '';
        if (/^<(h[1-6]|ul|ol|pre|blockquote|hr)/i.test(block)) return block;
        return `<p style="margin:1em 0;line-height:1.7">${block.replace(/\n/g, '<br>')}</p>`;
      }).join('\n');
      return h;
    }

    const htmlContent = md2html(content);
    const now = new Date();
    const dateStr = now.toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });

    // 5. Create HTML with link back to original
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${newTitle}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#1f2328">
<article>
<h1 style="font-size:1.8em;margin:0 0 0.5em;color:#1f2328">${newTitle}</h1>
<p style="color:#656d76;font-size:0.9em;margin-bottom:1em;padding-bottom:1em;border-bottom:1px solid #eee">
📚 Serie: <strong>${baseTitle}</strong> · Parte ${detectedPart} · ${dateStr}<br>
🔗 Documento anterior: ${originalTitle}
</p>
${htmlContent}
<hr style="margin:2em 0;border:none;border-top:1px solid #eee">
<p style="color:#656d76;font-size:0.85em;text-align:center">
Este documento es parte de una serie de exploración iterativa.<br>
Haz highlights y notas, luego pide a Claude que continúe el análisis.
</p>
</article>
</body>
</html>`;

    // 6. Get original tags and add series tag
    const originalTags = originalDoc.tags || [];
    const tagNames = originalTags.map(t => typeof t === 'string' ? t : t.name).filter(Boolean);
    const seriesTag = `serie:${baseTitle.toLowerCase().replace(/\s+/g, '-').substring(0, 30)}`;
    if (!tagNames.includes(seriesTag)) tagNames.push(seriesTag);
    tagNames.push('claude-analysis');

    // 7. Save new document
    const timestamp = Date.now();
    const newDoc = await apiV3("/save/", {
      method: "POST",
      body: {
        url: `https://claude.ai/series/${timestamp}`,
        html,
        title: newTitle,
        author: "Claude AI",
        tags: tagNames,
        location: "new",
        saved_using: "Claude Mobile",
        category: "article"
      }
    });

    return {
      content: [{
        type: "text",
        text: `✅ **Continuación creada exitosamente!**

**Nuevo documento:** ${newTitle}
**Parte:** ${detectedPart} de la serie
**Serie:** ${baseTitle}
**Tags:** ${tagNames.join(', ')}

El usuario ahora puede:
1. Abrir este documento en Readwise Reader
2. Hacer highlights y anotaciones sobre tu análisis
3. Pedirte que continúes con la siguiente parte

**ID del nuevo documento:** ${newDoc.id || 'ver en Reader'}`
      }]
    };
  });

  // 17e. get_document_series - Get all documents in a series for comprehensive analysis
  server.tool("get_document_series", "Get all documents in a series with their highlights. Perfect for Claude to analyze the complete iterative exploration.", {
    series_identifier: z.string().describe("Title fragment, tag, or document ID to identify the series"),
    include_highlights: z.boolean().optional().describe("Include highlights from all documents (default: true)"),
  }, async ({ series_identifier, include_highlights = true }) => {
    // Search for documents matching the series
    const searchResponse = await apiV3("/list/", { params: { category: "article" } });
    const allDocs = searchResponse.results || [];

    // Filter by title containing the identifier or by tag
    const seriesDocs = allDocs.filter(d => {
      const titleMatch = d.title && d.title.toLowerCase().includes(series_identifier.toLowerCase());
      const tagMatch = d.tags && d.tags.some(t => {
        const tagName = typeof t === 'string' ? t : t.name;
        return tagName && tagName.toLowerCase().includes(series_identifier.toLowerCase());
      });
      const idMatch = d.id === series_identifier;
      return titleMatch || tagMatch || idMatch;
    });

    if (seriesDocs.length === 0) {
      return { content: [{ type: "text", text: `❌ No documents found matching "${series_identifier}"` }] };
    }

    // Sort by created date or title (to get proper order)
    seriesDocs.sort((a, b) => {
      const dateA = new Date(a.created_at || a.saved_at || 0);
      const dateB = new Date(b.created_at || b.saved_at || 0);
      return dateA - dateB;
    });

    let output = `# Serie: ${series_identifier}\n`;
    output += `**Total documentos:** ${seriesDocs.length}\n\n`;
    output += `---\n\n`;

    for (let i = 0; i < seriesDocs.length; i++) {
      const doc = seriesDocs[i];
      output += `## Documento ${i + 1}: ${doc.title}\n`;
      output += `**ID:** ${doc.id}\n`;
      output += `**Autor:** ${doc.author || 'Unknown'}\n`;
      output += `**Progreso:** ${doc.reading_progress ? Math.round(doc.reading_progress * 100) + '%' : 'N/A'}\n\n`;

      if (doc.summary) {
        output += `### Resumen\n${doc.summary}\n\n`;
      }

      if (doc.notes || doc.document_note) {
        output += `### Notas del documento\n${doc.notes || doc.document_note}\n\n`;
      }

      if (include_highlights) {
        try {
          const highlightsData = await apiV2("/highlights/", { params: { book_id: doc.id, page_size: 50 } });
          const highlights = highlightsData.results || [];

          if (highlights.length > 0) {
            output += `### Highlights (${highlights.length})\n\n`;
            highlights.forEach((h, j) => {
              output += `> ${h.text}\n`;
              if (h.note) output += `**Nota:** ${h.note}\n`;
              output += `\n`;
            });
          }
        } catch (e) {
          output += `*No se pudieron cargar highlights*\n\n`;
        }
      }

      output += `---\n\n`;
    }

    output += `\n**Para continuar la serie:** usa create_continuation con el ID del último documento.`;

    return { content: [{ type: "text", text: output }] };
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
    version: "2.4.0",
    tools: 39,
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
    version: "2.4.0",
    tools: 39,
    status: "running",
    auth: "oauth2"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Readwise MCP Enhanced v2.0.0 running on port ${PORT}`);
  console.log(`📚 34 tools available`);
  console.log(`🔒 OAuth2 authentication enabled`);
});
