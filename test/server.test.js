import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { TapestryClient, extractCsrf } from "../src/client.js";

const OBS = [
  { id: 3, title: "Painting", createdAt: "2026-09-30T10:00:00Z", notes: "<p>Mixed <b>blue</b> and yellow.</p>",
    children: [{ id: 7, fullName: "Alex P" }], mediaCount: 1,
    media: [{ id: 11, type: "image", url: "https://media.example/a.jpg" }], frameworks: [{ name: "Expressive Arts" }] },
  { id: 2, title: "Story time", createdAt: "2026-09-15T10:00:00Z", notes: "Listened to a story",
    children: [{ id: 7, fullName: "Alex P" }] },
  { id: 1, title: "Settling in", createdAt: "2026-09-01T10:00:00Z", notes: "First day" },
];

async function connect(getClient) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(getClient).connect(a);
  const c = new Client({ name: "t", version: "1" });
  await c.connect(b);
  return c;
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  assert.ok(!r.isError, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};

const fake = {
  children: async () => [{ id: 7, fullName: "Alex P", group: { name: "Rainbows" } }],
  async *iterObservations(_c, max = Infinity) { yield* OBS.slice(0, max); },
  observation: async (id) => OBS.find((o) => String(o.id) === String(id)),
};

test("tools, filtering, detail and search", async () => {
  const c = await connect(() => fake);
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["download_media", "get_observation", "list_children", "list_observations", "search_observations"]);
  assert.deepEqual(await call(c, "list_children"), [{ id: 7, name: "Alex P", group: "Rainbows", date_of_birth: null }]);
  assert.deepEqual((await call(c, "list_observations", { since: "2026-09-10", until: "2026-09-20" })).map((o) => o.id), [2]);
  const d = await call(c, "get_observation", { observation_id: "3" });
  assert.match(d.notes, /blue/); assert.doesNotMatch(d.notes, /</);
  assert.deepEqual(d.tags, ["Expressive Arts"]); assert.equal(d.media[0].id, 11);
  assert.deepEqual((await call(c, "search_observations", { query: "expressive arts" })).map((o) => o.id), [3]);
});

test("missing credentials surface as a tool error, not a crash", async () => {
  const c = await connect(() => new TapestryClient("", ""));
  const r = await c.callTool({ name: "list_children", arguments: {} });
  assert.ok(r.isError); assert.match(r.content[0].text, /TAPESTRY_EMAIL/);
});

test("csrf extraction", () => {
  assert.equal(extractCsrf('<div class="hidden">{"csrfToken":"abc"}</div>'), "abc");
  assert.equal(extractCsrf('<meta name="csrf-token" content="xyz">'), "xyz");
});

test("real client against a mock Tapestry: login, cookies, pagination, re-login", async () => {
  let sessions = 0, expireNext = false;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"); const cookie = req.headers.cookie || "";
    if (u.pathname === "/login" && req.method === "GET") {
      res.setHeader("Set-Cookie", "XSRF=pre; Path=/");
      return res.end('<form><input type="hidden" name="_token" value="t1"><input type="email" name="email"><input type="password" name="password"></form>');
    }
    if (u.pathname === "/login" && req.method === "POST") {
      let body = ""; req.on("data", (d) => (body += d)); return req.on("end", () => {
        const f = new URLSearchParams(body);
        if (f.get("password") !== "pw" || f.get("_token") !== "t1" || !cookie.includes("XSRF=pre")) {
          res.writeHead(302, { Location: "/login" }); return res.end();
        }
        sessions++;
        res.writeHead(302, { Location: "/s/acorn-nursery/observations", "Set-Cookie": `sess=s${sessions}; Path=/` }); res.end();
      });
    }
    if (u.pathname.startsWith("/s/")) return res.end('<div class="hidden">{"csrfToken":"api-tok"}</div>');
    if (!cookie.includes(`sess=s${sessions}`) || req.headers["x-csrf-token"] !== "api-tok" || expireNext) {
      expireNext = false; res.writeHead(401); return res.end();
    }
    res.setHeader("Content-Type", "application/json");
    if (u.pathname === "/api/4/children/list") return res.end(JSON.stringify([{ id: 7, fullName: "Alex P" }]));
    if (u.pathname === "/api/4/observations/list") {
      const page = u.searchParams.get("cursor") ? [OBS[2]] : [OBS[0], OBS[1]];
      return res.end(JSON.stringify({ observations: page, nextCursor: u.searchParams.get("cursor") ? null : "c2" }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    // Point the module's LOGIN_URL at the mock by constructing with baseUrl and patching login URL use.
    const client = new TapestryClient("me@x", "pw", { baseUrl: base });
    client._loginUrl = `${base}/login`;
    const c = await connect(() => client);
    assert.equal((await call(c, "list_children"))[0].name, "Alex P");
    assert.equal(client.schoolSlug, "acorn-nursery");
    assert.deepEqual((await call(c, "list_observations", { limit: 10 })).map((o) => o.id), [3, 2, 1]);
    expireNext = true; // simulate session expiry → should transparently log in again
    assert.equal((await call(c, "list_children")).length, 1);
    assert.equal(sessions, 2);
    const bad = new TapestryClient("me@x", "wrong", { baseUrl: base }); bad._loginUrl = `${base}/login`;
    await assert.rejects(bad.children(), /login failed/i);
  } finally { srv.close(); }
});

test("login uses the form with the password box and posts to its action; HTTP errors are reported", async () => {
  let status = 302;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/login" && req.method === "GET")
      return res.end('<form action="/search"><input name="q"></form>' +
        '<form action="/auth/login" method="post"><input type="hidden" name="_token" value="t1">' +
        '<input type="email" name="email"><input type="password" name="password"></form>');
    if (u.pathname === "/auth/login" && req.method === "POST") {
      if (status !== 302) { res.writeHead(status); return res.end(); }
      res.writeHead(302, { Location: "/s/oak/observations", "Set-Cookie": "sess=1; Path=/" }); return res.end();
    }
    if (u.pathname.startsWith("/s/")) return res.end('<div class="hidden">{"csrfToken":"api-tok"}</div>');
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const client = new TapestryClient("me@x", "pw", { baseUrl: base });
    await client.login();
    assert.equal(client.schoolSlug, "oak");
    status = 419;
    await assert.rejects(new TapestryClient("me@x", "pw", { baseUrl: base }).login(), /HTTP 419/);
  } finally { srv.close(); }
});

test("missing credentials name the unset variable", () => {
  assert.throws(() => new TapestryClient("me@x", ""), /TAPESTRY_PASSWORD not set/);
});

test("API: JSON with the wrong content-type is accepted; deleted cookies aren't resent; rejection says why", async () => {
  let reject = false, sawDeleted = false;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"); const cookie = req.headers.cookie || "";
    // The login POST legitimately carries "old"; only requests after it deletes the cookie count.
    if (u.pathname !== "/login" && cookie.includes("old=")) sawDeleted = true;
    if (u.pathname === "/login" && req.method === "GET") {
      res.setHeader("Set-Cookie", "old=1; Path=/");
      return res.end('<form><input type="hidden" name="_token" value="t1"><input type="email" name="email"><input type="password" name="password"></form>');
    }
    if (u.pathname === "/login" && req.method === "POST") {
      res.writeHead(302, { Location: "/s/oak/observations",
        "Set-Cookie": ["old=; Path=/; Max-Age=0", "sess=1; Path=/"] });
      return res.end();
    }
    if (u.pathname.startsWith("/s/")) return res.end('<div class="hidden">{"csrfToken":"api-tok"}</div>');
    if (reject) { res.setHeader("Content-Type", "text/html"); return res.end("<title>Log in</title>"); }
    res.setHeader("Content-Type", "text/html");
    res.end(JSON.stringify([{ id: 1, fullName: "Sam" }]));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const client = new TapestryClient("me@x", "pw", { baseUrl: base });
    assert.equal((await client.children())[0].fullName, "Sam");
    assert.equal(sawDeleted, false);
    reject = true;
    await assert.rejects(client.children(), /page "Log in" instead of JSON.*ended at \/s\/oak\/observations/);
  } finally { srv.close(); }
});

