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

// Set TAPESTRY_DEBUG=1 to log each login step to stderr (never the password).
const debug = (msg) => { if (process.env.TAPESTRY_DEBUG) console.error(`[tapestry-mcp] ${msg}`); };

export class TapestryError extends Error {}
export class AuthError extends TapestryError {}

/** Tiny cookie jar: name -> value, good enough for one host. Honours deletions. */
class Jar {
  constructor() { this.c = new Map(); }
  clear() { this.c.clear(); }
  absorb(res) {
    const list = res.headers.getSetCookie?.() ?? [];
    for (const line of list) {
      const [pair, ...attrs] = line.split(";");
      const i = pair.indexOf("=");
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
      const attr = (k) => attrs.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith(`${k}=`))?.slice(k.length + 1);
      const maxAge = attr("max-age"), expires = attr("expires");
      const gone = !value || (maxAge !== undefined && Number(maxAge) <= 0) ||
        (expires !== undefined && Date.parse(expires) <= Date.now());
      if (gone) this.c.delete(name); else this.c.set(name, value);
    }
  }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join("; "); }
}

const titleOf = (html) => cheerio.load(html)("title").first().text().trim().slice(0, 80);

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
    if (!email || !password) {
      const missing = [!email && "TAPESTRY_EMAIL", !password && "TAPESTRY_PASSWORD"].filter(Boolean).join(" and ");
      throw new AuthError(`${missing} not set in the MCP server's environment.`);
    }
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
    // Session cookies only ever go to Tapestry itself, even mid-redirect.
    const cookie = this.jar.header();
    if (cookie && new URL(url).host === new URL(this.baseUrl).host) headers.Cookie = cookie;
    let res;
    try {
      res = await fetch(url, {
        ...opts, headers, redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
      });
    } catch (e) {
      const why = e.cause?.code || e.cause?.message || e.name || e.message;
      throw new TapestryError(`Could not reach ${new URL(url).host} (${why}) — check the MCP host has internet access.`);
    }
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
    debug(`GET login page -> HTTP ${page.status} at ${page.finalUrl}`);
    if (!page.ok) throw new TapestryError(`Tapestry login page returned HTTP ${page.status}.`);
    const html = await page.text();
    const csrf = extractCsrf(html);
    if (!csrf) throw new AuthError("Could not find the CSRF token on the Tapestry login page (the page layout may have changed).");

    const $ = cheerio.load(html);
    // The page can carry other forms (search, cookie banner); use the one with the password box.
    let $form = $("form").filter((_, el) => $(el).find('input[type="password"]').length > 0).first();
    if (!$form.length) $form = $("form").first();
    const action = $form.attr("action");
    const postUrl = action ? new URL(action, page.finalUrl).href : this._loginUrl;
    const form = new URLSearchParams();
    $form.find("input").each((_, el) => {
      const name = $(el).attr("name"); const type = ($(el).attr("type") || "").toLowerCase();
      if (!name) return;
      if (name === "_token") form.set(name, csrf);
      else if (type === "email" || ["email", "username", "login"].includes(name)) form.set(name, this.email);
      else if (type === "password" || name === "password") form.set(name, this.password);
      else if (["hidden", "checkbox", "radio"].includes(type)) form.set(name, $(el).attr("value") || "");
    });
    for (const [k, v] of [["_token", csrf], ["email", this.email], ["password", this.password], ["remember", "1"]])
      if (!form.has(k)) form.set(k, v);

    debug(`POST ${postUrl} with fields [${[...form.keys()].join(", ")}]`);
    const post = await this._fetch(postUrl, {
      method: "POST", body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: page.finalUrl, Origin: new URL(postUrl).origin },
    });
    const loc = post.headers.get("location");
    debug(`POST -> HTTP ${post.status}${loc ? ` redirect to ${loc}` : ""}`);
    if (post.status === 419) throw new AuthError("Tapestry login failed: HTTP 419 (session/CSRF token rejected).");
    if (post.status === 429) throw new AuthError("Tapestry login failed: HTTP 429 (too many attempts — wait a while before retrying).");
    if (post.status >= 400) throw new AuthError(`Tapestry login failed: HTTP ${post.status} from ${postUrl}.`);
    const final = loc ? await this._get(new URL(loc, postUrl).href) : post;
    const finalUrl = final.finalUrl || postUrl;
    const body = await final.text();
    debug(`ended at ${finalUrl} (HTTP ${final.status})`);

    if (/two.factor|verification code|authenticator/i.test(body))
      throw new AuthError("Tapestry login failed: the account asks for a 2FA code, which isn't supported.");
    // Still looking at a password box (or back on /login) means the login didn't take.
    const onLogin = new URL(finalUrl).pathname.replace(/\/$/, "") === new URL(this._loginUrl).pathname ||
      cheerio.load(body)('input[type="password"]').length > 0;
    if (onLogin) {
      const why = /\bincorrect\b|\bthese credentials\b|\binvalid\b|do not match/i.test(body)
        ? "Tapestry rejected the email or password"
        : "still on the login page after submitting (wrong email/password, or SSO-only account)";
      throw new AuthError(`Tapestry login failed: ${why}. Tried email: "${this.email}".`);
    }
    this.landedAt = new URL(finalUrl).pathname;
    this.schoolSlug = finalUrl.match(/\/s\/([^/]+)\//)?.[1] || "";
    this.csrf = extractCsrf(body) || csrf;
    this.loggedIn = true;
    console.error(`[tapestry-mcp] logged in (school: ${this.schoolSlug || "?"}, landed on ${this.landedAt})`);
    debug(`cookies held: [${[...this.jar.c.keys()].join(", ")}]; API CSRF token ${this.csrf === csrf ? "same as login page's" : "from post-login page"}`);
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
    const loc = res.headers.get("location") || "";
    let why = "";
    if ([401, 419].includes(res.status)) why = `HTTP ${res.status}`;
    else if (res.status >= 300 && res.status < 400 && loc.includes("login")) why = `HTTP ${res.status} redirect to ${loc}`;
    else if (res.ok) {
      const body = await res.text();
      // Trust the body over the content-type header: valid JSON is a good answer.
      try { return JSON.parse(body); } catch { /* not JSON */ }
      why = `HTTP ${res.status} ${ct || "no content-type"}, page "${titleOf(body) || "untitled"}" instead of JSON`;
    }
    debug(`API ${path} -> HTTP ${res.status} ${ct}${loc ? ` -> ${loc}` : ""}`);
    if (why) {
      if (!retry) throw new AuthError(
        `Tapestry rejected the API request even after logging in again (${why}). ` +
        `Login ended at ${this.landedAt || "?"}${this.schoolSlug ? "" : " with no school in the URL"}. ` +
        "Set TAPESTRY_DEBUG=1 for the full login trace.");
      this.loggedIn = false;
      return this.api(path, params, false);
    }
    if (res.status === 404) throw new TapestryError(`Not found: ${path}`);
    throw new TapestryError(`Tapestry API ${path} returned HTTP ${res.status}${loc ? ` (redirect to ${loc})` : ""}`);
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
