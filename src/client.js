// Minimal client for Tapestry (tapestryjournal.com) using the web app's internal /api/4 endpoints.
// Unofficial: Tapestry has no public parent API, so these may change without notice.

import * as cheerio from "cheerio";
import { createWriteStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const BASE_URL = "https://tapestryjournal.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export class TapestryError extends Error {}
export class AuthError extends TapestryError {}

/** Tiny cookie jar: name -> value, good enough for one host. */
class Jar {
  constructor() { this.c = new Map(); }
  clear() { this.c.clear(); }
  absorb(res) {
    const list = res.headers.getSetCookie?.() ?? [];
    for (const line of list) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      if (i > 0) this.c.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join("; "); }
}

export function extractCsrf(html) {
  const $ = cheerio.load(html);
  let tok = "";
  $("div.hidden").each((_, el) => {
    const txt = $(el).text().trim();
    if (!tok && txt.startsWith("{") && txt.includes("csrfToken")) {
      try { tok = JSON.parse(txt).csrfToken || ""; } catch { /* ignore */ }
    }
  });
  if (tok) return tok;
  const m = html.match(/"csrf_?[tT]oken"\s*:\s*"([^"]+)"/);
  if (m) return m[1];
  return $('meta[name="csrf-token"]').attr("content") || $('input[name="_token"]').attr("value") || "";
}

export class TapestryClient {
  constructor(email, password, { baseUrl = BASE_URL, timeoutMs = 30000 } = {}) {
    if (!email || !password) throw new AuthError("TAPESTRY_EMAIL and TAPESTRY_PASSWORD must be set.");
    Object.assign(this, { email, password, baseUrl, timeoutMs });
    this._loginUrl = `${baseUrl.replace(/\/$/, "")}/login`;
    this.jar = new Jar();
    this.csrf = "";
    this.schoolSlug = "";
    this.loggedIn = false;
    this.loginPromise = null;
  }

  async _fetch(url, opts = {}) {
    const headers = { "User-Agent": UA, ...(opts.headers || {}) };
    const cookie = this.jar.header();
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(url, {
      ...opts, headers, redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
    });
    this.jar.absorb(res);
    return res;
  }

  /** GET following redirects manually so cookies set along the chain are kept. */
  async _get(url, headers = {}) {
    let res, cur = url;
    for (let i = 0; i < 10; i++) {
      res = await this._fetch(cur, { headers });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) { cur = new URL(loc, cur).href; continue; }
      break;
    }
    res.finalUrl = cur;
    return res;
  }

  login() {
    this.loginPromise ??= this._login().finally(() => { this.loginPromise = null; });
    return this.loginPromise;
  }

  async _login() {
    this.jar.clear();
    const page = await this._get(this._loginUrl);
    if (!page.ok) throw new TapestryError(`Login page returned HTTP ${page.status}`);
    const html = await page.text();
    const csrf = extractCsrf(html);
    if (!csrf) throw new AuthError("Could not find CSRF token on Tapestry login page.");

    const $ = cheerio.load(html);
    const form = new URLSearchParams();
    $("form").first().find("input").each((_, el) => {
      const name = $(el).attr("name"); const type = ($(el).attr("type") || "").toLowerCase();
      if (!name) return;
      if (name === "_token") form.set(name, csrf);
      else if (type === "email" || ["email", "username", "login"].includes(name)) form.set(name, this.email);
      else if (type === "password" || name === "password") form.set(name, this.password);
      else if (["hidden", "checkbox", "radio"].includes(type)) form.set(name, $(el).attr("value") || "");
    });
    for (const [k, v] of [["_token", csrf], ["email", this.email], ["password", this.password], ["remember", "1"]])
      if (!form.has(k)) form.set(k, v);

    const post = await this._fetch(this._loginUrl, {
      method: "POST", body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: this._loginUrl },
    });
    const loc = post.headers.get("location");
    const final = loc ? await this._get(new URL(loc, this._loginUrl).href) : post;
    const finalUrl = final.finalUrl || this._loginUrl;
    const body = await final.text();

    if (finalUrl.replace(/\/$/, "") === this._loginUrl ||
        /\bincorrect\b|\bthese credentials\b|two.factor|verification code/i.test(body)) {
      throw new AuthError("Tapestry login failed (bad credentials, or the account needs 2FA/SSO, which isn't supported).");
    }
    this.schoolSlug = finalUrl.match(/\/s\/([^/]+)\//)?.[1] || "";
    this.csrf = extractCsrf(body) || csrf;
    this.loggedIn = true;
    console.error(`[tapestry-mcp] logged in (school: ${this.schoolSlug || "?"})`);
  }

  async api(path, params = {}, retry = true) {
    if (!this.loggedIn) await this.login();
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const res = await this._fetch(url.href, {
      headers: {
        "X-Requested-With": "XMLHttpRequest", "X-CSRF-TOKEN": this.csrf,
        "X-TAPESTRY-VERSION": "3", Accept: "application/json",
      },
    });
    const ct = res.headers.get("content-type") || "";
    const expired = [401, 419].includes(res.status) ||
      (res.status >= 300 && res.status < 400 && (res.headers.get("location") || "").includes("login")) ||
      (res.status === 200 && !ct.includes("json"));
    if (expired) {
      if (!retry) throw new AuthError("Tapestry session rejected after re-login.");
      this.loggedIn = false;
      return this.api(path, params, false);
    }
    if (res.status === 404) throw new TapestryError(`Not found: ${path}`);
    if (!res.ok) throw new TapestryError(`Tapestry API ${path} returned HTTP ${res.status}`);
    return res.json();
  }

  async children() {
    const d = await this.api("/api/4/children/list");
    const kids = Array.isArray(d) ? d : d.children || d.data || [];
    return Array.isArray(kids) ? kids : [];
  }

  async observationsPage(childId, cursor, perPage = 50) {
    const d = await this.api("/api/4/observations/list", { perPage, "children.child_id": childId, cursor });
    if (Array.isArray(d)) return { items: d, next: null };
    return { items: d.observations || d.data || [], next: d.nextCursor || null };
  }

  async *iterObservations(childId, maxItems = Infinity, maxPages = 200) {
    let cursor = null, n = 0;
    for (let p = 0; p < maxPages; p++) {
      const { items, next } = await this.observationsPage(childId, cursor);
      for (const o of items) { yield o; if (++n >= maxItems) return; }
      if (!next || !items.length) return;
      cursor = next;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async observation(id) {
    const d = await this.api(`/api/4/observations/get/${encodeURIComponent(id)}`);
    return d && typeof d.observation === "object" ? d.observation : d;
  }

  async download(url, dest) {
    if (!this.loggedIn) await this.login();
    const abs = new URL(url, this.baseUrl);
    if (abs.protocol !== "https:") throw new TapestryError(`Refusing non-HTTPS media URL: ${abs}`);
    // Only send our session cookies to Tapestry itself; media CDNs get a plain request.
    const sameHost = abs.hostname === new URL(this.baseUrl).hostname;
    const res = sameHost
      ? await this._get(abs.href)
      : await fetch(abs, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new TapestryError(`Download failed: HTTP ${res.status}`);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    await rename(tmp, dest);
    return dest;
  }
}
