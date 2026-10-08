# @pipeworx/usgs-mineral-commodities

USGS Mineral Commodity Summaries (MCS) — U.S. production, imports, exports,
consumption, price, employment and net import reliance for 85 nonfuel
mineral commodities (lithium, copper, cobalt, rare earths, gold, aluminum,
nickel, platinum-group metals, and dozens of industrial minerals), plus
world mine/plant production and reserves by country for 75 of them.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1721+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `mcs_list_commodities(query?, limit?)` — browse the 85 commodities this
  release covers; each entry names its own stat columns (every commodity's
  MCS chapter defines its own table) and whether a world comparison table
  (`mcs_country_comparison`) is available for it.
- `mcs_commodity_data(commodity)` — one commodity's U.S. salient statistics:
  the most recent 5 years of production, imports, exports, consumption,
  price, employment, and NET IMPORT RELIANCE — the share of U.S. consumption
  that comes from imports. Accepts a common name ("lithium", "rare earths",
  "platinum group metals") or the MCS code.
- `mcs_country_comparison(commodity, countries?, limit?)` — world mine/plant
  production (prior-year actual + current-year estimate) and reserves, by
  country, for one commodity — "which countries hold lithium reserves",
  "China vs. Australia rare-earth production". Covers 75 of 85 commodities
  (see "Known gaps" below for the other 10).

## Auth

Keyless.

## Data sources

USGS's National Minerals Information Center publishes MCS once a year as a
**file-only** ScienceBase data release — verified live 2026-10-07:
[ScienceBase item `677eaf95d34e760b392c4970`](https://doi.org/10.5066/P13XCP3R)
("U.S. Geological Survey Mineral Commodity Summaries 2025 Data Release, ver.
2.0, April 2025") carries two ZIPs of CSV tables and a revision-notes `.txt`
— no JSON/REST endpoint of any kind:

- `Salient_Commodity_Data_Release_Grouped_MCS_2025.zip` — one
  `mcs2025-<code>_salient.csv` per commodity (85 commodities), U.S. salient
  statistics for the most recent 5 years. Column names vary per commodity.
- `World_Data_Release_MCS_2025.zip` — one `MCS2025_World_Data.csv`, world
  mine/plant production (2023 actual + 2024 estimate in this release) and
  2024 reserves, by country, for ~79 commodity groupings (coarser than the
  85 salient codes).

`scripts/bake-index.mjs` downloads both, parses every CSV, matches salient
commodities to world-table rows by name (with a short hand-checked alias
list for naming differences between the two publications — see the
script's own comments, including one USGS typo: "Germanium" vs. the world
table's "Gemanium"), and writes `src/mcs-index-data.ts`.

## Why this bakes a table in rather than calling a live endpoint

The MCS data release is file-only — there is no API to proxy. Root
CLAUDE.md's standing guidance covers exactly this shape (a source that only
publishes bulk files), and US federal data (USGS) is public domain, so
baking the release's own published numbers into this pack needs no reuse
grant. Refresh path: USGS publishes a new MCS release every January
(sometimes revised again in spring, as 2025's "ver. 2.0" was) — re-run
`node scripts/bake-index.mjs > src/mcs-index-data.ts` against the new
release's ScienceBase item id when one is published.

## Why the baked table isn't a static import

The table is ~430 salient rows + 1,250 world rows (~509KB as JSON). A static
`import` would put the whole thing into every gateway isolate's heap
whether or not that isolate ever serves this pack — exactly the failure six
state-code packs caused on 2026-10-07 (fleet #2754: ~48MB of retained heap
and about one gateway call in four dying as a Cloudflare 1102). Instead the
table is uploaded to KV at deploy
(`workers/gateway/src/pack-baked-indexes.json` registers it;
`scripts/sync-gateway-static-json.mjs` uploads it) and the gateway injects
the parsed object as `args._bakedIndex` on the first call into this pack —
adopted once per isolate. A missing or malformed injection throws loudly
(see `src/index.test.ts`) rather than answering as if a commodity or
country were simply not found.

## Known gaps

- 10 of the 85 commodities have no row in the MCS world production/reserves
  table in this release — mostly scrap/slag/crushed-stone categories USGS
  tracks only domestically, plus a few rare elements (scandium, thallium,
  thorium) with no global reserve estimate published: Iron and Steel Scrap,
  Iron and Steel Slag, Quartz Crystal (Industrial), Sand and Gravel
  (Construction), Scandium, Stone (Crushed), Stone (Dimension), Thallium,
  Thorium, Yttrium. `mcs_country_comparison` returns `found: false,
  reason: "no_world_data"` for these rather than an empty row list.
- Raw USGS footnote codes (`W` = withheld to avoid disclosing company
  proprietary data, `E` = estimated, `NA` = not available, `">50"` on net
  import reliance, free-text notes like `"Less than 1/2 unit."`) are passed
  through verbatim, never coerced to numbers or nulled out — every tool's
  response includes a `footnote_legend` field.
- This is a point-in-time annual release, not a live feed. Every response
  carries `data_as_of` (the bake's capture timestamp) and `release_year`.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "usgs-mineral-commodities": {
      "url": "https://gateway.pipeworx.io/usgs-mineral-commodities/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/usgs-mineral-commodities/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1721+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/mcs_list_commodities \
  -H 'Content-Type: application/json' \
  -d '{"query":"lithium"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/mcs_list_commodities`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "usgs-mineral-commodities": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-usgs-mineral-commodities"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-usgs-mineral-commodities
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Usgs Mineral Commodities data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
