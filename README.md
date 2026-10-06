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
| Package identifier | `github:Mpercy-Git/tapestry-mcp` (pin with `github:Mpercy-Git/tapestry-mcp#v0.2.2`) |
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

## Troubleshooting login

- Use the variable names exactly: `TAPESTRY_EMAIL` (or `TAPESTRY_USERNAME`) and `TAPESTRY_PASSWORD`. The value is the **email address** you sign in to tapestryjournal.com with — check it works in a browser first.
- Accounts that sign in with Google/Microsoft only, or that need a 2FA code, can't be used.
- Add `TAPESTRY_DEBUG=1` to the env to log each login step (status codes, URLs, form field names — never the password) to the server's stderr.
- The error message says which step failed: unreachable host, HTTP 419/429, a 2FA prompt, or back on the login page.

## Notes

- Session cookies are only sent to `tapestryjournal.com`; media on other hosts (CDN) is fetched without them.
- If a field comes back empty, call `get_observation` with `include_raw: true` and adjust the mapping in `src/server.js`.

## Dev

```bash
npm install && npm test
```

Requires Node 20+. No build step — plain ES modules, so installing straight from GitHub works.

## Releasing

Bump `version` in `package.json` and in `server.json` (top-level and under `packages`), then merge to `main`. The **Release** workflow runs the tests, tags `v<version>` and publishes a GitHub release with the `npm pack` tarball attached. Pushes that don't change the version are a no-op; it can also be run by hand from the Actions tab.