test("multi-school accounts: /select-school is resolved via links, forms, or TAPESTRY_SCHOOL", async () => {
  let page = "links";
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"); const cookie = req.headers.cookie || "";
    if (u.pathname === "/login" && req.method === "GET")
      return res.end('<form><input type="hidden" name="_token" value="t1"><input type="email" name="email"><input type="password" name="password"></form>');
    if (u.pathname === "/login" && req.method === "POST") {
      res.writeHead(302, { Location: "/select-school", "Set-Cookie": "sess=1; Path=/" }); return res.end();
    }
    if (u.pathname === "/select-school" && req.method === "GET") {
      // Real Tapestry markup: a home link plus /visit-school/<id> per school.
      if (page === "visit")
        return res.end(`<a href="${base}">Tapestry</a><a href="${base}/visit-school/48405">Oak Nursery</a>`);
      if (page === "links")
        return res.end('<a href="/logout">Log out</a><a href="/s/oak/observations">Oak Nursery</a> <a href="/s/elm/observations">Elm Primary</a>');
      return res.end('<form method="post" action="/select-school"><input type="hidden" name="_token" value="t2">' +
        '<button name="school_id" value="11">Oak Nursery</button><button name="school_id" value="22">Elm Primary</button></form>');
    }
    if (u.pathname === "/select-school" && req.method === "POST") {
      let body = ""; req.on("data", (d) => (body += d)); return req.on("end", () => {
        const slug = { 11: "oak", 22: "elm" }[new URLSearchParams(body).get("school_id")];
        res.writeHead(302, { Location: `/s/${slug}/observations`, "Set-Cookie": `school=${slug}; Path=/` }); res.end();
      });
    }
    if (u.pathname === "/visit-school/48405") { res.writeHead(302, { Location: "/s/oak/observations" }); return res.end(); }
    const m = u.pathname.match(/^\/s\/(\w+)\//);
    if (m) {
      res.setHeader("Set-Cookie", `school=${m[1]}; Path=/`);
      return res.end('<div class="hidden">{"csrfToken":"api-tok"}</div>');
    }
    if (!cookie.includes("school=")) { res.writeHead(401); return res.end(); }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify([{ id: 1, fullName: cookie.match(/school=(\w+)/)[1] }]));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    page = "visit";
    const visit = new TapestryClient("me@x", "pw", { baseUrl: base });
    assert.equal((await visit.children())[0].fullName, "oak");
    assert.equal(visit.schoolSlug, "oak");

    page = "links";
    const first = new TapestryClient("me@x", "pw", { baseUrl: base });
    assert.equal((await first.children())[0].fullName, "oak");
    assert.equal(first.schoolSlug, "oak");

    const chosen = new TapestryClient("me@x", "pw", { baseUrl: base, school: "elm" });
    assert.equal((await chosen.children())[0].fullName, "elm");

    page = "form";
    const byName = new TapestryClient("me@x", "pw", { baseUrl: base, school: "Elm Prim" });
    assert.equal((await byName.children())[0].fullName, "elm");

    await assert.rejects(new TapestryClient("me@x", "pw", { baseUrl: base, school: "Birch" }).login(),
      /TAPESTRY_SCHOOL "Birch" doesn't match.*"Oak Nursery", "Elm Primary"/);
  } finally { srv.close(); }
});
