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

/**
 * Schools offered on Tapestry's /select-school page (accounts linked to more than one school).
 * Handles links into /s/<slug>/ or /visit-school/<id> (what Tapestry serves), a <select> of schools, or one form/button per school.
 */
export function schoolChoices(html, pageUrl) {
  const $ = cheerio.load(html);
  const out = [];
  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const seen = new Set();
  $("a[href]").each((_, el) => {
    let url;
    try { url = new URL($(el).attr("href"), pageUrl); } catch { return; }
    const slug = url.pathname.match(/^\/s\/([^/]+)/)?.[1];
    const isChoice = slug || /(select|visit)-school\/[^/]+/.test(url.pathname) || /[?&]school(_?id)?=/i.test(url.search);
    const key = slug || url.href;
    if (!isChoice || seen.has(key) || url.host !== new URL(pageUrl).host) return;
    seen.add(key);
    out.push({ name: clean($(el).text()) || slug || url.pathname, slug, url: url.href, method: "GET" });
  });
  if (out.length) return out;
  $("form").each((_, f) => {
    const $f = $(f);
    const url = new URL($f.attr("action") || pageUrl, pageUrl).href;
    if (/logout|sign-?out/i.test(url)) return;
    const method = ($f.attr("method") || "GET").toUpperCase();
    const base = {};
    $f.find("input[name]").each((_, i) => {
      const type = ($(i).attr("type") || "").toLowerCase();
      if (!["submit", "button", "image"].includes(type)) base[$(i).attr("name")] = $(i).attr("value") || "";
    });
    const $select = $f.find("select[name]").first();
    const $buttons = $f.find("button[name][value], input[type=submit][name][value]");
    if ($select.length) {
      $select.find("option").each((_, o) => {
        const v = $(o).attr("value");
        if (v) out.push({ name: clean($(o).text()) || v, url, method, fields: { ...base, [$select.attr("name")]: v } });
      });
    } else if ($buttons.length) {
      $buttons.each((_, b) => out.push({
        name: clean($(b).text()) || $(b).attr("value"), url, method, fields: { ...base, [$(b).attr("name")]: $(b).attr("value") },
      }));
    } else if (Object.keys(base).length) {
      out.push({ name: clean($f.text()).slice(0, 80) || url, url, method, fields: base });
    }
  });
  return out;
}

export class TapestryClient {
  constructor(email, password, { baseUrl = BASE_URL, timeoutMs = 30000, school = "" } = {}) {
    if (!email || !password) {
      const missing = [!email && "TAPESTRY_EMAIL", !password && "TAPESTRY_PASSWORD"].filter(Boolean).join(" and ");
      throw new AuthError(`${missing} not set in the MCP server's environment.`);
    }
    Object.assign(this, { email, password, baseUrl, timeoutMs, school });
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
    let finalUrl = final.finalUrl || postUrl;
    let body = await final.text();
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
    let landed = { url: finalUrl, body };
    if (/select-school/i.test(new URL(finalUrl).pathname)) landed = await this._selectSchool(finalUrl, body, csrf);
    [finalUrl, body] = [landed.url, landed.body];
    this.landedAt = new URL(finalUrl).pathname;
    this.schoolSlug = finalUrl.match(/\/s\/([^/]+)\//)?.[1] || "";
    this.csrf = extractCsrf(body) || csrf;
    this.loggedIn = true;
    console.error(`[tapestry-mcp] logged in (school: ${this.schoolSlug || "?"}, landed on ${this.landedAt})`);
    debug(`cookies held: [${[...this.jar.c.keys()].join(", ")}]; API CSRF token ${this.csrf === csrf ? "same as login page's" : "from post-login page"}`);
  }

  /** Pick a school on /select-school: TAPESTRY_SCHOOL (slug or part of the name) if set, else the first. */
  async _selectSchool(pageUrl, html, csrf) {
    const choices = schoolChoices(html, pageUrl);
    debug(`select-school offers: ${choices.map((c) => `"${c.name}"`).join(", ") || "nothing recognisable"}`);
    if (!choices.length) {
      const $ = cheerio.load(html);
      debug(`select-school links: ${$("a[href]").map((_, a) => $(a).attr("href")).get().join(" ")}`);
      throw new AuthError("Tapestry asked to choose a school (/select-school), but no schools could be read from that page. " +
        "Set TAPESTRY_DEBUG=1 and share the trace so the page can be supported.");
    }
    const want = this.school.trim().toLowerCase();
    const pick = want
      ? choices.find((c) => c.slug?.toLowerCase() === want || c.name.toLowerCase().includes(want))
      : choices[0];
    if (!pick) throw new AuthError(`TAPESTRY_SCHOOL "${this.school}" doesn't match any school on this account: ` +
      `${choices.map((c) => `"${c.name}"`).join(", ")}.`);
    if (!want && choices.length > 1) console.error(`[tapestry-mcp] account has ${choices.length} schools ` +
      `(${choices.map((c) => c.name).join(", ")}); using "${pick.name}". Set TAPESTRY_SCHOOL to choose.`);

    let res;
    if (pick.method === "POST") {
      const form = new URLSearchParams(pick.fields);
      if (!form.has("_token")) form.set("_token", extractCsrf(html) || csrf);
      res = await this._fetch(pick.url, {
        method: "POST", body: form, headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: pageUrl },
      });
      const loc = res.headers.get("location");
      if (loc) res = await this._get(new URL(loc, pick.url).href);
    } else {
      const url = new URL(pick.url);
      for (const [k, v] of Object.entries(pick.fields || {})) url.searchParams.set(k, v);
      res = await this._get(url.href);
    }
    const url = res.finalUrl || pick.url;
    debug(`chose "${pick.name}" -> HTTP ${res.status} at ${url}`);
    if (!res.ok || /select-school/i.test(new URL(url).pathname))
      throw new AuthError(`Choosing school "${pick.name}" didn't work (HTTP ${res.status}, at ${new URL(url).pathname}).`);
    return { url, body: await res.text() };
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
