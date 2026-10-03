// Tapestry MCP server — read-only access to a parent's Tapestry learning journal (stdio).

import * as cheerio from "cheerio";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TapestryClient } from "./client.js";

// ── normalisation helpers ────────────────────────────────────────────────────
export const text = (v) => {
  if (!v) return "";
  let s = String(v);
  if (/<[a-z/][^>]*>/i.test(s)) {
    const $ = cheerio.load(s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "$&\n"));
    s = $.root().text();
  }
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
};

const DATE_KEYS = ["observationDate", "observation_time", "date", "createdAt", "created_at", "page_added", "scheduledAt"];
export const obsDate = (o) => { for (const k of DATE_KEYS) if (o?.[k]) return String(o[k]); return null; };
const day = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

const name = (p) => {
  if (p && typeof p === "object")
    return String(p.fullName || p.name || p.displayName || [p.firstName, p.lastName].filter(Boolean).join(" ") || "");
  return p ? String(p) : "";
};
const childrenOf = (o) =>
  Array.isArray(o.children) ? o.children.map(name).filter(Boolean) : [name(o.child) || o.child_name].filter(Boolean);

const tagsOf = (o) => {
  const out = [];
  for (const k of ["frameworks", "assessments", "tags", "areas", "labels", "goals", "learningAreas"]) {
    const v = o[k];
    for (const item of Array.isArray(v) ? v : typeof v === "string" ? [v] : []) {
      const t = typeof item === "object" ? name(item) || String(item?.title || "") : String(item);
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
};

const mediaOf = (o) => {
  const out = [];
  for (const key of ["media", "documents", "images", "videos", "attachments"]) {
    for (const m of o[key] || []) {
      if (!m || typeof m !== "object") continue;
      const url = m.original_url || m.originalUrl || m.url || m.src;
      if (!url) continue;
      out.push({ id: m.id ?? null, type: m.type || m.mimeType || key.replace(/s$/, ""), url,
        thumbnail: m.thumbnailUrl || m.thumbnail_url || m.thumbnail || null });
    }
  }
  return out;
};

const notesOf = (o) => text(o.notes || o.body || o.text || o.description);

export const summary = (o, snip = 280) => {
  const n = notesOf(o);
  return {
    id: o.id ?? null, title: text(o.title), date: obsDate(o), children: childrenOf(o),
    author: name(o.author || o.createdBy || o.staff),
    snippet: n.length > snip ? `${n.slice(0, snip)}…` : n,
    media_count: o.mediaCount ?? mediaOf(o).length,
  };
};

export const detail = (o, includeRaw = false) => {
  const { snippet, ...d } = summary(o);
  d.notes = notesOf(o);
  const extra = text(o.additionalInformation);
  if (extra) d.additional_information = extra;
  d.tags = tagsOf(o);
  d.media = mediaOf(o);
  if (Array.isArray(o.comments) && o.comments.length)
    d.comments = o.comments.filter((c) => c && typeof c === "object").map((c) => ({
      author: name(c.author || c.user), date: obsDate(c), text: text(c.body || c.text || c.comment) }));
  if (includeRaw) d.raw = o;
  return d;
};

export async function* filtered(client, { childId, since, until, scanLimit }) {
  for await (const o of client.iterObservations(childId, scanLimit)) {
    const d = day(obsDate(o));
    if (until && d && d > until) continue;
    if (since && d && d < since) return; // newest-first ordering
    yield o;
  }
}

// ── server ───────────────────────────────────────────────────────────────────
const ok = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  structuredContent: Array.isArray(data) ? { items: data } : data,
});
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e?.message || e}` }] });
const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const RO = { readOnlyHint: true, openWorldHint: true };

export function buildServer(getClient) {
  const server = new McpServer(
    { name: "tapestry", version: "0.2.0", title: "Tapestry Learning Journal" },
    { instructions:
        "Read-only access to the user's child's Tapestry (tapestryjournal.com) learning journal: children, " +
        "observations written by nursery/school staff, and their photos/videos. Call list_children first " +
        "to get child IDs. Observations are returned newest first." },
  );

  server.registerTool("list_children", {
    description: "List the children on this Tapestry account (id, name, group).",
    inputSchema: {}, annotations: RO,
  }, wrap(async () => (await getClient().children()).map((c) => ({
    id: c.id ?? null, name: name(c), group: name(c.group) || c.groupName || null,
    date_of_birth: c.dateOfBirth || c.dob || null }))));

  server.registerTool("list_observations", {
    description: "List recent observations (newest first) as short summaries.",
    inputSchema: {
      child_id: z.string().optional().describe("Restrict to one child (from list_children)."),
      since: DATE.optional().describe("Only observations on/after this date."),
      until: DATE.optional().describe("Only observations on/before this date."),
      limit: z.number().int().min(1).max(200).default(20),
    }, annotations: RO,
  }, wrap(async ({ child_id, since, until, limit = 20 }) => {
    const out = [];
    for await (const o of filtered(getClient(), { childId: child_id, since, until, scanLimit: 2000 })) {
      out.push(summary(o));
      if (out.length >= limit) break;
    }
    return out;
  }));

  server.registerTool("get_observation", {
    description: "Get one observation in full: notes, tags/framework links, comments and all media URLs.",
    inputSchema: {
      observation_id: z.string(),
      include_raw: z.boolean().default(false).describe("Also return the unprocessed API JSON (debugging)."),
    }, annotations: RO,
  }, wrap(async ({ observation_id, include_raw }) => detail(await getClient().observation(observation_id), include_raw)));

  server.registerTool("search_observations", {
    description: "Case-insensitive keyword search over observation titles, notes and tags. All words must match.",
    inputSchema: {
      query: z.string().min(1),
      child_id: z.string().optional(),
      since: DATE.optional(), until: DATE.optional(),
      limit: z.number().int().min(1).max(200).default(20),
      scan_limit: z.number().int().min(1).max(5000).default(1000).describe("Max observations to scan."),
    }, annotations: RO,
  }, wrap(async ({ query, child_id, since, until, limit = 20, scan_limit = 1000 }) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for await (const o of filtered(getClient(), { childId: child_id, since, until, scanLimit: scan_limit })) {
      const hay = [text(o.title), notesOf(o), text(o.additionalInformation), tagsOf(o).join(" ")].join(" ").toLowerCase();
      if (words.every((w) => hay.includes(w))) { out.push(summary(o)); if (out.length >= limit) break; }
    }
    return out;
  }));

  server.registerTool("download_media", {
    description: "Download all photos/videos/documents for an observation into TAPESTRY_DOWNLOAD_DIR " +
      "(default ./tapestry-downloads). Returns the saved file paths.",
    inputSchema: { observation_id: z.string(), overwrite: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, wrap(async ({ observation_id, overwrite }) => {
    const root = resolve((process.env.TAPESTRY_DOWNLOAD_DIR || "./tapestry-downloads").replace(/^~(?=\/|$)/, homedir()));
    const o = await getClient().observation(observation_id);
    const folder = join(root, `${(obsDate(o) || "undated").slice(0, 10)}_${String(observation_id).replace(/[^\w-]/g, "_")}`);
    const files = [], errors = [];
    let i = 0;
    for (const m of mediaOf(o)) {
      i++;
      let ext = extname(new URL(m.url, "https://x").pathname).toLowerCase();
      if (!/^\.[a-z0-9]{1,5}$/.test(ext)) ext = ".bin";
      const dest = join(folder, `${String(i).padStart(2, "0")}_${String(m.id ?? i).replace(/[^\w-]/g, "_")}${ext}`);
      if (existsSync(dest) && !overwrite) { files.push(dest); continue; }
      try { files.push(await getClient().download(m.url, dest)); } catch (e) { errors.push({ url: m.url, error: e.message }); }
    }
    return { folder, files, errors };
  }));

  return server;
}

export async function main() {
  let client;
  const getClient = () => (client ??= new TapestryClient(process.env.TAPESTRY_EMAIL, process.env.TAPESTRY_PASSWORD));
  await buildServer(getClient).connect(new StdioServerTransport());
  console.error("[tapestry-mcp] ready on stdio");
}
