interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * USGS Mineral Commodity Summaries (MCS) — U.S. production, imports,
 * exports, consumption, price, employment and net import reliance for 85
 * nonfuel mineral commodities, plus world mine/plant production and
 * reserves by country for 75 of them. Fleet #2722.
 *
 * SOURCE AND SHAPE. The USGS National Minerals Information Center publishes
 * MCS once a year as a file-only ScienceBase data release — verified live
 * 2026-10-07 (ScienceBase item 677eaf95d34e760b392c4970, DOI
 * 10.5066/P13XCP3R): two ZIPs of CSV tables (US "salient statistics" per
 * commodity, world production+reserves in one combined CSV) and a revision
 * notes .txt, no JSON/REST endpoint of any kind. Root CLAUDE.md's standing
 * guidance covers exactly this shape — a source that only publishes bulk
 * files, or whose live API would be too slow/throttled to serve a caller —
 * and US federal data (USGS) is public domain, so baking the release's own
 * published numbers into this pack needs no reuse grant. See
 * scripts/bake-index.mjs for the full parsing notes and the refresh path
 * (USGS publishes a new release every January).
 *
 * The baked table (src/mcs-index-data.ts, ~430 salient rows + 1,250 world
 * rows) is NOT a static import — see the fleet #2754 note below — the
 * gateway loads it from KV on first call and injects it as
 * `args._bakedIndex`.
 *
 * THREE TOOLS:
 *   - mcs_list_commodities  — browse all 85 commodities this release covers.
 *   - mcs_commodity_data    — one commodity's U.S. time series: production,
 *     imports, exports, consumption, price, employment, and net import
 *     reliance (NIR) — the specific "import reliance" ask.
 *   - mcs_country_comparison — one commodity's world mine/plant production
 *     (prior-year actual + current-year estimate) and reserves BY COUNTRY,
 *     for cross-country comparison. Not every commodity has a world table
 *     (see mcs-index-data.ts's bake notes for which 10 of 85 don't, and why).
 *
 * Raw USGS footnote codes (W = withheld to avoid disclosing company
 * proprietary data, E = estimated, NA = not available, ">50" = import
 * reliance greater than the indicated percent, free-text notes like "Less
 * than 1/2 unit.") are passed through verbatim rather than coerced to
 * numbers or nulled out — coercing "W" to 0 would silently misrepresent a
 * disclosure-avoidance footnote as "no production".
 *
 * Keyless.
 */
import type { McsCommodityMeta, McsSalientRow, McsWorldRow } from './mcs-index-data.js';

// fleet #2754 (LIVE INCIDENT 2026-10-07): a baked table this size as a
// static `import` would sit in every gateway isolate's heap whether or not
// that isolate ever serves this pack (six state-code packs doing exactly
// that put ~48MB of retained heap into every isolate and cost about one
// gateway call in four as Cloudflare 1102). This index is instead uploaded
// to KV at deploy (workers/gateway/src/pack-baked-indexes.json registers it;
// scripts/sync-gateway-static-json.mjs uploads it) and the gateway injects
// the parsed object as `args._bakedIndex` on every call into this pack —
// adopted once per isolate, then shared by reference.
//
// NEVER value-import ./mcs-index-data.js here again — a type-only import
// (as above) is erased at compile time; a value import puts the whole table
// back into the bundle and every isolate's heap. The deploy workflow's
// bundle-size ceiling (scripts/check-gateway-bundle-size.mjs) fails the
// deploy if that happens.
let MCS_COMMODITIES: McsCommodityMeta[] = [];
let MCS_SALIENT: McsSalientRow[] = [];
let MCS_WORLD: McsWorldRow[] = [];
let MCS_RELEASE_YEAR = '';
let MCS_WORLD_PRIOR_YEAR = '';
let MCS_WORLD_EST_YEAR = '';
let MCS_WORLD_RESERVES_YEAR = '';
let MCS_SOURCE_URL = '';
let MCS_INDEX_CAPTURED_AT = '';

function ensureIndex(args: Record<string, unknown>): void {
  if (MCS_COMMODITIES.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const commodities = idx?.MCS_COMMODITIES;
  const salient = idx?.MCS_SALIENT;
  const world = idx?.MCS_WORLD;
  if (!Array.isArray(commodities) || !Array.isArray(salient) || !Array.isArray(world) || commodities.length === 0) {
    // Loud on purpose: answering "no such commodity" from an empty table
    // would be a silent wrong answer indistinguishable from a real miss.
    throw new Error(
      `usgs-mineral-commodities: the baked MCS index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad commodity name — retry shortly.',
    );
  }
  MCS_COMMODITIES = commodities as McsCommodityMeta[];
  MCS_SALIENT = salient as McsSalientRow[];
  MCS_WORLD = world as McsWorldRow[];
  MCS_RELEASE_YEAR = String(idx?.MCS_RELEASE_YEAR ?? '');
  MCS_WORLD_PRIOR_YEAR = String(idx?.MCS_WORLD_PRIOR_YEAR ?? '');
  MCS_WORLD_EST_YEAR = String(idx?.MCS_WORLD_EST_YEAR ?? '');
  MCS_WORLD_RESERVES_YEAR = String(idx?.MCS_WORLD_RESERVES_YEAR ?? '');
  MCS_SOURCE_URL = String(idx?.MCS_SOURCE_URL ?? 'https://doi.org/10.5066/P13XCP3R');
  MCS_INDEX_CAPTURED_AT = String(idx?.MCS_INDEX_CAPTURED_AT ?? '');
}

const SOURCE_LABEL = 'USGS National Minerals Information Center, Mineral Commodity Summaries, keyless';
const FOOTNOTE_LEGEND = {
  W: 'Withheld to avoid disclosing company proprietary data; included in any U.S. or world total.',
  E: 'Estimated.',
  NA: 'Not available.',
  '--': 'Not applicable / zero.',
  '>NN': 'A number preceded by ">" (e.g. ">50") on net import reliance means reliance is greater than the indicated percent, usually because a production figure feeding the calculation was withheld (W).',
  free_text: 'Some cells carry a plain-English USGS note instead of a code (e.g. "Less than 1/2 unit.") — passed through verbatim.',
};

interface ResolveResult {
  exact: boolean;
  matches: McsCommodityMeta[];
}

/** Resolve a free-text commodity name/code to one or more MCS_COMMODITIES rows. */
function resolveCommodity(raw: string): ResolveResult {
  const q = raw.trim().toLowerCase();
  if (!q) return { exact: false, matches: [] };

  const byCode = MCS_COMMODITIES.filter((c) => c.code.toLowerCase() === q);
  if (byCode.length === 1) return { exact: true, matches: byCode };

  const byName = MCS_COMMODITIES.filter((c) => c.name.toLowerCase() === q);
  if (byName.length === 1) return { exact: true, matches: byName };

  const starts = MCS_COMMODITIES.filter((c) => {
    const n = c.name.toLowerCase();
    return n.startsWith(q) || q.startsWith(n);
  });
  if (starts.length >= 1) return { exact: false, matches: starts };

  const sub = MCS_COMMODITIES.filter((c) => {
    const n = c.name.toLowerCase();
    return n.includes(q) || q.includes(n);
  });
  if (sub.length >= 1) return { exact: false, matches: sub };

  // Token-overlap fallback for phrasing like "rare earth elements" ->
  // "Rare earths", or "platinum group metals" -> "Platinum-Group metals".
  const qWords = q.split(/[^a-z0-9]+/).filter(Boolean);
  if (qWords.length === 0) return { exact: false, matches: [] };
  const scored = MCS_COMMODITIES.map((c) => {
    const nWords = c.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const overlap = qWords.filter((w) => nWords.some((nw) => nw.startsWith(w) || w.startsWith(nw))).length;
    return { c, overlap };
  }).filter((x) => x.overlap > 0);
  if (scored.length === 0) return { exact: false, matches: [] };
  const top = Math.max(...scored.map((x) => x.overlap));
  return { exact: false, matches: scored.filter((x) => x.overlap === top).map((x) => x.c) };
}

function commodityNotFound(raw: string) {
  return {
    found: false,
    reason: 'commodity_not_found',
    query: raw,
    message: `No commodity in the MCS ${MCS_RELEASE_YEAR} release matches "${raw}". Call mcs_list_commodities to browse the 85 commodities covered.`,
    hint: 'Try the commodity\'s common name, e.g. "lithium", "copper", "rare earths", "platinum group metals".',
    source: SOURCE_LABEL,
  };
}

function ambiguous(raw: string, matches: McsCommodityMeta[]) {
  return {
    found: false,
    reason: 'ambiguous_commodity',
    query: raw,
    message: `"${raw}" matches ${matches.length} commodities in the MCS ${MCS_RELEASE_YEAR} release — pick one.`,
    candidates: matches.slice(0, 15).map((c) => ({ code: c.code, name: c.name })),
    source: SOURCE_LABEL,
  };
}

async function mcsListCommodities(args: Record<string, unknown>) {
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  const limit = Math.min(200, Math.max(1, Number(args.limit) || 100));

  let list = MCS_COMMODITIES;
  if (query) {
    list = list.filter((c) => c.name.toLowerCase().includes(query) || c.code.toLowerCase().includes(query));
  }

  const withWorld = list.filter((c) => c.worldCommodity).length;
  const commodities = list.slice(0, limit).map((c) => ({
    code: c.code,
    name: c.name,
    columns: c.columns,
    has_world_comparison: Boolean(c.worldCommodity),
  }));

  return {
    found: commodities.length > 0,
    release_year: MCS_RELEASE_YEAR,
    total_commodities: MCS_COMMODITIES.length,
    total_with_world_data: MCS_COMMODITIES.filter((c) => c.worldCommodity).length,
    matched: list.length,
    matched_with_world_data: withWorld,
    count: commodities.length,
    commodities,
    hint: 'Call mcs_commodity_data(commodity) for one commodity\'s full U.S. time series, or mcs_country_comparison(commodity) for world production/reserves by country (only where has_world_comparison is true).',
    data_as_of: MCS_INDEX_CAPTURED_AT,
    source: SOURCE_LABEL,
    source_url: MCS_SOURCE_URL,
  };
}

async function mcsCommodityData(args: Record<string, unknown>) {
  const raw = String(args.commodity ?? '').trim();
  if (!raw) {
    return {
      found: false,
      reason: 'empty_commodity',
      message: 'mcs_commodity_data needs a "commodity" — a name or code, e.g. "lithium", "copper", "rare earths".',
    };
  }
  const { exact, matches } = resolveCommodity(raw);
  if (matches.length === 0) return commodityNotFound(raw);
  if (matches.length > 1 && !exact) return ambiguous(raw, matches);

  const meta = matches[0]!;
  const years = MCS_SALIENT.filter((r) => r.code === meta.code).sort((a, b) => a.year - b.year);
  if (years.length === 0) {
    // The index has the commodity's metadata row but no salient rows for it
    // — a baking defect, not a bad query. Surface it loudly rather than as
    // an empty time series that reads like "no data available".
    throw new Error(
      `usgs-mineral-commodities: "${meta.name}" (${meta.code}) is in the commodity index but has zero salient rows — the baked index is internally inconsistent. Re-run scripts/bake-index.mjs.`,
    );
  }

  const latest = years[years.length - 1]!;
  const nirColumn = meta.columns.find((c) => /NIR/i.test(c)) ?? null;

  return {
    found: true,
    code: meta.code,
    name: meta.name,
    release_year: MCS_RELEASE_YEAR,
    columns: meta.columns,
    years: years.map((y) => ({ year: y.year, values: y.values })),
    latest_year: latest.year,
    latest_net_import_reliance: nirColumn ? latest.values[nirColumn] ?? null : null,
    net_import_reliance_column: nirColumn,
    has_world_comparison: Boolean(meta.worldCommodity),
    world_commodity_name: meta.worldCommodity,
    footnote_legend: FOOTNOTE_LEGEND,
    hint: meta.worldCommodity
      ? `Call mcs_country_comparison({ commodity: "${meta.name}" }) for world production and reserves by country.`
      : 'This commodity has no matching row in the MCS world production/reserves table in this release.',
    data_as_of: MCS_INDEX_CAPTURED_AT,
    source: SOURCE_LABEL,
    source_url: MCS_SOURCE_URL,
  };
}

async function mcsCountryComparison(args: Record<string, unknown>) {
  const raw = String(args.commodity ?? '').trim();
  if (!raw) {
    return {
      found: false,
      reason: 'empty_commodity',
      message: 'mcs_country_comparison needs a "commodity" — a name or code, e.g. "lithium", "cobalt", "rare earths".',
    };
  }
  const { exact, matches } = resolveCommodity(raw);
  if (matches.length === 0) return commodityNotFound(raw);
  if (matches.length > 1 && !exact) return ambiguous(raw, matches);

  const meta = matches[0]!;
  if (!meta.worldCommodity) {
    return {
      found: false,
      reason: 'no_world_data',
      code: meta.code,
      name: meta.name,
      message: `"${meta.name}" has no row in the MCS ${MCS_RELEASE_YEAR} world production/reserves table — USGS publishes U.S. salient statistics for it but no by-country world comparison in this release.`,
      hint: `Call mcs_commodity_data({ commodity: "${meta.name}" }) for its U.S. time series instead.`,
      source: SOURCE_LABEL,
    };
  }

  let rows = MCS_WORLD.filter((r) => r.commodity === meta.worldCommodity);
  if (rows.length === 0) {
    throw new Error(
      `usgs-mineral-commodities: "${meta.name}" is marked as having world data (worldCommodity="${meta.worldCommodity}") but zero MCS_WORLD rows matched — the baked index is internally inconsistent. Re-run scripts/bake-index.mjs.`,
    );
  }

  const countriesArg = args.countries;
  let countryFilter: string[] | null = null;
  if (typeof countriesArg === 'string' && countriesArg.trim()) {
    countryFilter = countriesArg.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  } else if (Array.isArray(countriesArg)) {
    countryFilter = countriesArg.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  }
  if (countryFilter && countryFilter.length) {
    const filtered = rows.filter((r) => countryFilter!.some((cf) => r.country.toLowerCase().includes(cf)));
    if (filtered.length === 0) {
      return {
        found: false,
        reason: 'no_matching_countries',
        code: meta.code,
        name: meta.name,
        requested_countries: countriesArg,
        available_countries: rows.map((r) => r.country),
        message: `None of the requested countries matched rows for "${meta.name}". Available countries/rows: ${rows.map((r) => r.country).join(', ')}.`,
        source: SOURCE_LABEL,
      };
    }
    rows = filtered;
  }

  const limit = Math.min(100, Math.max(1, Number(args.limit) || 50));
  const numOrNull = (s: string | null) => (s == null ? -Infinity : Number(s.replace(/[^\d.-]/g, '')) || -Infinity);
  const sorted = [...rows].sort((a, b) => numOrNull(b.reserves_current) - numOrNull(a.reserves_current));

  return {
    found: true,
    code: meta.code,
    name: meta.name,
    world_commodity_name: meta.worldCommodity,
    release_year: MCS_RELEASE_YEAR,
    prod_prior_year: MCS_WORLD_PRIOR_YEAR,
    prod_est_current_year: MCS_WORLD_EST_YEAR,
    reserves_year: MCS_WORLD_RESERVES_YEAR,
    unit: rows[0]!.unit,
    type: rows[0]!.type,
    count: Math.min(limit, sorted.length),
    total_rows: sorted.length,
    countries: sorted.slice(0, limit).map((r) => ({
      country: r.country,
      type: r.type,
      unit: r.unit,
      production_prior_year: r.prod_prior,
      production_est_current_year: r.prod_est_current,
      production_notes: r.prod_notes,
      capacity_prior_year: r.cap_prior,
      capacity_est_current_year: r.cap_est_current,
      capacity_notes: r.cap_notes,
      reserves_current_year: r.reserves_current,
      reserve_notes: r.reserve_notes,
    })),
    footnote_legend: FOOTNOTE_LEGEND,
    hint: '"United States" and "World total (rounded)" / "Other Countries" are included as their own rows where USGS publishes them — exclude by name if you want producing-country-only comparisons.',
    data_as_of: MCS_INDEX_CAPTURED_AT,
    source: SOURCE_LABEL,
    source_url: MCS_SOURCE_URL,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'mcs_list_commodities',
    description:
      'Browse the ~85 nonfuel mineral commodities covered by the USGS Mineral Commodity Summaries (MCS) annual data release — lithium, copper, cobalt, rare earths, gold, aluminum, nickel, platinum-group metals, and dozens more, through industrial minerals like barite and feldspar. Each entry names its U.S. statistics columns (production, imports, exports, price, employment, net import reliance — varies by commodity) and whether a world production/reserves-by-country table is also available (mcs_country_comparison). Optional substring query over commodity name or code. Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Optional substring filter over commodity name or code, e.g. "earth" or "iron".' },
        limit: { type: 'number', description: 'Max commodities to return, default 100, max 200.' },
      },
    },
  },
  {
    name: 'mcs_commodity_data',
    description:
      'U.S. salient statistics for one mineral commodity from the USGS Mineral Commodity Summaries — the most recent 5 years of production, imports, exports, consumption, price, employment, and NET IMPORT RELIANCE (the "import reliance" figure — what share of U.S. consumption comes from imports). Accepts a common name ("lithium", "copper", "rare earths", "platinum group metals") or the MCS code. Raw USGS footnote codes (W=withheld, E=estimated, NA=not available, ">50" on import reliance) are preserved verbatim, never silently coerced to a number. Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        commodity: { type: 'string', description: 'Commodity name or code, e.g. "lithium", "cobalt", "rare earths", "gold".' },
      },
      required: ['commodity'],
    },
  },
  {
    name: 'mcs_country_comparison',
    description:
      'World mine/plant PRODUCTION (prior-year actual + current-year estimate) and RESERVES, by country, for one mineral commodity from the USGS Mineral Commodity Summaries — e.g. "which countries hold lithium reserves" or "China vs. Australia rare-earth production". Covers 75 of the 85 commodities MCS tracks (the other 10 — mostly scrap/slag/crushed-stone categories USGS tracks only domestically — return found:false with a pointer to mcs_commodity_data instead). Optional `countries` filter (comma-separated or array) narrows to named countries; rows are otherwise sorted by current reserves, descending. Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        commodity: { type: 'string', description: 'Commodity name or code, e.g. "lithium", "cobalt", "copper".' },
        countries: {
          description: 'Optional country name filter — a comma-separated string or array, e.g. "China,Australia,Chile".',
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        limit: { type: 'number', description: 'Max countries to return, default 50, max 100.' },
      },
      required: ['commodity'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  switch (name) {
    case 'mcs_list_commodities':
      return mcsListCommodities(args);
    case 'mcs_commodity_data':
      return mcsCommodityData(args);
    case 'mcs_country_comparison':
      return mcsCountryComparison(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool };
export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
