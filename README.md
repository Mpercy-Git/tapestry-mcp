# tapestry-mcp

Unofficial, **read-only** MCP server for the [Tapestry](https://tapestry.info) learning journal (`tapestryjournal.com`, Android `com.fsf.tapestry`), for parents and carers.

Tapestry has no public API. This logs in with your own email and password and calls the same internal `/api/4/…` endpoints the web app uses (found via [tapestry-scraper](https://github.com/ketchupcat-gh/tapestry-scraper)). It may break if Tapestry changes their web app. Accounts using 2FA or SSO-only login aren't supported.

## Tools

| Tool | What it does |
|---|---|
| `list_children` | Children on the account (ids for filtering) |
| `list_observations` | Newest-first summaries; `child_id`, `since`/`until` (YYYY-MM-DD), `limit` |
| `get_observation` | Full notes (HTML stripped), tags/EYFS links, comments, media URLs; `include_raw` for the raw JSON |
| `search_observations` | Keyword search over titles, notes and tags |
| `download_media` | Saves an observation's photos/videos to `TAPESTRY_DOWNLOAD_DIR/<date>_<id>/` |

## Add to Frona

**Settings → MCP → Custom → Local package**

| Field | Value |
|---|---|
| Runtime | `npm` |
| Package identifier | `github:Mpercy-Git/tapestry-mcp` (pin with `github:Mpercy-Git/tapestry-mcp#v0.2.0`) |
| Transport | `stdio` |
| Env | `TAPESTRY_EMAIL`, `TAPESTRY_PASSWORD` (bind the password to a vault credential if you prefer), optional `TAPESTRY_DOWNLOAD_DIR` |

## Other MCP clients

```json
{
  "mcpServers": {
    "tapestry": {
      "command": "npx",
      "args": ["-y", "github:Mpercy-Git/tapestry-mcp"],
      "env": { "TAPESTRY_EMAIL": "you@example.com", "TAPESTRY_PASSWORD": "…" }
    }
  }
}
```

## Notes

- Session cookies are only sent to `tapestryjournal.com`; media on other hosts (CDN) is fetched without them.
- If a field comes back empty, call `get_observation` with `include_raw: true` and adjust the mapping in `src/server.js`.

## Dev

```bash
npm install && npm test
```

Requires Node 20+. No build step — plain ES modules, so installing straight from GitHub works.
