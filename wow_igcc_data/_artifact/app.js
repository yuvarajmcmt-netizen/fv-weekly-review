
const P   = JSON.parse(document.getElementById('payload').textContent);
const M   = P.meta;
const O   = P.overall;
const T1  = P.tier1;
const T2  = P.tier2;
const YOY = JSON.parse(document.getElementById('yoy-payload').textContent);
const RCA    = JSON.parse(document.getElementById('rca-payload').textContent);
const WOWRCA = JSON.parse(document.getElementById('wowrca-payload').textContent);
const ITEMS  = JSON.parse(document.getElementById('items-payload').textContent);
// ── Lazily-loaded external payloads ──────────────────────────────────────────
// These two are fetched from wow_igcc_data/ on first use rather than inlined; a
// ~50 MB index.html exceeded GitHub Pages' 10-minute build timeout. Populated
// before the owning tab's init() runs, so the init code itself is unchanged.
let ITEM_RCA = null;   // Top Items + Nectr
let QNP      = null;   // Item QnP

// 1789976705 busts the browser's HTTP cache on every rebuild -- without it,
// fetch()'s 'force-cache' mode below would keep serving whatever copy of
// item_rca.json/qnp.json the browser first cached, forever, even across
// republishes (GitHub Pages' max-age=600 doesn't help: force-cache never
// revalidates against the server at all, stale or not).
const EXTERNAL_SRC = {
  item_rca: 'wow_igcc_data/item_rca.json?b=1789976705',
  qnp:      'wow_igcc_data/qnp.json?b=1789976705',
};
const _extCache = {};

// ── Rehydrators ──────────────────────────────────────────────────────────────
// The external payloads intern repeated strings (RCA reason/spoc names, item codes)
// as integer indices to keep the deployed site small enough for GitHub Pages to
// publish. These expand them back to the original shapes so every render function
// downstream sees exactly what it saw when the data was inlined as plain JSON.

function rehydrateQnp(j) {
  if (!j || !j.swi_c) return j;                 // already plain
  const codes = j.codes || [];
  const out = {};
  for (const store in j.swi_c) {
    const wks = j.swi_c[store], byWk = {};
    for (const wk in wks) {
      const flat = wks[wk], items = {};
      for (let i = 0; i + 2 < flat.length; i += 3) {
        items[codes[flat[i]]] = [flat[i + 1], flat[i + 2]];
      }
      byWk[wk] = items;
    }
    out[store] = byWk;
  }
  j.store_week_item = out;
  delete j.swi_c;
  delete j.codes;
  return j;
}

function rehydrateItemRca(j) {
  if (!j || !j.reasons_tbl) return j;           // already plain
  const RT = j.reasons_tbl, ST = j.spocs_tbl || [];
  for (const wk in (j.by_week || {})) {
    const wd = j.by_week[wk];
    const blocks = [wd.pan_india || {}];
    for (const city in (wd.cities || {})) blocks.push(wd.cities[city]);
    for (const blk of blocks) {
      for (const code in blk) {
        const sp = blk[code].sp || {}, nsp = {};
        for (const si in sp) {
          const rec = sp[si], nr = {};
          for (const ri in (rec.r || {})) nr[RT[ri]] = rec.r[ri];
          nsp[ST[si] !== undefined ? ST[si] : si] = { i: rec.i, r: nr };
        }
        blk[code].sp = nsp;
      }
    }
  }
  delete j.reasons_tbl;
  delete j.spocs_tbl;
  return j;
}

async function ensureData(key) {
  if (_extCache[key]) return true;
  const url = EXTERNAL_SRC[key];
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const json = await res.json();
  if (key === 'item_rca') ITEM_RCA = rehydrateItemRca(json);
  else                    QNP      = rehydrateQnp(json);
  _extCache[key] = true;
  return true;
}

function showTabLoading(tab, msg) {
  const pane = document.getElementById('tab-' + tab);
  if (!pane) return;
  let el = pane.querySelector('.tab-loading');
  if (!el) {
    el = document.createElement('div');
    el.className = 'tab-loading';
    el.style.cssText = 'padding:18px;color:var(--muted);font-size:13px';
    pane.insertBefore(el, pane.firstChild);
  }
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}
const NECTR    = JSON.parse(document.getElementById('nectr-payload').textContent);
const RCA_SI   = JSON.parse(document.getElementById('rca-si-payload').textContent);

// ── Global Month filter (applies to every tab) ────────────────────────────────
let GLOBAL_MONTH = 'all';                  // 'all' or a month abbrev e.g. 'Apr'
const MONTH_WKS  = YOY.month_wks;          // month -> [wknum,...] (fiscal week numbers)
function monthOfKey(k) { return k.split("'")[0]; }   // "Jul'26|Wk28" -> "Jul"

const MONTH_ORDER_JS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Groups composite week keys ("Jul'26|Wk28") by their "Mon'YY" prefix into
// chronological {label, keys} buckets — one per calendar month actually
// present in `keys`, oldest to newest. Used to build "All Months" weighted
// per-month breakdowns (WoW Trend, Year-on-Year) from raw city_detail sums.
function monthYearBuckets(keys) {
  const segs = {};   // "Apr'26" -> [keys]
  keys.forEach(k => {
    const seg = k.split('|')[0];
    (segs[seg] || (segs[seg] = [])).push(k);
  });
  return Object.keys(segs)
    .sort((a, b) => {
      const ay = +a.split("'")[1], by = +b.split("'")[1];
      if (ay !== by) return ay - by;
      return MONTH_ORDER_JS.indexOf(a.split("'")[0]) - MONTH_ORDER_JS.indexOf(b.split("'")[0]);
    })
    .map(seg => ({ label: seg, keys: segs[seg] }));
}

function monthWeekRange(mon) {
  const wks = (MONTH_WKS[mon] || []).slice().sort((a, b) => a - b);
  if (!wks.length) return null;
  return { from: wks[0], to: wks[wks.length - 1] };
}

// Registry so From/To week-range tabs (WoW RCA, Top Items, Nectr, Item QnP)
// can be driven by the global month without touching their own filter logic.
const WEEK_RANGE_TABS = {};   // key -> { fromSel, toSel, allWeeks, defaultFrom, defaultTo }
function registerWeekRangeTab(key, fromId, toId, allWeeks) {
  const fromSel = document.getElementById(fromId);
  const toSel   = document.getElementById(toId);
  if (!fromSel || !toSel) return;
  WEEK_RANGE_TABS[key] = { fromSel, toSel, allWeeks, defaultFrom: fromSel.value, defaultTo: toSel.value };
}
function applyGlobalMonthToWeekTab(key) {
  const t = WEEK_RANGE_TABS[key];
  if (!t) return;
  let fromV, toV;
  if (GLOBAL_MONTH === 'all') {
    fromV = t.defaultFrom; toV = t.defaultTo;
  } else {
    const rng = monthWeekRange(GLOBAL_MONTH);
    if (!rng) return;
    const avail = t.allWeeks;
    const f   = avail.find(w => w >= rng.from);
    const to_ = avail.slice().reverse().find(w => w <= rng.to);
    fromV = String(f   != null ? f   : avail[0]);
    toV   = String(to_ != null ? to_ : avail[avail.length - 1]);
  }
  t.fromSel.value = fromV;
  t.toSel.value   = toV;
  t.fromSel.dispatchEvent(new Event('change'));
}

// RCA tab: aggregate WOWRCA.by_week's raw counts across a set of weeks into
// the same shape RCA_PAYLOAD uses for a single week (pan_india/T1/T2/cities).
function aggregateRcaWeeks(weekNums) {
  const weeksStr = (weekNums || []).map(String).filter(w => WOWRCA.by_week[w]);
  if (!weeksStr.length) return null;

  function sumSpocs(entries) {
    // entries: array of {orders, spocs} objects to merge
    let orders = 0;
    const spocMap = {};
    entries.forEach(({ orders: o, spocs }) => {
      orders += o;
      Object.entries(spocs || {}).forEach(([spoc, sd]) => {
        const m = spocMap[spoc] || (spocMap[spoc] = { igcc: 0, reasons: {} });
        m.igcc += sd.igcc;
        (sd.reasons || []).forEach(r => { m.reasons[r.reason] = (m.reasons[r.reason] || 0) + r.igcc; });
      });
    });
    const totalIgcc = Object.values(spocMap).reduce((s, sp) => s + sp.igcc, 0);
    const spocs = {};
    Object.keys(spocMap).sort().forEach(spoc => {
      const sp = spocMap[spoc];
      const reasons = Object.entries(sp.reasons)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, igcc]) => ({
          reason, igcc,
          pct:   orders  ? +(igcc / orders  * 100).toFixed(3) : 0,
          share: sp.igcc ? +(igcc / sp.igcc * 100).toFixed(1) : 0,
        }));
      spocs[spoc] = {
        igcc: sp.igcc,
        pct:   orders    ? +(sp.igcc / orders    * 100).toFixed(3) : 0,
        share: totalIgcc ? +(sp.igcc / totalIgcc * 100).toFixed(1) : 0,
        reasons,
      };
    });
    return { orders, total_igcc: totalIgcc, total_pct: orders ? +(totalIgcc / orders * 100).toFixed(3) : 0, spocs };
  }

  function sumLevel(levelKey) {
    return sumSpocs(weeksStr.map(w => WOWRCA.by_week[w][levelKey]).filter(Boolean));
  }

  function sumCities() {
    const byCity = {};   // city -> array of week-level city entries
    weeksStr.forEach(w => {
      Object.entries(WOWRCA.by_week[w].cities || {}).forEach(([city, cd]) => {
        (byCity[city] || (byCity[city] = { tier: cd.tier, entries: [] })).entries.push(cd);
      });
    });
    const cities = {};
    Object.keys(byCity).sort().forEach(city => {
      const agg = sumSpocs(byCity[city].entries);
      cities[city] = { tier: byCity[city].tier, ...agg };
    });
    return cities;
  }

  return {
    week: weeksStr.length === 1 ? +weeksStr[0] : (weeksStr[0] + '–' + weeksStr[weeksStr.length - 1]),
    pan_india: sumLevel('pan_india'),
    T1:        sumLevel('T1'),
    T2:        sumLevel('T2'),
    cities:    sumCities(),
  };
}

let RCA_VIEW  = RCA;    // current view (all-time latest week, or a month aggregate)
let RCA_RENDER = null;  // set by initRCA() to its renderAll()
function computeRcaView() {
  if (GLOBAL_MONTH === 'all') return RCA;
  return aggregateRcaWeeks(MONTH_WKS[GLOBAL_MONTH]) || RCA;
}

// ── Shared week-on-week IGCC% trend helpers (Top Items / Nectr / Item QnP) ────
// Inline SVG, not Chart.js: these tables render hundreds of rows and one Chart
// instance per row makes the tab visibly stall.
const TREND_N = 8;   // how many trailing weeks the sparkline + columns cover

// weeks: ascending week numbers; getter(wk) MUST return [igcc, orders] or null.
// CAREFUL: the payloads disagree on element order. ITEMS/NECTR by_week store
// [igcc, orders], but QNP.store_week_item stores [orders, igcc] (built as
// iw[0]=orders_total_item, iw[1]=orders_igcc_item). Callers must normalise to
// [igcc, orders] here — getting it backwards silently yields orders/igcc, which
// shows up as absurd percentages like 3016.67% rather than an obvious error.
function pctSeries(weeks, getter) {
  return weeks.map(wk => {
    const rec = getter(wk);
    if (!rec) return null;
    const [igcc, orders] = rec;
    return orders ? igcc / orders * 100 : null;
  });
}

function sparkSVG(vals, w, h) {
  w = w || 84; h = h || 24;
  const pts = vals.map((v, i) => [i, v]).filter(p => p[1] != null);
  if (pts.length < 2) return '<span style="color:var(--muted)">—</span>';
  const ys  = pts.map(p => p[1]);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi === lo) { hi = lo + 1; lo = lo - 1; }
  const n   = Math.max(1, vals.length - 1);
  const sx  = i => (i / n) * (w - 2) + 1;
  const sy  = v => h - 1 - ((v - lo) / (hi - lo)) * (h - 2);
  // last vs first of the visible series decides colour: up = worse for IGCC%
  const worse = ys[ys.length - 1] > ys[0];
  const col   = worse ? '#f85149' : '#3fb950';
  const d     = pts.map((p, k) => `${k ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join('');
  const last  = pts[pts.length - 1];
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block">`
       + `<path d="${d}" fill="none" stroke="${col}" stroke-width="1.4"/>`
       + `<circle cx="${sx(last[0]).toFixed(1)}" cy="${sy(last[1]).toFixed(1)}" r="1.8" fill="${col}"/>`
       + `</svg>`;
}

// WoW delta in percentage points between the last two weeks that have data
function wowFromSeries(vals) {
  const idx = [];
  vals.forEach((v, i) => { if (v != null) idx.push(i); });
  if (idx.length < 2) return null;
  const cur = vals[idx[idx.length - 1]], prv = vals[idx[idx.length - 2]];
  return { cur, prv, delta: cur - prv };
}

function wowPPBadge(w) {
  if (!w || w.delta == null || !isFinite(w.delta)) return '<span style="color:var(--muted)">—</span>';
  const d = w.delta;
  if (Math.abs(d) < 0.005) return '<span class="wow-badge flat" style="background:rgba(139,148,158,.12);color:var(--muted)">0.00</span>';
  const up = d > 0;   // IGCC% rising is bad
  const cls = up ? 'up' : 'dn';
  const bg  = up ? 'var(--red-bg)'   : 'var(--green-bg)';
  const fg  = up ? 'var(--red)'      : 'var(--green)';
  return `<span class="wow-badge ${cls}" style="background:${bg};color:${fg}">${up ? '▲' : '▼'}${Math.abs(d).toFixed(2)}</span>`;
}

// Header cells for the trend block; `weeks` is the trailing slice actually shown
function trendHeadHTML(weeks) {
  return weeks.map(w => `<th class="num" style="min-width:58px">Wk${w}</th>`).join('')
       + '<th class="num">Trend</th><th class="num">WoW Δ</th>';
}

// Body cells matching trendHeadHTML for one row's series
function trendCellsHTML(vals) {
  return vals.map(v => `<td class="num">${v == null ? '<span style="color:var(--muted)">—</span>' : v.toFixed(2) + '%'}</td>`).join('')
       + `<td class="num">${sparkSVG(vals)}</td>`
       + `<td class="num">${wowPPBadge(wowFromSeries(vals))}</td>`;
}

// ── "All Months" pivot helpers for Top Items / Nectr / Item QnP ──────────────
// Given an array of week numbers actually available to a tab, return every
// calendar month (from MONTH_WKS) that has at least one of those weeks,
// chronologically ordered — same logic WoW RCA already uses inline.
function monthsForWeeks(availWeeks) {
  const avail = new Set(availWeeks);
  return Object.keys(MONTH_WKS)
    .filter(m => (MONTH_WKS[m] || []).some(w => avail.has(w)))
    .sort((a, b) => Math.max(...MONTH_WKS[a]) - Math.max(...MONTH_WKS[b]));
}

// Month-by-month counterpart to pctSeries(): one weighted % per calendar
// month instead of one % per week, summing raw [igcc, orders] pairs across
// that month's weeks before dividing (same normalisation contract as
// pctSeries — getter(wk) MUST return [igcc, orders] or null).
function monthlyPctSeries(months, getter) {
  return months.map(m => {
    let igcc = 0, orders = 0, any = false;
    (MONTH_WKS[m] || []).forEach(wk => {
      const rec = getter(wk);
      if (rec) { igcc += rec[0]; orders += rec[1]; any = true; }
    });
    return any && orders ? igcc / orders * 100 : (any ? 0 : null);
  });
}

// Header cells for the pivot block; `months` are chronological "Mon" labels
function monthHeadHTML(months) {
  return months.map(m => `<th class="num" style="min-width:58px">${m}</th>`).join('')
       + '<th class="num">Trend</th><th class="num">MoM Δ</th>';
}

// ── Store QnP% slabs and Lines ────────────────────────────────────────────────
// Slabs step 0.20pp from 1.00% up to 2.50%, with open-ended buckets at both ends.
// Membership is (lo, hi] — i.e. pct > lo && pct <= hi — so a store sitting exactly
// on a boundary like 1.20% lands in the 1.01–1.20% slab, not the next one up.
const SLABS = [
  { key: 'a', label: '≤ 1.00%',       lo: -Infinity, hi: 1.00 },
  { key: 'b', label: '1.01 – 1.20%',  lo: 1.00, hi: 1.20 },
  { key: 'c', label: '1.21 – 1.40%',  lo: 1.20, hi: 1.40 },
  { key: 'd', label: '1.41 – 1.60%',  lo: 1.40, hi: 1.60 },
  { key: 'e', label: '1.61 – 1.80%',  lo: 1.60, hi: 1.80 },
  { key: 'f', label: '1.81 – 2.00%',  lo: 1.80, hi: 2.00 },
  { key: 'g', label: '2.01 – 2.20%',  lo: 2.00, hi: 2.20 },
  { key: 'h', label: '2.21 – 2.40%',  lo: 2.20, hi: 2.40 },
  { key: 'i', label: '2.41 – 2.50%',  lo: 2.40, hi: 2.50 },
  { key: 'j', label: '> 2.50%',       lo: 2.50, hi: Infinity },
];

// Lines group the slabs: Green ≤1.40, Orange 1.41–2.00, Red >2.00
const LINES = [
  { key: 'Green',  label: 'Green Line',  range: '≤ 1.40%',      fg: '#3fb950', bg: 'rgba(63,185,80,.15)',  lo: -Infinity, hi: 1.40 },
  { key: 'Orange', label: 'Orange Line', range: '1.41 – 2.00%', fg: '#d29922', bg: 'rgba(210,153,34,.18)', lo: 1.40, hi: 2.00 },
  { key: 'Red',    label: 'Red Line',    range: '> 2.00%',      fg: '#f85149', bg: 'rgba(248,81,73,.15)',  lo: 2.00, hi: Infinity },
];

// Classify on the value as DISPLAYED (2 dp), not the raw float. A store at 2.5041%
// renders as "2.50%" but raw-compares as > 2.50, which would show "2.50%" sitting in
// the "> 2.50%" slab — the row contradicting itself. Rounding first keeps the number
// on screen and the slab it is placed in consistent.
function round2(v) {
  return (v == null || !isFinite(v)) ? null : Math.round(v * 100) / 100;
}

function slabOf(pct) {
  if (pct == null || !isFinite(pct)) return null;
  return SLABS.find(s => pct > s.lo && pct <= s.hi) || null;
}
function lineOf(pct) {
  if (pct == null || !isFinite(pct)) return null;
  return LINES.find(l => pct > l.lo && pct <= l.hi) || null;
}
function linePill(pct, withRange) {
  const L = lineOf(pct);
  if (!L) return '<span style="color:var(--muted)">—</span>';
  return `<span class="tier-pill" style="background:${L.bg};color:${L.fg}">${L.label}`
       + (withRange ? ` <span style="opacity:.75">${L.range}</span>` : '') + `</span>`;
}

// ── Store x Item RCA bucket helpers (rca_daily_igcc_5 via rca_store_item.csv) ──
const SPOC_BG = {
  'Pod':      'rgba(88,166,255,.15)',
  'WH':       'rgba(247,129,102,.15)',
  'Sourcing': 'rgba(210,153,34,.15)',
  'CX':       'rgba(63,185,80,.15)',
  'Unmapped': 'rgba(139,148,158,.12)',
};
const SPOC_FG = {
  'Pod':'#58a6ff', 'WH':'#f78166', 'Sourcing':'#d29922', 'CX':'#3fb950', 'Unmapped':'#8b949e',
};

// bucket counts for one store+item over a set of weeks (payload lists are
// zero-trimmed, so missing tail entries default to 0)
function rcaBuckets(store, weeks, code) {
  const n   = (RCA_SI.buckets || []).length;
  const out = new Array(n).fill(0);
  const byStore = (RCA_SI.by_store || {})[store];
  if (!byStore) return out;
  weeks.forEach(wk => {
    const wkd = byStore[String(wk)];
    if (!wkd) return;
    const v = wkd[code];
    if (!v) return;
    for (let i = 0; i < v.length && i < n; i++) out[i] += v[i] || 0;
  });
  return out;
}

// Reason-level totals for a scope: one store, or all stores in `storeList`.
// Returns [{reason, spoc, igcc, share}] sorted by igcc desc.
function rcaReasonRows(storeList, weeks) {
  const RS = RCA_SI.reason_store || {};
  const RT = RCA_SI.reasons || [];
  const SP = RCA_SI.reason_spoc || [];
  const acc = new Array(RT.length).fill(0);
  storeList.forEach(store => {
    const byWk = RS[store];
    if (!byWk) return;
    weeks.forEach(wk => {
      const flat = byWk[String(wk)];
      if (!flat) return;
      for (let i = 0; i + 1 < flat.length; i += 2) acc[flat[i]] += flat[i + 1];
    });
  });
  const total = acc.reduce((a, b) => a + b, 0);
  return {
    total,
    rows: RT.map((rn, i) => ({
            reason: rn, spoc: SP[i] || 'Unmapped', igcc: acc[i],
            share: total ? acc[i] / total * 100 : 0,
          }))
          .filter(r => r.igcc > 0)
          .sort((a, b) => b.igcc - a.igcc),
  };
}

// Reason rows for ONE store x item across weeks — same shape as rcaReasonRows.
// Item codes are interned, so resolve the code to its index once and scan the
// store's flat [itemIdx, reasonIdx, igcc] triples for matches.
let _rcaItemIdx = null;
function rcaItemReasonRows(store, code, weeks) {
  const RT = RCA_SI.reasons || [], SP = RCA_SI.reason_spoc || [];
  const IT = RCA_SI.item_tbl || [];
  if (!_rcaItemIdx) {
    _rcaItemIdx = {};
    IT.forEach((c, i) => { _rcaItemIdx[c] = i; });
  }
  const want = _rcaItemIdx[code];
  const acc = new Array(RT.length).fill(0);
  if (want === undefined) return { total: 0, rows: [] };
  const byWk = (RCA_SI.reason_item || {})[store];
  if (byWk) {
    weeks.forEach(wk => {
      const flat = byWk[String(wk)];
      if (!flat) return;
      for (let i = 0; i + 2 < flat.length; i += 3) {
        if (flat[i] === want) acc[flat[i + 1]] += flat[i + 2];
      }
    });
  }
  const total = acc.reduce((a, b) => a + b, 0);
  return {
    total,
    rows: RT.map((rn, i) => ({ reason: rn, spoc: SP[i] || 'Unmapped', igcc: acc[i],
                               share: total ? acc[i] / total * 100 : 0 }))
            .filter(r => r.igcc > 0)
            .sort((a, b) => b.igcc - a.igcc),
  };
}

// every RCA complaint for a store over a set of weeks, across all item codes
function rcaStoreTotal(store, weeks) {
  const byStore = (RCA_SI.by_store || {})[store];
  if (!byStore) return 0;
  let t = 0;
  weeks.forEach(wk => {
    const wkd = byStore[String(wk)];
    if (!wkd) return;
    for (const code in wkd) {
      const v = wkd[code];
      for (let i = 0; i < v.length; i++) t += v[i] || 0;
    }
  });
  return t;
}

// ── helpers ──────────────────────────────────────────────────────────────────
const fmt  = v => v == null ? '—' : v.toFixed(2) + '%';
const fmtN = v => v == null ? '—' : v.toLocaleString();
const bp   = v => v == null ? null : Math.round(v * 100);   // pct -> basis-points (already in pct units so *100)

function wowBadge(wow) {
  if (wow == null) return '<span style="color:var(--muted)">—</span>';
  const sign = wow > 0 ? '+' : '';
  const cls  = wow > 0.05 ? 'up' : wow < -0.05 ? 'dn' : 'flat';
  const arrow= wow > 0.05 ? '▲' : wow < -0.05 ? '▼' : '●';
  return `<span class="wow-badge ${cls}">${arrow} ${sign}${wow.toFixed(2)}%</span>`;
}

// ── KPI row helpers ────────────────────────────────────────────────────────────
function kpiHTML(label, value, sub, badge) {
  return `<div class="kpi">
    <div class="label">${label}</div>
    <div class="value">${value}${badge ? ' ' + badge : ''}</div>
    ${sub ? `<div class="sub2">${sub}</div>` : ''}
  </div>`;
}

function wowSub(cur, prv, wk) {
  if (cur == null || prv == null) return '';
  const d   = cur - prv;
  const sign= d > 0 ? '+' : '';
  const cls = d > 0.05 ? 'up' : d < -0.05 ? 'dn' : 'flat';
  const arr = d > 0.05 ? '▲' : d < -0.05 ? '▼' : '●';
  return `<span class="badge ${cls}">${arr} ${sign}${d.toFixed(2)}%</span> vs ${wk}`;
}

function deltaCell(cur, prv, sep) {
  const sepCls = sep ? ' grp-sep' : '';
  if (cur == null) return `<td class="${sepCls}">—</td><td>—</td>`;
  const valCell = `<td class="val${sepCls}">${cur.toFixed(2)}%</td>`;
  if (prv == null) return valCell + `<td>—</td>`;
  const d = cur - prv;
  const sign = d > 0 ? '+' : '';
  const cls  = d > 0.05 ? 'up' : d < -0.05 ? 'dn' : 'flat';
  const arrow= d > 0.05 ? '▲' : d < -0.05 ? '▼' : '●';
  return valCell + `<td><span class="delta ${cls}">${arrow} ${sign}${d.toFixed(2)}%</span></td>`;
}

// Full-history keyed lookups (built once — used by the summary table regardless
// of which weeks are currently on screen, so the first row of a month can still
// show a delta against the last week of the previous month).
const OV_MAP = {}; O.trend_full.forEach(d => OV_MAP[d.k] = d.v);
const T1_MAP = {}; T1.trend_full.forEach(d => T1_MAP[d.k] = d.v);
const T2_MAP = {}; T2.trend_full.forEach(d => T2_MAP[d.k] = d.v);

// ── Month-aware view builder ───────────────────────────────────────────────────
// 'all' reproduces today's behaviour exactly (pre-baked last-12-week windows).
// A specific month aggregates raw orders/counts across that month's weeks
// (most recent occurrence) and recomputes IGCC% — no Python payload change
// needed since city_detail already holds full per-week raw counts.
// Raw cross-city sum over an arbitrary set of composite week keys — the same
// weighting sumRaw()/cityRow() use per-month below, hoisted so the "all
// months" branch can call it once per calendar-month bucket.
function sumRawKeys(keys, tierFilter) {
  let orders = 0, counts = 0, any = false;
  P.cities.forEach(c => {
    if (tierFilter && c.tier !== tierFilter) return;
    const cd = P.city_detail[c.city];
    keys.forEach(k => {
      const o = cd.orders[k];
      if (o != null) { orders += o; counts += (cd.counts[k] || 0); any = true; }
    });
  });
  return { orders, counts, pct: any && orders ? +(counts / orders * 100).toFixed(2) : null };
}

function cityAggKeys(cd, keys) {
  let orders = 0, counts = 0, any = false;
  keys.forEach(k => { const o = cd.orders[k]; if (o != null) { orders += o; counts += (cd.counts[k] || 0); any = true; } });
  return { pct: any && orders ? +(counts / orders * 100).toFixed(2) : null, orders, counts };
}

// "All Months": one weighted-average point/row per calendar month across the
// full history (not the last-12-weeks trend, not a single lumped total).
function computeWowMonthlyView() {
  const buckets = monthYearBuckets(O.trend_full.map(d => d.k));
  const monthly = buckets.map(b => ({
    label: b.label, keys: b.keys,
    overall: sumRawKeys(b.keys, null),
    tier1:   sumRawKeys(b.keys, 'T1'),
    tier2:   sumRawKeys(b.keys, 'T2'),
  }));
  const cur = monthly.length ? monthly[monthly.length - 1] : null;
  const prv = monthly.length > 1 ? monthly[monthly.length - 2] : null;

  function cityMonthlyRow(c) {
    const cd = P.city_detail[c.city];
    const vals = monthly.map(m => cityAggKeys(cd, m.keys).pct);
    const rowCur = vals.length ? vals[vals.length - 1] : null;
    const rowPrv = vals.length > 1 ? vals[vals.length - 2] : null;
    const rowWow = (rowCur != null && rowPrv != null) ? +(rowCur - rowPrv).toFixed(2) : null;
    const l4 = vals.slice(-4); while (l4.length < 4) l4.unshift(null);
    const spark = vals.slice(-12);
    const lastAgg = cur ? cityAggKeys(cd, cur.keys) : { orders: 0, counts: 0 };
    return { city: c.city, tier: c.tier, cur: rowCur, prv: rowPrv, wow: rowWow, l4, spark, orders: lastAgg.orders, counts: lastAgg.counts };
  }

  return {
    isMonth: false, isAllMonthly: true,
    curLbl: cur ? cur.label : (M.cur_wk || 'latest'), prvLbl: prv ? prv.label : 'prev', deltaWord: 'MoM Δ',
    overall: {
      cur: cur ? cur.overall.pct : null, prv: prv ? prv.overall.pct : null,
      wow_bp: (cur && prv && cur.overall.pct != null && prv.overall.pct != null) ? +((cur.overall.pct - prv.overall.pct) * 100).toFixed(1) : null,
      orders: cur ? cur.overall.orders : null, counts: cur ? cur.overall.counts : null,
    },
    tier1: { cur: cur ? cur.tier1.pct : null, prv: prv ? prv.tier1.pct : null },
    tier2: { cur: cur ? cur.tier2.pct : null, prv: prv ? prv.tier2.pct : null },
    chartSeries: {
      overall: monthly.map(m => ({ k: m.label, lbl: m.label, v: m.overall.pct })),
      tier1:   monthly.map(m => ({ k: m.label, lbl: m.label, v: m.tier1.pct })),
      tier2:   monthly.map(m => ({ k: m.label, lbl: m.label, v: m.tier2.pct })),
    },
    sumWeeks: monthly.map(m => ({ k: m.label, lbl: m.label, v: m.overall.pct })),
    last4Lbl: monthly.slice(-4).map(m => m.label),
    cities: P.cities.map(cityMonthlyRow),
  };
}

function computeWowView(month) {
  if (month === 'all') return computeWowMonthlyView();

  const allK = O.trend_full.map(d => d.k);
  const segs = {};   // "Apr'26" -> [keys in chronological order]
  allK.forEach(k => {
    const seg = k.split('|')[0];
    if (seg.split("'")[0] === month) (segs[seg] || (segs[seg] = [])).push(k);
  });
  const segNames = Object.keys(segs).sort((a, b) => +a.split("'")[1] - +b.split("'")[1]);
  if (!segNames.length) return null;
  const curSeg  = segNames[segNames.length - 1];
  const curKeys = segs[curSeg];
  const firstIdx = allK.indexOf(curKeys[0]);
  let prvKeys = [], prvSeg = null;
  if (firstIdx > 0) {
    prvSeg  = allK[firstIdx - 1].split('|')[0];
    prvKeys = allK.filter(k => k.split('|')[0] === prvSeg);
  }

  function sumRaw(keys, tierFilter) {
    let orders = 0, counts = 0, any = false;
    P.cities.forEach(c => {
      if (tierFilter && c.tier !== tierFilter) return;
      const cd = P.city_detail[c.city];
      keys.forEach(k => {
        const o = cd.orders[k];
        if (o != null) { orders += o; counts += (cd.counts[k] || 0); any = true; }
      });
    });
    return { orders, counts, pct: any && orders ? +(counts / orders * 100).toFixed(2) : null };
  }

  const ovCur = sumRaw(curKeys, null);
  const ovPrv = prvKeys.length ? sumRaw(prvKeys, null) : { pct: null };
  const t1Cur = sumRaw(curKeys, 'T1');
  const t1Prv = prvKeys.length ? sumRaw(prvKeys, 'T1') : { pct: null };
  const t2Cur = sumRaw(curKeys, 'T2');
  const t2Prv = prvKeys.length ? sumRaw(prvKeys, 'T2') : { pct: null };
  const wowBpVal = (ovCur.pct != null && ovPrv.pct != null) ? +((ovCur.pct - ovPrv.pct) * 100).toFixed(1) : null;

  function cityRow(c) {
    const cd = P.city_detail[c.city];
    function agg(keys) {
      let orders = 0, counts = 0, any = false;
      keys.forEach(k => { const o = cd.orders[k]; if (o != null) { orders += o; counts += (cd.counts[k] || 0); any = true; } });
      return any && orders ? +(counts / orders * 100).toFixed(2) : null;
    }
    const cur = agg(curKeys);
    const prv = prvKeys.length ? agg(prvKeys) : null;
    const wow = (cur != null && prv != null) ? +(cur - prv).toFixed(2) : null;
    const weeklyVals = curKeys.map(k => cd.igcc[k] ?? null);
    const l4 = weeklyVals.slice(-4); while (l4.length < 4) l4.unshift(null);
    const spark = weeklyVals.slice(-12);
    let ordersSum = 0, countsSum = 0;
    curKeys.forEach(k => { const o = cd.orders[k]; if (o != null) { ordersSum += o; countsSum += (cd.counts[k] || 0); } });
    return { city: c.city, tier: c.tier, cur, prv, wow, l4, spark, orders: ordersSum, counts: countsSum };
  }

  return {
    isMonth: true,
    curLbl: curSeg, prvLbl: prvSeg || 'prev', deltaWord: 'MoM Δ',
    overall: { cur: ovCur.pct, prv: ovPrv.pct, wow_bp: wowBpVal, orders: ovCur.orders, counts: ovCur.counts },
    tier1:   { cur: t1Cur.pct, prv: t1Prv.pct },
    tier2:   { cur: t2Cur.pct, prv: t2Prv.pct },
    chartSeries: {
      overall: O.trend_full.filter(d => curKeys.includes(d.k)),
      tier1:   T1.trend_full.filter(d => curKeys.includes(d.k)),
      tier2:   T2.trend_full.filter(d => curKeys.includes(d.k)),
    },
    sumWeeks: O.trend_full.filter(d => curKeys.includes(d.k)),
    last4Lbl: curKeys.slice(-4).map(k => P.key_label[k] || k),
    cities: P.cities.map(cityRow),
  };
}

// ── Sparkline factory ────────────────────────────────────────────────────────
function drawSpark(canvas, vals, isWorse) {
  const valid = vals.filter(v => v != null);
  if (valid.length < 2) return;
  const col = isWorse ? '#f85149' : '#3fb950';
  new Chart(canvas, {
    type: 'line',
    data: {
      labels: vals.map((_,i)=>i),
      datasets: [{
        data: vals,
        borderColor: col,
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
        tension: 0.3,
        spanGaps: true,
      }]
    },
    options: {
      responsive: false,
      plugins: { legend:{display:false}, tooltip:{enabled:false} },
      scales: { x:{display:false}, y:{display:false} },
      animation: false,
    }
  });
}

// ── City table ───────────────────────────────────────────────────────────────
const thead = document.getElementById('city-thead');
const tbody = document.getElementById('city-tbody');

let sortCol = 'cur', sortDir = 'desc';
let filtered = [...P.cities];
let cityRowsSource = P.cities;
let wowView = null;
let overallChart = null;

function renderTable(rows) {
  tbody.innerHTML = '';
  rows.forEach(c => {
    const isWorse = c.wow != null && c.wow > 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="city-name">${c.city}</td>
      <td><span class="tier-pill ${c.tier}">${c.tier}</span></td>
      <td class="num">${fmt(c.cur)}</td>
      <td class="num">${fmt(c.prv)}</td>
      <td class="wow-cell">${wowBadge(c.wow)}</td>
      ${c.l4.map(v=>`<td class="num">${fmt(v)}</td>`).join('')}
      <td class="num"><canvas class="spark" width="90" height="30"></canvas></td>
      <td class="num">${fmtN(c.orders)}</td>
      <td class="num">${fmtN(c.counts)}</td>`;
    const spark = tr.querySelector('.spark');
    drawSpark(spark, c.spark, isWorse);
    tr.addEventListener('click', () => openModal(c.city));
    tbody.appendChild(tr);
  });
  document.getElementById('row-count').textContent = `${rows.length} cities`;
}

function applySort(arr) {
  return [...arr].sort((a, b) => {
    let va = a[sortCol], vb = b[sortCol];
    if (sortCol === 'city') {
      va = va || ''; vb = vb || '';
      return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    va = va ?? (sortDir === 'asc' ? Infinity : -Infinity);
    vb = vb ?? (sortDir === 'asc' ? Infinity : -Infinity);
    return sortDir === 'asc' ? va - vb : vb - va;
  });
}

function applyFilters() {
  const q    = document.getElementById('search').value.toLowerCase();
  const tier = document.getElementById('filter-tier').value;
  const wow  = document.getElementById('filter-wow').value;
  filtered = cityRowsSource.filter(c => {
    if (q && !c.city.toLowerCase().includes(q)) return false;
    if (tier !== 'all' && c.tier !== tier) return false;
    if (wow === 'up' && !(c.wow != null && c.wow > 0)) return false;
    if (wow === 'dn' && !(c.wow != null && c.wow < 0)) return false;
    return true;
  });
  renderTable(applySort(filtered));
}

function renderCityTableHeaders(view) {
  thead.innerHTML = `<tr>
    <th data-col="city">City</th>
    <th data-col="tier">Tier</th>
    <th data-col="cur" class="num">IGCC% (${view.curLbl})</th>
    <th data-col="prv" class="num">IGCC% (${view.prvLbl})</th>
    <th data-col="wow" class="num">${view.deltaWord}</th>
    ${view.last4Lbl.map(w=>`<th class="num" style="min-width:70px">${w}</th>`).join('')}
    <th class="num">Trend (${view.isMonth ? 'in-month' : '12wk'})</th>
    <th data-col="orders" class="num">Orders</th>
    <th data-col="counts" class="num">Complaints</th>
  </tr>`;
  thead.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortCol = col; sortDir = col === 'city' ? 'asc' : 'desc'; }
      document.getElementById('sort-col').value = sortCol;
      document.getElementById('sort-dir').value = sortDir;
      thead.querySelectorAll('th').forEach(t => t.classList.remove('sorted'));
      th.classList.add('sorted');
      renderTable(applySort(filtered));
    });
  });
}

document.getElementById('search').addEventListener('input', applyFilters);
document.getElementById('filter-tier').addEventListener('change', applyFilters);
document.getElementById('filter-wow').addEventListener('change', applyFilters);
document.getElementById('sort-col').addEventListener('change', e => {
  sortCol = e.target.value; applyFilters();
});
document.getElementById('sort-dir').addEventListener('change', e => {
  sortDir = e.target.value; applyFilters();
});

// CSV download
document.getElementById('dl-csv').addEventListener('click', () => {
  const rows = applySort(filtered);
  const hdrs = ['City','Tier','IGCC_cur','IGCC_prv','WoW_pct',...wowView.last4Lbl,'Orders','Complaints'];
  const lines = [hdrs.join(','), ...rows.map(c =>
    [c.city, c.tier, c.cur??'', c.prv??'', c.wow??'', ...c.l4.map(v=>v??''), c.orders??'', c.counts??''].join(',')
  )];
  const blob = new Blob([lines.join('\n')], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `wow_igcc_${wowView.curLbl.replace(/[^A-Za-z0-9]/g,'_')}.csv`;
  a.click();
});

// ── Render — called at load, and again whenever the global Month changes ─────
function renderWowTab() {
  const view = computeWowView(GLOBAL_MONTH) || computeWowView('all');
  wowView = view;

  document.getElementById('hdr-sub').textContent = view.isMonth
    ? `${view.curLbl} · ${P.cities.length} cities`
    : `${M.cur_wk} · ${M.cur_month} · ${P.cities.length} cities`;

  const wowBp  = view.overall.wow_bp;
  const wowBpS = wowBp == null ? '' : (wowBp > 0 ? `+${wowBp}` : `${wowBp}`) + ' bp';
  const ordersWkLbl = view.isMonth ? view.curLbl : `Week ${M.cur_wk}`;
  document.getElementById('kpi-row').innerHTML =
    kpiHTML('Pan India IGCC%', fmt(view.overall.cur),
      `vs ${fmt(view.overall.prv)} (${view.prvLbl})`,
      wowBp == null ? '' :
        `<span class="badge ${wowBp > 2 ? 'up' : wowBp < -2 ? 'dn' : 'flat'}">${wowBpS}</span>`) +
    kpiHTML('Tier 1 IGCC%', fmt(view.tier1.cur), `Blr·Che·Mum·Hyd·Pun·Kol·NCR`, wowSub(view.tier1.cur, view.tier1.prv, view.prvLbl)) +
    kpiHTML('Tier 2 IGCC%', fmt(view.tier2.cur), `Rest of cities`, wowSub(view.tier2.cur, view.tier2.prv, view.prvLbl)) +
    kpiHTML('FnV Orders', fmtN(view.overall.orders), ordersWkLbl, '') +
    kpiHTML('FnV Complaints', fmtN(view.overall.counts), ordersWkLbl, '') +
    kpiHTML('Cities Improved', view.cities.filter(c=>c.wow!=null&&c.wow<0).length, `↓ ${view.deltaWord} vs prev`, '') +
    kpiHTML('Cities Worsened', view.cities.filter(c=>c.wow!=null&&c.wow>0).length, `↑ ${view.deltaWord} vs prev`, '');

  const T12data = view.chartSeries.overall;
  if (overallChart) { overallChart.destroy(); overallChart = null; }
  overallChart = new Chart(document.getElementById('overall-chart'), {
    type: 'line',
    data: {
      labels: T12data.map(d => d.lbl),
      datasets: [
        { label: 'Pan India', data: T12data.map(d => d.v), borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,.07)', borderWidth: 2.5, pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: '#58a6ff', fill: true, tension: 0.35 },
        { label: 'Tier 1', data: view.chartSeries.tier1.map(d => d.v), borderColor: '#f78166', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: '#f78166', fill: false, tension: 0.35 },
        { label: 'Tier 2', data: view.chartSeries.tier2.map(d => d.v), borderColor: '#3fb950', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: '#3fb950', fill: false, tension: 0.35 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels:{ color:'#8b949e', font:{size:11}, boxWidth:12 } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)}%` } }
      },
      scales: {
        x: { grid:{ color:'rgba(48,54,61,.6)' }, ticks:{ color:'#8b949e', font:{size:11} } },
        y: { grid:{ color:'rgba(48,54,61,.6)' }, ticks:{ color:'#8b949e', font:{size:11}, callback: v => v.toFixed(1)+'%' }, min: 0 }
      }
    }
  });

  // WoW/MoM summary table
  const sumTbody = document.getElementById('sum-tbody');
  sumTbody.innerHTML = '';
  const rows = [...view.sumWeeks].reverse();   // newest first
  rows.forEach((d, i) => {
    const isCur = i === 0;
    const k  = d.k;
    const ov = OV_MAP[k], t1 = T1_MAP[k], t2 = T2_MAP[k];
    const prevD = rows[i + 1];
    const pk    = prevD ? prevD.k : null;
    const ovP = pk ? OV_MAP[pk] : null, t1P = pk ? T1_MAP[pk] : null, t2P = pk ? T2_MAP[pk] : null;
    const tr = document.createElement('tr');
    if (isCur) tr.classList.add('cur-row');
    tr.innerHTML =
      `<td>${d.lbl}${isCur ? ' <span style="font-size:10px;color:var(--accent)">(latest)</span>' : ''}</td>` +
      deltaCell(ov, ovP, false) + deltaCell(t1, t1P, true) + deltaCell(t2, t2P, true);
    sumTbody.appendChild(tr);
  });

  renderCityTableHeaders(view);
  cityRowsSource = view.cities;
  applyFilters();
}

renderWowTab();

// ── Modal ────────────────────────────────────────────────────────────────────
let modalChart = null;
const overlay   = document.getElementById('overlay');
const keyLabel  = P.key_label;   // composite-key -> short wk label
const allKeys   = O.trend_full.map(d => d.k);

function openModal(city) {
  const det    = P.city_detail[city];
  const summ   = P.cities.find(c => c.city === city);
  if (!det) return;

  document.getElementById('modal-title').textContent = city;
  document.getElementById('modal-meta').textContent  =
    `Latest: ${M.cur_wk} · ${M.cur_month}`;

  // KPI
  document.getElementById('modal-kpi').innerHTML = `
    <div class="k"><div class="lbl">IGCC% (${M.cur_wk})</div>
      <div class="val">${fmt(summ?.cur)}</div></div>
    <div class="k"><div class="lbl">WoW Δ</div>
      <div class="val">${summ?.wow != null ? (summ.wow>0?'+':'')+summ.wow.toFixed(2)+'%' : '—'}</div></div>
    <div class="k"><div class="lbl">Orders / Complaints</div>
      <div class="val">${fmtN(summ?.orders)} / ${fmtN(summ?.counts)}</div></div>`;

  renderModalChart(city, 12);

  // period buttons
  document.querySelectorAll('#period-btns button').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('#period-btns button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      renderModalChart(city, +btn.dataset.p);
    };
  });
  document.querySelectorAll('#period-btns button').forEach(b => b.classList.toggle('active', b.dataset.p==='12'));

  overlay.classList.add('open');
}

function renderModalChart(city, n) {
  const det  = P.city_detail[city];
  let keys   = allKeys.filter(k => k in det.igcc);
  if (n > 0) keys = keys.slice(-n);
  const labels = keys.map(k => keyLabel[k] || k);
  const vals   = keys.map(k => det.igcc[k]);
  const ovrl   = keys.map(k => {
    const ov = O.trend_full.find(d => d.k === k);
    return ov ? ov.v : null;
  });

  if (modalChart) { modalChart.destroy(); modalChart = null; }
  modalChart = new Chart(document.getElementById('modal-chart'), {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: city,
          data: vals,
          borderColor: '#58a6ff',
          backgroundColor: 'rgba(88,166,255,.1)',
          borderWidth: 2.5,
          pointRadius: 3,
          fill: true,
          tension: 0.3,
          spanGaps: true,
        },
        {
          label: 'Overall',
          data: ovrl,
          borderColor: '#d29922',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          borderDash: [4,3],
          pointRadius: 0,
          fill: false,
          tension: 0.3,
          spanGaps: true,
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels:{ color:'#8b949e', font:{size:11} } },
        tooltip: { callbacks:{ label: ctx => ` ${ctx.parsed.y?.toFixed(2)}%` } }
      },
      scales: {
        x: { grid:{color:'rgba(48,54,61,.6)'}, ticks:{color:'#8b949e',font:{size:10},maxTicksLimit:14} },
        y: {
          grid:{color:'rgba(48,54,61,.6)'},
          ticks:{color:'#8b949e',font:{size:11},callback:v=>v.toFixed(1)+'%'},
          min: 0,
        }
      }
    }
  });
}

document.getElementById('modal-close').addEventListener('click', () => overlay.classList.remove('open'));
overlay.addEventListener('click', e => { if(e.target===overlay) overlay.classList.remove('open'); });
document.addEventListener('keydown', e => { if(e.key==='Escape') overlay.classList.remove('open'); });

// ── Tab switching ─────────────────────────────────────────────────────────────
let yoyInited = false, rcaInited = false, wowrcaInited = false, itemsInited = false, nectrInited = false, qnpInited = false;
// Which tabs need an external payload fetched before their init() can run
const TAB_NEEDS = { items: 'item_rca', nectr: 'item_rca', qnp: 'qnp' };

// ── Global Month selector — wired to every already-inited tab ─────────────────
const globalMonthSel = document.getElementById('global-month-sel');
Object.keys(MONTH_WKS).forEach(mon => {
  const o = document.createElement('option');
  o.value = mon; o.textContent = mon;
  globalMonthSel.appendChild(o);
});
globalMonthSel.addEventListener('change', () => {
  GLOBAL_MONTH = globalMonthSel.value;

  renderWowTab();   // WoW Trend tab is always active/inited from page load

  if (yoyInited) {
    const monSel = document.getElementById('yoy-mon');
    monSel.value = GLOBAL_MONTH;
    monSel.dispatchEvent(new Event('change'));
  }
  if (rcaInited && RCA_RENDER) RCA_RENDER();

  ['wowrca', 'items', 'nectr', 'qnp'].forEach(key => applyGlobalMonthToWeekTab(key));
});

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (!btn.dataset.tab) return;
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + tab).classList.add('active');

    if (tab === 'yoy'    && !yoyInited)    { initYoY();    yoyInited    = true; }
    if (tab === 'rca'    && !rcaInited)    { initRCA();    rcaInited    = true; }
    if (tab === 'wowrca' && !wowrcaInited) { initWowRCA(); wowrcaInited = true; }

    const need    = TAB_NEEDS[tab];
    const pending = (tab === 'items' && !itemsInited)
                 || (tab === 'nectr' && !nectrInited)
                 || (tab === 'qnp'   && !qnpInited);
    if (need && pending) {
      showTabLoading(tab, 'Loading data…');
      try {
        await ensureData(need);
      } catch (err) {
        showTabLoading(tab, 'Could not load ' + EXTERNAL_SRC[need] + ' — ' + err.message
          + '. This tab needs the wow_igcc_data/ folder served alongside the page.');
        return;
      }
      showTabLoading(tab, '');
    }

    if (tab === 'items' && !itemsInited) { initItems(); itemsInited = true; }
    if (tab === 'nectr' && !nectrInited) { initNectr(); nectrInited = true; }
    if (tab === 'qnp'   && !qnpInited)   { initQnp();   qnpInited   = true; }
  });
});

// ── YoY Tab ───────────────────────────────────────────────────────────────────
function initYoY() {
  const Y = YOY;
  const YEARS = Y.years;
  const YEAR_COLORS = { 2023:'#8b949e', 2024:'#d29922', 2025:'#f78166', 2026:'#58a6ff' };

  // ── Week dropdown ─────────────────────────────────────────────────────────
  const wkSel = document.getElementById('yoy-wk');
  const allWknums = Object.keys(Y.wk_month).map(Number).sort((a,b)=>a-b);
  allWknums.forEach(wk => {
    const o = document.createElement('option');
    o.value = wk; o.textContent = 'Wk' + wk + ' (' + Y.wk_month[wk] + ')';
    wkSel.appendChild(o);
  });

  // ── Month dropdown ────────────────────────────────────────────────────────
  const monSel = document.getElementById('yoy-mon');
  Object.keys(Y.month_wks).forEach(mon => {
    const o = document.createElement('option'); o.value = mon; o.textContent = mon;
    monSel.appendChild(o);
  });

  // ── Year toggle buttons (All + individual years) ──────────────────────────
  const yrBtnContainer = document.getElementById('yoy-yr-btns');
  let activeYears = new Set(YEARS);   // all selected by default

  function yrBtnStyle(btn, active, yr) {
    const col = yr ? (YEAR_COLORS[yr] || '#ccc') : 'var(--accent)';
    if (active) {
      btn.style.background  = col === 'var(--accent)' ? 'rgba(88,166,255,.2)' : `rgba(${hexToRgb(col)},0.2)`;
      btn.style.borderColor = col;
      btn.style.color       = col;
      btn.style.fontWeight  = '600';
    } else {
      btn.style.background  = 'var(--surface2)';
      btn.style.borderColor = 'var(--border)';
      btn.style.color       = 'var(--muted)';
      btn.style.fontWeight  = '';
    }
  }

  function hexToRgb(hex) {
    const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return r ? `${parseInt(r[1],16)},${parseInt(r[2],16)},${parseInt(r[3],16)}` : '255,255,255';
  }

  function mkBtn(label, yr) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = 'border-radius:5px;padding:5px 12px;font-size:12px;cursor:pointer;border:1px solid;transition:all .15s';
    yrBtnStyle(btn, yr ? activeYears.has(yr) : activeYears.size === YEARS.length, yr);
    return btn;
  }

  // "All" button
  const allBtn = mkBtn('All', null);
  allBtn.addEventListener('click', () => {
    activeYears = new Set(YEARS);
    yrBtnContainer.querySelectorAll('[data-yr]').forEach(b => yrBtnStyle(b, true, +b.dataset.yr));
    yrBtnStyle(allBtn, true, null);
    renderAll();
  });
  yrBtnContainer.appendChild(allBtn);

  // Individual year buttons
  YEARS.forEach(yr => {
    const btn = mkBtn(String(yr), yr);
    btn.dataset.yr = yr;
    btn.addEventListener('click', () => {
      if (activeYears.has(yr) && activeYears.size === 1) return; // keep at least one
      if (activeYears.has(yr)) activeYears.delete(yr); else activeYears.add(yr);
      yrBtnStyle(btn, activeYears.has(yr), yr);
      yrBtnStyle(allBtn, activeYears.size === YEARS.length, null);
      renderAll();
    });
    yrBtnContainer.appendChild(btn);
  });

  // ── Filter state ──────────────────────────────────────────────────────────
  function getFilters() {
    const wk  = wkSel.value === 'all' ? null : +wkSel.value;
    const mon = monSel.value === 'all' ? null : monSel.value;
    const yrs = [...activeYears].sort((a,b)=>a-b);
    return { wk, mon, yrs };
  }

  // Weeks that match current filter — always intersected with weeks that exist
  // in the data for the selected years so we never show empty rows
  function filteredWks(f) {
    let wks;
    if (f.wk != null)       wks = [f.wk];
    else if (f.mon != null) wks = (Y.month_wks[f.mon] || []).map(Number);
    else                    wks = allWknums;
    // keep only weeks that have data for at least one selected year in overall
    return wks.filter(w => f.yrs.some(yr => Y.overall[w]?.[yr] != null));
  }

  // ── Chart (line = all weeks, bar = single week) ───────────────────────────
  const yoyCharts = {};
  function buildYoYChart(canvasId, seriesData, f) {
    const wks  = filteredWks(f);
    const yrs  = f.yrs;
    if (yoyCharts[canvasId]) { yoyCharts[canvasId].destroy(); }

    const isSingleWk = wks.length === 1;
    // Single week: bar chart — X = year, one bar per year
    // Multi week: line chart — X = week, one line per year
    let chartCfg;
    if (isSingleWk) {
      const wk = wks[0];
      chartCfg = {
        type: 'bar',
        data: {
          labels: yrs.map(String),
          datasets: [{
            label: 'IGCC%',
            data: yrs.map(yr => seriesData[wk]?.[yr] ?? null),
            backgroundColor: yrs.map(yr => YEAR_COLORS[yr] ? YEAR_COLORS[yr]+'99' : '#ccc9'),
            borderColor:     yrs.map(yr => YEAR_COLORS[yr] || '#ccc'),
            borderWidth: 1.5,
            borderRadius: 4,
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y?.toFixed(2)}%` } }
          },
          scales: {
            x: { grid:{color:'rgba(48,54,61,.5)'}, ticks:{color:'#8b949e',font:{size:11}} },
            y: { grid:{color:'rgba(48,54,61,.5)'}, ticks:{color:'#8b949e',font:{size:10},callback:v=>v.toFixed(1)+'%'}, min:0 }
          }
        }
      };
    } else {
      chartCfg = {
        type: 'line',
        data: {
          labels: wks.map(w => 'Wk' + w),
          datasets: yrs.map(yr => ({
            label: String(yr),
            data:  wks.map(w => seriesData[w]?.[yr] ?? null),
            borderColor: YEAR_COLORS[yr] || '#ccc',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: wks.length <= 20 ? 3 : 0,
            pointHoverRadius: 5,
            tension: 0.3,
            spanGaps: true,
          }))
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { labels:{ color:'#8b949e', font:{size:10}, boxWidth:10 } },
            tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(2)}%` } }
          },
          scales: {
            x: { grid:{color:'rgba(48,54,61,.5)'}, ticks:{color:'#8b949e',font:{size:9},maxTicksLimit:18} },
            y: { grid:{color:'rgba(48,54,61,.5)'}, ticks:{color:'#8b949e',font:{size:10},callback:v=>v.toFixed(1)+'%'}, min:0 }
          }
        }
      };
    }
    yoyCharts[canvasId] = new Chart(document.getElementById(canvasId), chartCfg);
  }

  // ── Summary table ─────────────────────────────────────────────────────────
  function heatCell(v, allVals) {
    if (v == null) return '<td>—</td>';
    const mn = Math.min(...allVals.filter(x=>x!=null));
    const mx = Math.max(...allVals.filter(x=>x!=null));
    const ratio = (mx === mn) ? 0 : (v - mn) / (mx - mn);
    const r = Math.round(ratio * 200), g = Math.round((1-ratio) * 150);
    return `<td><span class="heat" style="background:rgba(${r},${g},30,0.28)">${v.toFixed(2)}%</span></td>`;
  }

  // ── "All" mode (no single week/month picked): a true weighted Month × Year
  // grid, built from the same raw city_detail sums the WoW Trend tab uses
  // (Y.overall/tier1/tier2 only hold pre-computed %, no raw counts to weight
  // by — see sumRawKeys/cityAggKeys, hoisted above initYoY). Grouping by the
  // "Mon'YY" prefix of O.trend_full's composite keys naturally gives one
  // weighted bucket per (month, year) pair.
  function computeYoyMonthGrid() {
    const buckets = monthYearBuckets(O.trend_full.map(d => d.k));
    const parsed = buckets.map(b => {
      const [mon, yy] = b.label.split("'");
      return { mon, year: 2000 + +yy, keys: b.keys };
    });
    const months = MONTH_ORDER_JS.filter(m => parsed.some(p => p.mon === m));
    const years  = [...new Set(parsed.map(p => p.year))].sort((a,b)=>a-b);
    const grid = { overall:{}, tier1:{}, tier2:{} };
    months.forEach(m => { grid.overall[m]={}; grid.tier1[m]={}; grid.tier2[m]={}; });
    parsed.forEach(p => {
      grid.overall[p.mon][p.year] = sumRawKeys(p.keys, null);
      grid.tier1[p.mon][p.year]   = sumRawKeys(p.keys, 'T1');
      grid.tier2[p.mon][p.year]   = sumRawKeys(p.keys, 'T2');
    });
    return { months, years, parsed, grid };
  }

  // Only months with data for at least one currently-selected year (mirrors
  // filteredWks()'s "at least one selected year in overall" guard).
  function filteredMonths(mg, f) {
    return mg.months.filter(m => f.yrs.some(yr => mg.grid.overall[m][yr] != null));
  }

  let sumSeg = 'overall';
  function renderSumTableMonthly(mg, f) {
    const segGrid = sumSeg === 'overall' ? mg.grid.overall : sumSeg === 'tier1' ? mg.grid.tier1 : mg.grid.tier2;
    const yrs = f.yrs;
    const months = filteredMonths(mg, f);
    let html = '<table class="yoy-tbl"><thead><tr><th>Month</th>';
    yrs.forEach(yr => { html += `<th style="color:${YEAR_COLORS[yr]||'#ccc'}">${yr}</th>`; });
    for (let i = 1; i < yrs.length; i++) {
      html += `<th style="color:var(--muted);font-size:11px">${yrs[i-1]}→${yrs[i]}</th>`;
    }
    html += '</tr></thead><tbody>';
    months.forEach(m => {
      const vals = yrs.map(yr => segGrid[m][yr]?.pct ?? null);
      const allV = vals.filter(v=>v!=null);
      html += `<tr><td>${m}</td>`;
      vals.forEach(v => { html += heatCell(v, allV); });
      for (let i = 1; i < yrs.length; i++) {
        const a = segGrid[m][yrs[i-1]]?.pct ?? null;
        const b = segGrid[m][yrs[i]]?.pct ?? null;
        if (a==null||b==null) { html += '<td>—</td>'; continue; }
        const d = b-a, sign = d>0?'+':'';
        const col = d>0.05?'var(--red)':d<-0.05?'var(--green)':'var(--muted)';
        const arr = d>0.05?'▲':d<-0.05?'▼':'●';
        html += `<td style="color:${col};font-weight:600">${arr} ${sign}${d.toFixed(2)}%</td>`;
      }
      html += '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('yoy-sum-container').innerHTML = html;
  }
  function renderSum(f) {
    if (f.wk == null && f.mon == null) renderSumTableMonthly(computeYoyMonthGrid(), f);
    else renderSumTable(f);
  }
  function renderSumTable(f) {
    const data = sumSeg === 'overall' ? Y.overall : sumSeg === 'tier1' ? Y.tier1 : Y.tier2;
    const wks  = filteredWks(f);
    const yrs  = f.yrs;
    let html = '<table class="yoy-tbl"><thead><tr><th>Week</th><th>Month</th>';
    yrs.forEach(yr => { html += `<th style="color:${YEAR_COLORS[yr]||'#ccc'}">${yr}</th>`; });
    for (let i = 1; i < yrs.length; i++) {
      html += `<th style="color:var(--muted);font-size:11px">${yrs[i-1]}→${yrs[i]}</th>`;
    }
    html += '</tr></thead><tbody>';
    wks.forEach(wk => {
      const mon  = Y.wk_month[wk] || '';
      const vals = yrs.map(yr => data[wk]?.[yr] ?? null);
      const allV = vals.filter(v=>v!=null);
      html += `<tr><td>Wk${wk}</td><td style="color:var(--muted)">${mon}</td>`;
      vals.forEach(v => { html += heatCell(v, allV); });
      for (let i = 1; i < yrs.length; i++) {
        const a = data[wk]?.[yrs[i-1]] ?? null;
        const b = data[wk]?.[yrs[i]]   ?? null;
        if (a==null||b==null) { html += '<td>—</td>'; continue; }
        const d = b-a, sign = d>0?'+':'';
        const col = d>0.05?'var(--red)':d<-0.05?'var(--green)':'var(--muted)';
        const arr = d>0.05?'▲':d<-0.05?'▼':'●';
        html += `<td style="color:${col};font-weight:600">${arr} ${sign}${d.toFixed(2)}%</td>`;
      }
      html += '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('yoy-sum-container').innerHTML = html;
  }

  // ── Segment buttons ────────────────────────────────────────────────────────
  document.querySelectorAll('.period-btns-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-btns-btn').forEach(b => {
        b.style.background='var(--surface2)'; b.style.borderColor='var(--border)';
        b.style.color='var(--muted)'; b.style.fontWeight='';
      });
      btn.style.fontWeight = '600';
      const seg = btn.dataset.seg;
      const segCol = seg==='overall'?'rgba(88,166,255,':seg==='tier1'?'rgba(247,129,102,':'rgba(63,185,80,';
      const txtCol = seg==='overall'?'#58a6ff':seg==='tier1'?'#f78166':'#3fb950';
      btn.style.background=segCol+'0.15)'; btn.style.borderColor=segCol+'0.4)'; btn.style.color=txtCol;
      sumSeg = seg;
      renderSum(getFilters());
    });
  });

  // ── City table ────────────────────────────────────────────────────────────
  function renderCityTableMonthly(f) {
    const yrs = f.yrs;
    const mg = computeYoyMonthGrid();
    const { parsed } = mg;
    const months = filteredMonths(mg, f);
    const q     = document.getElementById('yoy-city-search').value.toLowerCase();
    const tier  = document.getElementById('yoy-city-tier').value;
    const cities = Object.keys(Y.cities)
      .filter(c => {
        if (q && !c.toLowerCase().includes(q)) return false;
        if (tier !== 'all' && Y.city_tiers[c] !== tier) return false;
        return true;
      }).sort();

    let html = '<table class="yoy-city-tbl"><thead><tr><th>City</th><th>Tier</th>';
    months.forEach(m => {
      yrs.forEach(yr => { html += `<th style="color:${YEAR_COLORS[yr]||'#ccc'}">${m} ${yr}</th>`; });
      if (yrs.length > 1) {
        html += `<th style="color:var(--muted);font-size:10px">Δ ${yrs[yrs.length-2]}→${yrs[yrs.length-1]}</th>`;
      }
    });
    html += '</tr></thead><tbody>';

    cities.forEach(city => {
      const cd = P.city_detail[city];
      const tier_lbl = Y.city_tiers[city] || '';
      html += `<tr><td>${city}</td><td><span class="tier-pill ${tier_lbl}">${tier_lbl}</span></td>`;
      months.forEach(m => {
        const valsByYear = {};
        parsed.filter(p => p.mon === m).forEach(p => { valsByYear[p.year] = cd ? cityAggKeys(cd, p.keys).pct : null; });
        const vals = yrs.map(yr => valsByYear[yr] ?? null);
        const allV = vals.filter(v=>v!=null);
        vals.forEach(v => {
          if (v==null) { html += '<td>—</td>'; return; }
          const mn=Math.min(...allV), mx=Math.max(...allV);
          const ratio=(mx===mn)?0:(v-mn)/(mx-mn);
          const r=Math.round(ratio*200), g=Math.round((1-ratio)*150);
          html += `<td><span class="heat" style="background:rgba(${r},${g},30,0.28)">${v.toFixed(2)}%</span></td>`;
        });
        if (yrs.length > 1) {
          const a = valsByYear[yrs[yrs.length-2]] ?? null, b = valsByYear[yrs[yrs.length-1]] ?? null;
          if (a==null||b==null) { html += '<td>—</td>'; }
          else {
            const d=b-a, sign=d>0?'+':'';
            const col=d>0.05?'var(--red)':d<-0.05?'var(--green)':'var(--muted)';
            html += `<td style="color:${col};font-weight:600">${d>0.05?'▲':d<-0.05?'▼':'●'} ${sign}${d.toFixed(2)}%</td>`;
          }
        }
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('yoy-city-container').innerHTML = html;
  }
  function renderCity(f) {
    if (f.wk == null && f.mon == null) renderCityTableMonthly(f);
    else renderCityTable(f);
  }
  function renderCityTable(f) {
    const wks   = filteredWks(f);
    const yrs   = f.yrs;
    const q     = document.getElementById('yoy-city-search').value.toLowerCase();
    const tier  = document.getElementById('yoy-city-tier').value;
    const cities = Object.keys(Y.cities)
      .filter(c => {
        if (q && !c.toLowerCase().includes(q)) return false;
        if (tier !== 'all' && Y.city_tiers[c] !== tier) return false;
        return true;
      }).sort();

    let html = '<table class="yoy-city-tbl"><thead><tr><th>City</th><th>Tier</th>';
    wks.forEach(wk => {
      yrs.forEach(yr => {
        html += `<th style="color:${YEAR_COLORS[yr]||'#ccc'}">Wk${wk} ${yr}</th>`;
      });
      if (yrs.length > 1) {
        html += `<th style="color:var(--muted);font-size:10px">Δ ${yrs[yrs.length-2]}→${yrs[yrs.length-1]}</th>`;
      }
    });
    html += '</tr></thead><tbody>';

    cities.forEach(city => {
      const cdata = Y.cities[city] || {};
      const tier_lbl = Y.city_tiers[city] || '';
      html += `<tr><td>${city}</td><td><span class="tier-pill ${tier_lbl}">${tier_lbl}</span></td>`;
      wks.forEach(wk => {
        const vals = yrs.map(yr => cdata[wk]?.[yr] ?? null);
        const allV = vals.filter(v=>v!=null);
        vals.forEach(v => {
          if (v==null) { html += '<td>—</td>'; return; }
          const mn=Math.min(...allV), mx=Math.max(...allV);
          const ratio=(mx===mn)?0:(v-mn)/(mx-mn);
          const r=Math.round(ratio*200), g=Math.round((1-ratio)*150);
          html += `<td><span class="heat" style="background:rgba(${r},${g},30,0.28)">${v.toFixed(2)}%</span></td>`;
        });
        if (yrs.length > 1) {
          const a=cdata[wk]?.[yrs[yrs.length-2]]??null, b=cdata[wk]?.[yrs[yrs.length-1]]??null;
          if (a==null||b==null) { html += '<td>—</td>'; }
          else {
            const d=b-a, sign=d>0?'+':'';
            const col=d>0.05?'var(--red)':d<-0.05?'var(--green)':'var(--muted)';
            html += `<td style="color:${col};font-weight:600">${d>0.05?'▲':d<-0.05?'▼':'●'} ${sign}${d.toFixed(2)}%</td>`;
          }
        }
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('yoy-city-container').innerHTML = html;
  }

  // ── Monthly chart (no single week/month picked): x-axis = calendar month,
  // one line per year, values from the weighted Month × Year grid.
  function buildYoYMonthlyChart(canvasId, segGrid, mg, f) {
    const months = filteredMonths(mg, f), yrs = f.yrs;
    if (yoyCharts[canvasId]) yoyCharts[canvasId].destroy();
    yoyCharts[canvasId] = new Chart(document.getElementById(canvasId), {
      type: 'line',
      data: {
        labels: months,
        datasets: yrs.map(yr => ({
          label: String(yr),
          data:  months.map(m => segGrid[m][yr]?.pct ?? null),
          borderColor: YEAR_COLORS[yr] || '#ccc',
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          tension: 0.3,
          spanGaps: true,
        }))
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { labels:{ color:'#8b949e', font:{size:10}, boxWidth:10 } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(2)}%` } }
        },
        scales: {
          x: { grid:{color:'rgba(48,54,61,.5)'}, ticks:{color:'#8b949e',font:{size:10}} },
          y: { grid:{color:'rgba(48,54,61,.5)'}, ticks:{color:'#8b949e',font:{size:10},callback:v=>v.toFixed(1)+'%'}, min:0 }
        }
      }
    });
  }

  // ── Render all ────────────────────────────────────────────────────────────
  function renderAll() {
    const f = getFilters();
    if (f.wk == null && f.mon == null) {
      const mg = computeYoyMonthGrid();
      buildYoYMonthlyChart('yoy-chart-overall', mg.grid.overall, mg, f);
      buildYoYMonthlyChart('yoy-chart-t1',      mg.grid.tier1,   mg, f);
      buildYoYMonthlyChart('yoy-chart-t2',      mg.grid.tier2,   mg, f);
    } else {
      buildYoYChart('yoy-chart-overall', Y.overall, f);
      buildYoYChart('yoy-chart-t1',      Y.tier1,   f);
      buildYoYChart('yoy-chart-t2',      Y.tier2,   f);
    }
    renderSum(f);
    renderCity(f);
  }

  wkSel.addEventListener('change',  () => { monSel.value='all'; renderAll(); });
  monSel.addEventListener('change', () => { wkSel.value='all';  renderAll(); });
  document.getElementById('yoy-city-search').addEventListener('input',  () => renderCity(getFilters()));
  document.getElementById('yoy-city-tier').addEventListener('change',   () => renderCity(getFilters()));

  if (GLOBAL_MONTH !== 'all') monSel.value = GLOBAL_MONTH;   // honor a month picked before this tab was opened
  renderAll();
}

// ── RCA Tab ───────────────────────────────────────────────────────────────────
function initRCA() {
  const SPOC_COLORS = {
    'Pod':     { border:'#58a6ff', bg:'rgba(88,166,255,.18)' },
    'WH':      { border:'#f78166', bg:'rgba(247,129,102,.18)' },
    'Sourcing':{ border:'#d29922', bg:'rgba(210,153,34,.18)' },
    'CX':      { border:'#3fb950', bg:'rgba(63,185,80,.18)' },
  };
  const SPOC_ORDER = ['Pod','WH','Sourcing','CX'];

  let activeLvl = 'pan_india';
  let donutChart = null, barChart = null;

  const SPOC_CHIP_STYLE = {
    Pod:      'background:rgba(88,166,255,.15);color:#58a6ff',
    WH:       'background:rgba(247,129,102,.15);color:#f78166',
    Sourcing: 'background:rgba(210,153,34,.15);color:#d29922',
    CX:       'background:rgba(63,185,80,.15);color:#3fb950',
  };

  // Level → which city tiers are shown in city table
  const LEVEL_TIER_FILTER = { pan_india: null, T1: 'T1', T2: 'T2' };
  const LEVEL_LABELS = { pan_india: 'Pan India/City wise', T1: 'Tier 1', T2: 'Tier 2' };

  // "All Months": one weighted RCA aggregate per calendar month, chronological.
  let rcaMonthlyPick = null;   // which month's row is expanded below; null = latest
  function computeRcaMonthlyOverview() {
    const months = Object.keys(MONTH_WKS).filter(m => (MONTH_WKS[m] || []).some(w => WOWRCA.by_week[String(w)]));
    months.sort((a, b) => Math.max(...MONTH_WKS[a]) - Math.max(...MONTH_WKS[b]));
    return months.map(m => ({ month: m, agg: aggregateRcaWeeks(MONTH_WKS[m]) })).filter(x => x.agg);
  }
  function renderRcaMonthlyOverview(overview, pickMonth) {
    const el = document.getElementById('rca-monthly-overview');
    if (!overview.length) { el.innerHTML = ''; return; }
    let html = '<table class="sum-tbl"><thead><tr><th>Month</th><th class="num">Pan India IGCC%</th>'
      + '<th class="num">Tier 1 IGCC%</th><th class="num">Tier 2 IGCC%</th><th>Top Reason</th><th>Top SPOC</th></tr></thead><tbody>';
    overview.forEach(({ month, agg }) => {
      const pan = agg.pan_india, t1 = agg.T1, t2 = agg.T2;
      const topSpoc   = Object.entries(pan.spocs).sort((a, b) => b[1].igcc - a[1].igcc)[0];
      const topReason = topSpoc ? (topSpoc[1].reasons[0]?.reason || '—') : '—';
      const isPicked  = month === pickMonth;
      html += `<tr class="rca-month-row${isPicked ? ' cur-row' : ''}" data-month="${month}" style="cursor:pointer">`
        + `<td>${month}${isPicked ? ' <span style="font-size:10px;color:var(--accent)">(shown below)</span>' : ''}</td>`
        + `<td class="num">${pan.total_pct.toFixed(2)}%</td>`
        + `<td class="num">${t1.total_pct.toFixed(2)}%</td>`
        + `<td class="num">${t2.total_pct.toFixed(2)}%</td>`
        + `<td>${topReason}</td>`
        + `<td>${topSpoc ? topSpoc[0] : '—'}</td></tr>`;
    });
    html += '</tbody></table>';
    el.innerHTML = html;
    el.querySelectorAll('tr.rca-month-row').forEach(tr => {
      tr.addEventListener('click', () => { rcaMonthlyPick = tr.dataset.month; renderAll(); });
    });
  }

  function renderAll() {
    const monthlyCard = document.getElementById('rca-monthly-card');
    if (GLOBAL_MONTH === 'all') {
      const overview = computeRcaMonthlyOverview();
      monthlyCard.style.display = overview.length ? '' : 'none';
      const pickMonth = (rcaMonthlyPick && overview.some(o => o.month === rcaMonthlyPick))
        ? rcaMonthlyPick
        : (overview.length ? overview[overview.length - 1].month : null);
      renderRcaMonthlyOverview(overview, pickMonth);
      const picked = pickMonth ? overview.find(o => o.month === pickMonth) : null;
      RCA_VIEW = picked ? picked.agg : RCA;
      document.getElementById('rca-wk-badge').textContent = pickMonth ? (pickMonth + ' (monthly avg)') : ('Week ' + RCA_VIEW.week);
    } else {
      monthlyCard.style.display = 'none';
      RCA_VIEW = computeRcaView();
      document.getElementById('rca-wk-badge').textContent = GLOBAL_MONTH + ' — Wk ' + RCA_VIEW.week;
    }

    const lvl    = activeLvl;
    const d      = RCA_VIEW[lvl];
    if (!d) return;

    // read shared filters (city section)
    const q      = document.getElementById('rca-city-search').value.toLowerCase();
    const spocF  = document.getElementById('rca-city-spoc').value;
    const sortBy = document.getElementById('rca-city-sort').value;

    // ── KPI strip ──────────────────────────────────────────────────────────
    document.getElementById('rca-kpi').innerHTML = [
      { label:'Total Orders',     val: d.orders.toLocaleString() },
      { label:'Total Complaints', val: d.total_igcc.toLocaleString() },
      { label:'Overall IGCC%',    val: d.total_pct.toFixed(2) + '%' },
      { label:'SPOCs tracked',    val: Object.keys(d.spocs).length },
    ].map(k => `<div class="kpi" style="min-width:140px;flex:1">
      <div class="label">${k.label}</div>
      <div class="value" style="font-size:22px">${k.val}</div>
    </div>`).join('');

    // ── Donut — SPOC share ─────────────────────────────────────────────────
    let donutSpocs = SPOC_ORDER.filter(s => d.spocs[s]);
    if (spocF !== 'all') donutSpocs = donutSpocs.filter(s => s === spocF);
    const spocIgcc   = donutSpocs.map(s => d.spocs[s].igcc);
    const spocColors = donutSpocs.map(s => SPOC_COLORS[s]?.border || '#ccc');

    if (donutChart) { donutChart.destroy(); }
    donutChart = new Chart(document.getElementById('rca-donut'), {
      type: 'doughnut',
      data: {
        labels: donutSpocs,
        datasets: [{ data: spocIgcc, backgroundColor: spocColors, borderColor: 'var(--surface)', borderWidth: 2, hoverOffset: 6 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '62%',
        plugins: {
          legend: { position:'bottom', labels:{ color:'#8b949e', font:{size:11}, boxWidth:12, padding:12 } },
          tooltip: { callbacks: {
            label: ctx => {
              const s = donutSpocs[ctx.dataIndex];
              const pct = d.spocs[s].share;
              return ` ${s}: ${ctx.parsed.toLocaleString()} (${pct}%)`;
            }
          }}
        }
      }
    });

    // ── Bar — reasons (filtered by SPOC if selected) ───────────────────────
    const reasonMap = {};
    const spocsForBar = spocF !== 'all' ? [spocF] : SPOC_ORDER;
    spocsForBar.forEach(spoc => {
      (d.spocs[spoc]?.reasons || []).forEach(r => {
        if (!reasonMap[r.reason]) reasonMap[r.reason] = { igcc: 0, spoc };
        reasonMap[r.reason].igcc += r.igcc;
        if (r.igcc > (reasonMap[r.reason]._max || 0)) {
          reasonMap[r.reason]._max = r.igcc;
          reasonMap[r.reason].spoc = spoc;
        }
      });
    });
    const sortedReasons = Object.entries(reasonMap).sort((a,b) => b[1].igcc - a[1].igcc);
    const rLabels = sortedReasons.map(([r]) => r.length > 28 ? r.slice(0,26)+'…' : r);
    const rData   = sortedReasons.map(([,v]) => v.igcc);
    const rPct    = sortedReasons.map(([,v]) => d.orders > 0 ? (v.igcc/d.orders*100).toFixed(3) : 0);
    const rColors = sortedReasons.map(([,v]) => SPOC_COLORS[v.spoc]?.border || '#8b949e');

    document.getElementById('rca-bar-title').textContent =
      spocF !== 'all' ? `IGCC% by Reason — ${spocF}` : 'IGCC% by Reason — All SPOCs';

    if (barChart) { barChart.destroy(); }
    barChart = new Chart(document.getElementById('rca-reason-bar'), {
      type: 'bar',
      data: {
        labels: rLabels,
        datasets: [{
          label: 'Complaints',
          data: rData,
          backgroundColor: rColors.map(c => c + '99'),
          borderColor: rColors,
          borderWidth: 1.5,
          borderRadius: 3,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            label: ctx => ` ${ctx.parsed.x.toLocaleString()} complaints · ${rPct[ctx.dataIndex]}% IGCC`
          }}
        },
        scales: {
          x: { grid:{color:'rgba(48,54,61,.5)'}, ticks:{color:'#8b949e',font:{size:10}} },
          y: { grid:{display:false}, ticks:{color:'#e6edf3',font:{size:11}} }
        }
      }
    });

    // ── SPOC cards ──────────────────────────────────────────────────────────
    const grid = document.getElementById('rca-spoc-grid');
    grid.innerHTML = '';
    const spocsForCards = spocF !== 'all' ? [spocF] : SPOC_ORDER;
    spocsForCards.forEach(spoc => {
      const sd = d.spocs[spoc];
      if (!sd) return;
      const col = SPOC_COLORS[spoc] || { border:'#8b949e', bg:'rgba(139,148,158,.15)' };

      const card = document.createElement('div');
      card.className = 'spoc-card';
      card.style.borderTop = `3px solid ${col.border}`;

      const hdr = document.createElement('div');
      hdr.className = 'spoc-card-hdr';
      hdr.style.background = col.bg;
      hdr.innerHTML = `
        <div>
          <div class="spoc-name" style="color:${col.border}">${spoc}</div>
          <div class="spoc-meta">${sd.igcc.toLocaleString()} complaints · ${sd.share}% of total</div>
        </div>
        <div class="spoc-pct" style="color:${col.border}">${sd.pct.toFixed(2)}%</div>`;
      card.appendChild(hdr);

      const tbl = document.createElement('table');
      tbl.className = 'spoc-reason-tbl';
      tbl.innerHTML = `<thead><tr>
        <th>Reason</th><th>Complaints</th><th>IGCC%</th>
        <th style="min-width:100px">Share of SPOC</th>
      </tr></thead>`;
      const tbody = document.createElement('tbody');
      sd.reasons.forEach(r => {
        const barW = Math.max(2, Math.round(r.share));
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${r.reason}</td>
          <td>${r.igcc.toLocaleString()}</td>
          <td>${r.pct.toFixed(3)}%</td>
          <td>
            <div class="share-bar-wrap">
              <span style="font-size:11px;font-weight:600;color:${col.border};min-width:36px;text-align:right">${r.share}%</span>
              <span class="share-bar" style="width:${barW}px;background:${col.border}"></span>
            </div>
          </td>`;
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      card.appendChild(tbl);
      grid.appendChild(card);
    });

    // ── City-wise RCA table ───────────────────────────────────────────────
    // Level controls which tier of cities is shown
    const tierFilter = LEVEL_TIER_FILTER[lvl];  // null = all, 'T1' or 'T2' = filtered

    document.getElementById('rca-city-heading').textContent =
      `City-wise RCA — ${LEVEL_LABELS[lvl]}`;

    let cityRows = Object.entries(RCA_VIEW.cities).filter(([city, cd]) => {
      if (tierFilter && cd.tier !== tierFilter) return false;
      if (q && !city.toLowerCase().includes(q)) return false;
      if (spocF !== 'all' && !cd.spocs[spocF]) return false;
      return true;
    });

    cityRows.sort((a, b) => {
      if (sortBy === 'pct_desc')  return b[1].total_pct  - a[1].total_pct;
      if (sortBy === 'pct_asc')   return a[1].total_pct  - b[1].total_pct;
      if (sortBy === 'igcc_desc') return b[1].total_igcc - a[1].total_igcc;
      return a[0].localeCompare(b[0]);
    });

    document.getElementById('rca-city-count').textContent = cityRows.length + ' cities';

    const spocCols = spocF !== 'all' ? [spocF] : SPOC_ORDER.filter(s =>
      cityRows.some(([, cd]) => cd.spocs[s])
    );

    let html = `<table class="city-rca-tbl"><thead><tr>
      <th></th><th>City</th><th>Tier</th>
      <th class="num">Orders</th><th class="num">Complaints</th><th class="num">IGCC%</th>`;
    spocCols.forEach(s => {
      const c = SPOC_COLORS[s];
      html += `<th class="num" style="color:${c?.border||'#ccc'}">${s}<br><span style="font-weight:400;font-size:10px">IGCC%</span></th>
               <th class="num" style="color:${c?.border||'#ccc'}">${s}<br><span style="font-weight:400;font-size:10px">Share</span></th>`;
    });
    html += `<th>SPOC breakdown</th></tr></thead><tbody>`;

    cityRows.forEach(([city, cd], idx) => {
      const rowId = 'cr-' + idx;
      html += `<tr class="city-row" data-rowid="${rowId}">
        <td><button class="expand-btn" data-rowid="${rowId}">▶</button></td>
        <td style="font-weight:600">${city}</td>
        <td><span class="tier-pill ${cd.tier}">${cd.tier}</span></td>
        <td class="num">${cd.orders.toLocaleString()}</td>
        <td class="num">${cd.total_igcc.toLocaleString()}</td>
        <td class="num" style="font-weight:600">${cd.total_pct.toFixed(2)}%</td>`;

      spocCols.forEach(s => {
        const sd = cd.spocs[s];
        const c  = SPOC_COLORS[s]?.border || '#ccc';
        if (sd) {
          html += `<td class="num" style="color:${c}">${sd.pct.toFixed(3)}%</td>
                   <td class="num" style="color:${c}">${sd.share}%</td>`;
        } else {
          html += `<td class="num" style="color:var(--muted)">—</td><td class="num" style="color:var(--muted)">—</td>`;
        }
      });

      const chips = SPOC_ORDER.filter(s => cd.spocs[s])
        .map(s => `<span class="spoc-chip" style="${SPOC_CHIP_STYLE[s]||''}">${s} ${cd.spocs[s].share}%</span>`).join('');
      html += `<td><div class="spoc-chips">${chips}</div></td></tr>`;

      SPOC_ORDER.filter(s => cd.spocs[s]).forEach(s => {
        const sd = cd.spocs[s];
        const c  = SPOC_COLORS[s]?.border || '#ccc';
        sd.reasons.forEach(r => {
          html += `<tr class="reason-row" data-parent="${rowId}">
            <td></td>
            <td colspan="2" style="color:${c};padding-left:28px">
              <span style="font-size:10px;font-weight:700;margin-right:6px">${s}</span>${r.reason}
            </td>
            <td></td>
            <td class="num">${r.igcc.toLocaleString()}</td>
            <td class="num">${r.pct.toFixed(3)}%</td>`;
          spocCols.forEach(() => { html += `<td></td><td></td>`; });
          html += `<td class="num" style="color:var(--muted)">${r.share}% of ${s}</td></tr>`;
        });
      });
    });

    html += '</tbody></table>';
    document.getElementById('rca-city-table').innerHTML = html;

    document.querySelectorAll('.expand-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const rid = btn.dataset.rowid;
        const isOpen = btn.textContent === '▼';
        btn.textContent = isOpen ? '▶' : '▼';
        document.querySelectorAll(`.reason-row[data-parent="${rid}"]`)
          .forEach(tr => tr.classList.toggle('open', !isOpen));
      });
    });
  }

  // ── Wire ALL filters to renderAll ──────────────────────────────────────
  ['rca-city-search','rca-city-spoc','rca-city-sort'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener(id === 'rca-city-search' ? 'input' : 'change', renderAll);
  });

  document.querySelectorAll('.rca-lvl-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.rca-lvl-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeLvl = btn.dataset.lvl;
      renderAll();
    });
  });

  RCA_RENDER = renderAll;
  renderAll();
}

// ── WoW RCA Tab ───────────────────────────────────────────────────────────────
function initWowRCA() {
  const W         = WOWRCA;
  const ALL_WEEKS = W.weeks;
  const BY_WEEK   = W.by_week;
  const WK_YEAR   = W.wk_year;
  const ALL_CITIES= W.all_cities;

  const SPOC_COLORS = {
    Pod:      { border:'#58a6ff', bg:'rgba(88,166,255,.55)' },
    WH:       { border:'#f78166', bg:'rgba(247,129,102,.55)' },
    Sourcing: { border:'#d29922', bg:'rgba(210,153,34,.55)' },
    CX:       { border:'#3fb950', bg:'rgba(63,185,80,.55)' },
  };
  const SPOC_ORDER = ['Pod','WH','Sourcing','CX'];

  let trendChart = null, spocChart = null;
  let activeLvl  = 'pan_india';
  let activeCity = 'all';   // 'all' = aggregate; else specific city name

  // ── week dropdowns ─────────────────────────────────────────────────────────
  const fromSel = document.getElementById('wrc-wk-from');
  const toSel   = document.getElementById('wrc-wk-to');
  ALL_WEEKS.forEach(wk => {
    const lbl = `Wk${wk} (${WK_YEAR[wk]||''})`;
    fromSel.insertAdjacentHTML('beforeend', `<option value="${wk}">${lbl}</option>`);
    toSel.insertAdjacentHTML('beforeend',   `<option value="${wk}">${lbl}</option>`);
  });
  fromSel.value = ALL_WEEKS[Math.max(0, ALL_WEEKS.length - 12)];
  toSel.value   = ALL_WEEKS[ALL_WEEKS.length - 1];

  // ── city dropdown (LOV, default ALL) ──────────────────────────────────────
  const citySel = document.getElementById('wrc-city-sel');
  citySel.insertAdjacentHTML('beforeend', '<option value="all">All Cities</option>');
  ALL_CITIES.forEach(c => citySel.insertAdjacentHTML('beforeend', `<option value="${c}">${c}</option>`));
  citySel.value = 'all';

  // ── helpers ────────────────────────────────────────────────────────────────
  // "All Months": one column per calendar month (full history), each an
  // aggregateRcaWeeks() rollup of that month's weeks — mirrors the RCA tab's
  // Monthly Overview. Otherwise: the existing From/To week-range columns.
  function filteredWeeks() {
    if (GLOBAL_MONTH === 'all') {
      return Object.keys(MONTH_WKS).filter(m => (MONTH_WKS[m] || []).some(w => BY_WEEK[w]))
        .sort((a, b) => Math.max(...MONTH_WKS[a]) - Math.max(...MONTH_WKS[b]));
    }
    const lo = Math.min(parseInt(fromSel.value), parseInt(toSel.value));
    const hi = Math.max(parseInt(fromSel.value), parseInt(toSel.value));
    return ALL_WEEKS.filter(w => w >= lo && w <= hi);
  }

  function colLabel(col)    { return GLOBAL_MONTH === 'all' ? col : ('Wk' + col); }
  function colSubLabel(col) { return GLOBAL_MONTH === 'all' ? '' : (WK_YEAR[col] || ''); }

  function getLevelData(wk, lvl, city) {
    const wkd = BY_WEEK[wk];
    if (!wkd) return null;
    if (lvl === 'city') return city !== 'all' ? (wkd.cities[city] || null) : null;
    return wkd[lvl] || null;
  }

  function getMonthData(month, lvl, city) {
    const agg = aggregateRcaWeeks(MONTH_WKS[month]);
    if (!agg) return null;
    if (lvl === 'city') return city !== 'all' ? (agg.cities[city] || null) : null;
    return agg[lvl] || null;
  }

  // For city=all, return the correct level data; for a specific city, return city data.
  // `col` is a week number in the default range mode, a month label ("Apr") in
  // "All Months" mode.
  function getData(col) {
    const lvl = activeLvl === 'city' ? 'city' : activeLvl;
    if (GLOBAL_MONTH === 'all') return getMonthData(col, lvl, activeCity);
    return getLevelData(col, lvl, activeCity);
  }

  // Collect all reasons for a given SPOC across filtered weeks
  function spocReasonSet(spoc, weeks) {
    const seen = new Map();  // reason -> max igcc (for stable sort)
    weeks.forEach(wk => {
      const d = getData(wk);
      (d?.spocs?.[spoc]?.reasons || []).forEach(r => {
        seen.set(r.reason, Math.max(seen.get(r.reason) || 0, r.igcc));
      });
    });
    return [...seen.entries()].sort((a,b) => b[1]-a[1]).map(e => e[0]);
  }

  // ── render ─────────────────────────────────────────────────────────────────
  function renderWRC() {
    const weeks  = filteredWeeks();   // week numbers, or month labels when GLOBAL_MONTH==='all'
    activeCity   = citySel.value;   // 'all' or city name
    const spocF  = document.getElementById('wrc-spoc-sel').value;

    fromSel.disabled = toSel.disabled = (GLOBAL_MONTH === 'all');

    const lvlName = activeLvl === 'pan_india' ? 'Pan India'
                  : activeLvl === 'T1'        ? 'Tier 1'
                  : activeLvl === 'T2'        ? 'Tier 2'
                  : (activeCity !== 'all' ? activeCity : 'All Cities');
    const periodWord = GLOBAL_MONTH === 'all' ? 'Monthly' : 'WoW';

    document.getElementById('wrc-trend-title').textContent = `IGCC% Trend — ${lvlName}`;
    document.getElementById('wrc-spoc-title').textContent  = `SPOC Mix ${periodWord} — ${lvlName}`;
    document.getElementById('wrc-tbl-title').textContent   = `${periodWord} Movement — ${lvlName}`;

    const trendLabels = weeks.map(colLabel);

    // ── Trend line ────────────────────────────────────────────────────────
    const trendData = weeks.map(wk => getData(wk)?.total_pct ?? null);

    if (trendChart) trendChart.destroy();
    trendChart = new Chart(document.getElementById('wrc-trend-chart'), {
      type: 'line',
      data: {
        labels: trendLabels,
        datasets: [{
          label: 'IGCC%', data: trendData,
          borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,.1)',
          borderWidth: 2, pointRadius: 4, pointHoverRadius: 6,
          tension: 0.3, fill: true, spanGaps: true,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y != null ? ctx.parsed.y.toFixed(2)+'%' : '—'}` }}
        },
        scales: {
          x: { grid:{color:'rgba(48,54,61,.5)'}, ticks:{color:'#8b949e',font:{size:10}} },
          y: { grid:{color:'rgba(48,54,61,.5)'}, ticks:{color:'#8b949e',font:{size:10}, callback: v => v.toFixed(2)+'%'} }
        }
      }
    });

    // ── SPOC stacked bar ──────────────────────────────────────────────────
    const spocsToShow = spocF !== 'all' ? [spocF] : SPOC_ORDER;
    if (spocChart) spocChart.destroy();
    spocChart = new Chart(document.getElementById('wrc-spoc-chart'), {
      type: 'bar',
      data: {
        labels: trendLabels,
        datasets: spocsToShow.map(spoc => ({
          label: spoc,
          data: weeks.map(wk => getData(wk)?.spocs?.[spoc]?.pct ?? 0),
          backgroundColor: SPOC_COLORS[spoc]?.bg || '#8b949e',
          borderColor:     SPOC_COLORS[spoc]?.border || '#8b949e',
          borderWidth: 1, borderRadius: 2,
        }))
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position:'bottom', labels:{color:'#8b949e',font:{size:11},boxWidth:12,padding:10} },
          tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)}%` }}
        },
        scales: {
          x: { stacked:true, grid:{color:'rgba(48,54,61,.5)'}, ticks:{color:'#8b949e',font:{size:10}} },
          y: { stacked:true, grid:{color:'rgba(48,54,61,.5)'}, ticks:{color:'#8b949e',font:{size:10}, callback: v => v.toFixed(2)+'%'} }
        }
      }
    });

    // ── WoW movement table ────────────────────────────────────────────────
    // Cols: metric | Wk… | Wk… | … | WoW (last two)
    // Rows: Total IGCC% → then per active SPOC → indented reasons mapped to that SPOC
    const spocsForTbl = spocF !== 'all' ? [spocF] : SPOC_ORDER.filter(s =>
      weeks.some(wk => getData(wk)?.spocs?.[s])
    );

    function wowCell(prev, cur) {
      if (prev == null || cur == null) return `<td>—</td>`;
      const d = cur - prev, sign = d > 0 ? '+' : '';
      const cls = d > 0.005 ? 'wrc-wow-up' : d < -0.005 ? 'wrc-wow-dn' : 'wrc-wow-flat';
      const arr = d > 0.005 ? '▲' : d < -0.005 ? '▼' : '●';
      return `<td class="${cls}">${arr} ${sign}${d.toFixed(2)}%</td>`;
    }

    function dataRow(label, arr, rowCls, color) {
      const prev = arr[arr.length - 2] ?? null, cur = arr[arr.length - 1] ?? null;
      let r = `<tr class="${rowCls}"><td style="${color?'color:'+color:''}">${label}</td>`;
      arr.forEach(v => {
        r += v != null
          ? `<td class="wrc-pct" style="${color?'color:'+color:''}">${v.toFixed(2)}%</td>`
          : `<td style="color:var(--muted)">—</td>`;
      });
      if (weeks.length > 1) r += wowCell(prev, cur);
      return r + '</tr>';
    }

    let html = `<table class="wrc-tbl"><thead><tr class="wrc-wk-hdr">
      <th>Metric</th>`;
    weeks.forEach(wk => { html += `<th>${colLabel(wk)}<br><span style="font-weight:400;font-size:10px">${colSubLabel(wk)}</span></th>`; });
    if (weeks.length > 1) html += `<th>${GLOBAL_MONTH === 'all' ? 'MoM' : 'WoW'}</th>`;
    html += `</tr></thead><tbody>`;

    // Total row
    html += dataRow('Total IGCC%', weeks.map(wk => getData(wk)?.total_pct ?? null), 'wrc-total-row', null);

    // SPOC rows with their own mapped reasons
    spocsForTbl.forEach(spoc => {
      const col = SPOC_COLORS[spoc]?.border || '#ccc';
      const spocArr = weeks.map(wk => getData(wk)?.spocs?.[spoc]?.pct ?? null);
      html += dataRow(spoc, spocArr, 'wrc-spoc-row', col);

      // reasons strictly mapped to this SPOC in the data
      const reasons = spocReasonSet(spoc, weeks);
      reasons.forEach(reason => {
        const rArr = weeks.map(wk => {
          const sd = getData(wk)?.spocs?.[spoc];
          const rd = (sd?.reasons || []).find(r => r.reason === reason);
          return rd?.pct ?? null;
        });
        if (rArr.some(v => v != null)) {
          html += dataRow(`↳ ${reason}`, rArr, 'wrc-reason-row', null);
        }
      });
    });

    html += '</tbody></table>';
    document.getElementById('wrc-summary-table').innerHTML = html;

    // ── SPOC contribution table ────────────────────────────────────────────
    const latestCol = weeks[weeks.length - 1];
    document.getElementById('wrc-contrib-title').textContent =
      `SPOC Contribution & Reason Breakdown — ${lvlName} (${colLabel(latestCol)})`;
    renderContribTable(weeks, spocsForTbl);
  }

  // ── SPOC contribution table — % contribution to total IGCC, week on week ──
  function renderContribTable(weeks, spocsForTbl) {
    if (!weeks.length) { document.getElementById('wrc-contrib-table').innerHTML = ''; return; }

    // spoc share  = spoc.igcc / total_igcc * 100  (already stored as d.spocs[s].share)
    // reason share = reason.igcc / total_igcc * 100  (computed via reason.igcc / d.total_igcc)
    function spocContrib(wk, spoc) {
      const d = getData(wk);
      return d?.spocs?.[spoc]?.share ?? null;        // % of total IGCC complaints
    }
    function reasonContrib(wk, spoc, reason) {
      const d = getData(wk);
      if (!d || !d.total_igcc) return null;
      const sd = d.spocs?.[spoc];
      const rd = (sd?.reasons || []).find(x => x.reason === reason);
      return rd != null ? rd.igcc / d.total_igcc * 100 : null;
    }

    function wowDelta(arr) {
      const prev = arr[arr.length - 2] ?? null;
      const cur  = arr[arr.length - 1] ?? null;
      if (prev == null || cur == null) return `<td>—</td>`;
      const d = cur - prev, sign = d > 0 ? '+' : '';
      const cls = d > 0.05 ? 'wrc-wow-up' : d < -0.05 ? 'wrc-wow-dn' : 'wrc-wow-flat';
      const sym = d > 0.05 ? '▲' : d < -0.05 ? '▼' : '●';
      return `<td class="${cls}">${sym} ${sign}${d.toFixed(2)}%</td>`;
    }

    let html = `<table class="wrc-tbl"><thead><tr class="wrc-wk-hdr">
      <th>SPOC</th><th>Reason</th>`;
    weeks.forEach(wk => {
      html += `<th class="num">${colLabel(wk)}<br><span style="font-weight:400;font-size:10px">% of IGCC</span></th>`;
    });
    if (weeks.length > 1) html += `<th class="num">${GLOBAL_MONTH === 'all' ? 'MoM' : 'WoW'}</th>`;
    html += `</tr></thead><tbody>`;

    spocsForTbl.forEach(spoc => {
      const col = SPOC_COLORS[spoc]?.border || '#ccc';
      const spocArr = weeks.map(wk => spocContrib(wk, spoc));
      if (spocArr.every(v => v == null)) return;

      // SPOC row
      html += `<tr class="wrc-spoc-row">
        <td style="color:${col}">${spoc}</td>
        <td style="color:var(--muted);font-size:11px">All reasons</td>`;
      spocArr.forEach(v => {
        html += v != null
          ? `<td class="num wrc-pct" style="color:${col}">${v.toFixed(2)}%</td>`
          : `<td class="num" style="color:var(--muted)">—</td>`;
      });
      if (weeks.length > 1) html += wowDelta(spocArr);
      html += `</tr>`;

      // reason rows (only reasons mapped to this SPOC)
      const reasons = spocReasonSet(spoc, weeks);
      reasons.forEach(reason => {
        const rArr = weeks.map(wk => reasonContrib(wk, spoc, reason));
        if (rArr.every(v => v == null)) return;
        html += `<tr class="wrc-reason-row"><td></td><td style="color:var(--muted)">↳ ${reason}</td>`;
        rArr.forEach(v => {
          html += v != null
            ? `<td class="num">${v.toFixed(2)}%</td>`
            : `<td class="num" style="color:var(--muted)">—</td>`;
        });
        if (weeks.length > 1) html += wowDelta(rArr);
        html += `</tr>`;
      });
    });

    html += '</tbody></table>';
    document.getElementById('wrc-contrib-table').innerHTML = html;
  }

  // ── city view toggle ───────────────────────────────────────────────────────
  function setCityVisibility(lvl) {
    const show = lvl === 'city';
    document.getElementById('wrc-city-fg').style.display  = show ? 'flex' : 'none';
    document.getElementById('wrc-city-sep').style.display = show ? 'block' : 'none';
  }
  setCityVisibility(activeLvl);

  // ── wire events ────────────────────────────────────────────────────────────
  fromSel.addEventListener('change',   renderWRC);
  toSel.addEventListener('change',     renderWRC);
  citySel.addEventListener('change',   renderWRC);
  document.getElementById('wrc-spoc-sel').addEventListener('change', renderWRC);

  document.querySelectorAll('.wrc-lvl-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.wrc-lvl-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeLvl = btn.dataset.lvl;
      setCityVisibility(activeLvl);
      renderWRC();
    });
  });

  registerWeekRangeTab('wowrca', 'wrc-wk-from', 'wrc-wk-to', ALL_WEEKS);
  applyGlobalMonthToWeekTab('wowrca');
  renderWRC();
}

// ── Top Items Tab ─────────────────────────────────────────────────────────────
function initItems() {
  const I           = ITEMS;
  const ALL_WEEKS   = I.weeks;
  const BY_WEEK     = I.by_week;
  const NAMES       = I.names;
  const ALL_CITIES  = I.all_cities;
  const CITY_TIERS  = I.city_tiers;

  const fromSel  = document.getElementById('items-wk-from');
  const toSel    = document.getElementById('items-wk-to');
  const scopeSel = document.getElementById('items-scope-sel');
  const searchEl = document.getElementById('items-search');
  const tierSel  = document.getElementById('items-filter-tier');
  const itemSearchEl = document.getElementById('items-item-search');

  let selectedItemCode = null;
  let currentScope     = 'pan_india';
  let currentRows      = [];

  ALL_WEEKS.forEach(wk => {
    fromSel.insertAdjacentHTML('beforeend', `<option value="${wk}">Wk${wk}</option>`);
    toSel.insertAdjacentHTML('beforeend',   `<option value="${wk}">Wk${wk}</option>`);
  });
  fromSel.value = ALL_WEEKS[Math.max(0, ALL_WEEKS.length - 12)];
  toSel.value   = ALL_WEEKS[ALL_WEEKS.length - 1];

  function refreshScopeOptions() {
    const q    = searchEl.value.toLowerCase();
    const tier = tierSel.value;
    const prev = scopeSel.value;

    scopeSel.innerHTML = '<option value="pan_india">Pan India</option>';
    ALL_CITIES
      .filter(c => {
        if (q && !c.toLowerCase().includes(q)) return false;
        if (tier !== 'all' && CITY_TIERS[c] !== tier) return false;
        return true;
      })
      .sort()
      .forEach(city => {
        const opt = document.createElement('option');
        opt.value = city;
        opt.textContent = city;
        scopeSel.appendChild(opt);
      });

    if ([...scopeSel.options].some(o => o.value === prev)) scopeSel.value = prev;
  }

  // "All Months": full history (every week), ranking/totals span everything
  // and the trend block becomes one column per calendar month. Otherwise:
  // the existing From/To week-range clamp, trend block trailing TREND_N weeks.
  function filteredWeeks() {
    if (GLOBAL_MONTH === 'all') return ALL_WEEKS;
    const lo = Math.min(parseInt(fromSel.value), parseInt(toSel.value));
    const hi = Math.max(parseInt(fromSel.value), parseInt(toSel.value));
    return ALL_WEEKS.filter(w => w >= lo && w <= hi);
  }

  // Re-aggregate top-50 items for the scope+week-range currently selected.
  function computeTop50(scope, weeks) {
    const agg = {};   // code -> [igcc, orders]
    weeks.forEach(wk => {
      const wkd = BY_WEEK[wk];
      if (!wkd) return;
      const bucket = scope === 'pan_india' ? wkd.pan_india : (wkd.cities[scope] || {});
      for (const code in bucket) {
        const [igcc, orders] = bucket[code];
        if (!agg[code]) agg[code] = [0, 0];
        agg[code][0] += igcc;
        agg[code][1] += orders;
      }
    });
    return Object.keys(agg)
      .map(code => {
        const [igcc, orders] = agg[code];
        return {
          code, name: NAMES[code] || code, igcc, orders,
          pct: orders ? igcc / orders * 100 : 0,
        };
      })
      .sort((a, b) => b.igcc - a.igcc)
      .slice(0, 50);
  }

  function renderTable() {
    const scope = scopeSel.value;
    const weeks = filteredWeeks();
    const allRows = computeTop50(scope, weeks);
    const iq   = itemSearchEl.value.trim().toLowerCase();
    const rows = iq
      ? allRows.filter(r => r.name.toLowerCase().includes(iq) || String(r.code).toLowerCase().includes(iq))
      : allRows;
    const label = scope === 'pan_india' ? 'Pan India' : scope;

    if (scope !== currentScope) selectedItemCode = null;
    currentScope = scope;
    currentRows  = rows;
    if (selectedItemCode && !rows.some(r => r.code === selectedItemCode)) selectedItemCode = null;

    document.getElementById('items-tbl-title').textContent = `Top 50 Items — ${label}`;
    const isAll = GLOBAL_MONTH === 'all';
    fromSel.disabled = toSel.disabled = isAll;
    document.getElementById('items-count').textContent = rows.length + ' items · ' +
      (isAll ? 'All Months' : ('Wk' + Math.min(...weeks) + '–Wk' + Math.max(...weeks)));

    // "All Months": one column per calendar month over full history.
    // Otherwise: trailing weeks of the current selection, per-week IGCC%.
    const cols = isAll ? monthsForWeeks(ALL_WEEKS) : weeks.slice(-TREND_N);
    let html = `<table><thead><tr>
      <th>#</th><th>Item</th><th>Item Code</th><th>Complaints</th><th>Orders</th><th>IGCC%</th>
      ${isAll ? monthHeadHTML(cols) : trendHeadHTML(cols)}
    </tr></thead><tbody>`;
    rows.forEach((r, i) => {
      const bg = r.code === selectedItemCode ? 'background:rgba(88,166,255,.18);' : '';
      const getter = wk => {
        const wkd = BY_WEEK[wk];
        if (!wkd) return null;
        const bucket = scope === 'pan_india' ? wkd.pan_india : (wkd.cities[scope] || {});
        return bucket[r.code] || null;
      };
      const series = isAll ? monthlyPctSeries(cols, getter) : pctSeries(cols, getter);
      html += `<tr class="item-row" data-code="${r.code}" style="cursor:pointer;${bg}">
        <td>${i + 1}</td>
        <td>${r.name}</td>
        <td>${r.code}</td>
        <td>${r.igcc.toLocaleString()}</td>
        <td>${r.orders.toLocaleString()}</td>
        <td>${r.pct.toFixed(2)}%</td>
        ${trendCellsHTML(series)}
      </tr>`;
    });
    html += '</tbody></table>';
    const tblEl = document.getElementById('items-tbl');
    tblEl.innerHTML = html;
    tblEl.querySelectorAll('tr.item-row').forEach(tr => {
      tr.addEventListener('click', () => {
        const code = tr.dataset.code;
        selectedItemCode = (selectedItemCode === code) ? null : code;
        tblEl.querySelectorAll('tr.item-row').forEach(r2 => {
          r2.style.background = (r2.dataset.code === selectedItemCode) ? 'rgba(88,166,255,.18)' : '';
        });
        renderRCA();
      });
    });
  }

  // ── True per-item RCA, sourced from Item_level_weekly (ITEM_RCA payload). ──
  const SPOC_COLORS = {
    'Pod':     { border:'#58a6ff', bg:'rgba(88,166,255,.18)' },
    'WH':      { border:'#f78166', bg:'rgba(247,129,102,.18)' },
    'Sourcing':{ border:'#d29922', bg:'rgba(210,153,34,.18)' },
    'CX':      { border:'#3fb950', bg:'rgba(63,185,80,.18)' },
    'DP':      { border:'#bc8cff', bg:'rgba(188,140,255,.18)' },
  };
  const SPOC_ORDER = ['Pod','WH','Sourcing','CX','DP'];

  function buildMixFromSpocReason(spocReason) {
    const grand = Object.values(spocReason).reduce((s, rr) => s + Object.values(rr).reduce((a,b) => a+b, 0), 0);
    const out = {};
    for (const spoc in spocReason) {
      const reasons = spocReason[spoc];
      const spocIgcc = Object.values(reasons).reduce((a,b) => a+b, 0);
      out[spoc] = {
        igcc: spocIgcc,
        share: grand ? Math.round(spocIgcc / grand * 1000) / 10 : 0,
        reasons: Object.keys(reasons)
          .map(rn => ({ reason: rn, igcc: reasons[rn], share: spocIgcc ? Math.round(reasons[rn] / spocIgcc * 1000) / 10 : 0 }))
          .sort((a,b) => b.igcc - a.igcc),
      };
    }
    return out;
  }

  // Aggregate RCA across every item in the scope (used when nothing is selected).
  function scopeRcaMix(scope, weeks, rcaPayload) {
    const spocReason = {};   // spoc -> reason -> igcc
    weeks.forEach(wk => {
      const wkd = rcaPayload.by_week[String(wk)];
      if (!wkd) return;
      const bucket = scope === 'pan_india' ? wkd.pan_india : (wkd.cities[scope] || {});
      for (const code in bucket) {
        const sp = bucket[code].sp;
        for (const spoc in sp) {
          spocReason[spoc] = spocReason[spoc] || {};
          const r = sp[spoc].r;
          for (const reason in r) {
            spocReason[spoc][reason] = (spocReason[spoc][reason] || 0) + r[reason];
          }
        }
      }
    });
    return buildMixFromSpocReason(spocReason);
  }

  // RCA for one specific item code only.
  function itemRcaMix(code, scope, weeks, rcaPayload) {
    const spocReason = {};
    let orders = 0;
    weeks.forEach(wk => {
      const wkd = rcaPayload.by_week[String(wk)];
      if (!wkd) return;
      const bucket = scope === 'pan_india' ? wkd.pan_india : (wkd.cities[scope] || {});
      const blk = bucket[code];
      if (!blk) return;
      orders += blk.o || 0;
      for (const spoc in blk.sp) {
        spocReason[spoc] = spocReason[spoc] || {};
        const r = blk.sp[spoc].r;
        for (const reason in r) {
          spocReason[spoc][reason] = (spocReason[spoc][reason] || 0) + r[reason];
        }
      }
    });
    return { orders, mix: buildMixFromSpocReason(spocReason) };
  }

  function renderRCA() {
    const scope  = scopeSel.value;
    const weeks  = filteredWeeks();
    const grid   = document.getElementById('items-rca-grid');
    const titleEl = document.getElementById('items-rca-title');
    grid.innerHTML = '';

    const label = scope === 'pan_india' ? 'Pan India' : scope;
    let mix;
    if (selectedItemCode) {
      const itemRow = currentRows.find(r => r.code === selectedItemCode);
      const itemName = itemRow ? itemRow.name : (ITEM_RCA.names[selectedItemCode] || selectedItemCode);
      mix = itemRcaMix(selectedItemCode, scope, weeks, ITEM_RCA).mix;
      titleEl.textContent = `RCA Bucket Mix — ${itemName} (${label})`;
    } else {
      mix = scopeRcaMix(scope, weeks, ITEM_RCA);
      titleEl.textContent = `RCA Bucket Mix — ${label}, all top items (click a row above for item-level RCA)`;
    }

    if (!SPOC_ORDER.some(spoc => mix[spoc])) {
      grid.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0">No RCA data available for this selection (item-level RCA tracking starts Wk9).</div>';
      return;
    }

    SPOC_ORDER.forEach(spoc => {
      const sd = mix[spoc];
      if (!sd) return;
      const col = SPOC_COLORS[spoc] || { border:'#8b949e', bg:'rgba(139,148,158,.15)' };

      const card = document.createElement('div');
      card.className = 'spoc-card';
      card.style.borderTop = `3px solid ${col.border}`;

      const hdr = document.createElement('div');
      hdr.className = 'spoc-card-hdr';
      hdr.style.background = col.bg;
      hdr.innerHTML = `
        <div>
          <div class="spoc-name" style="color:${col.border}">${spoc}</div>
          <div class="spoc-meta">${sd.igcc.toLocaleString()} complaints · ${sd.share}% of total</div>
        </div>
        <div class="spoc-pct" style="color:${col.border}">${sd.share}%</div>`;
      card.appendChild(hdr);

      const tbl = document.createElement('table');
      tbl.className = 'spoc-reason-tbl';
      tbl.innerHTML = `<thead><tr>
        <th>Reason</th><th>Complaints</th><th style="min-width:100px">Share of SPOC</th>
      </tr></thead>`;
      const tbody = document.createElement('tbody');
      sd.reasons.forEach(r => {
        const barW = Math.max(2, Math.round(r.share));
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${r.reason}</td>
          <td>${r.igcc.toLocaleString()}</td>
          <td>
            <div class="share-bar-wrap">
              <span style="font-size:11px;font-weight:600;color:${col.border};min-width:36px;text-align:right">${r.share}%</span>
              <span class="share-bar" style="width:${barW}px;background:${col.border}"></span>
            </div>
          </td>`;
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      card.appendChild(tbl);
      grid.appendChild(card);
    });
  }

  function renderAll() {
    renderTable();
    renderRCA();
  }

  refreshScopeOptions();

  searchEl.addEventListener('input',  () => { refreshScopeOptions(); renderAll(); });
  itemSearchEl.addEventListener('input', renderAll);
  tierSel.addEventListener('change',  () => { refreshScopeOptions(); renderAll(); });
  scopeSel.addEventListener('change', renderAll);
  fromSel.addEventListener('change',  renderAll);
  toSel.addEventListener('change',    renderAll);

  registerWeekRangeTab('items', 'items-wk-from', 'items-wk-to', ALL_WEEKS);
  applyGlobalMonthToWeekTab('items');
  renderAll();
}

function initNectr() {
  const CAT   = NECTR.cat;
  const ITEMS_N = NECTR.items;

  const fromSel = document.getElementById('nectr-wk-from');
  const toSel   = document.getElementById('nectr-wk-to');
  const itemSearchEl = document.getElementById('nectr-item-search');

  const allWeeks = Array.from(new Set([...CAT.weeks, ...ITEMS_N.weeks])).sort((a,b) => a - b);
  allWeeks.forEach(wk => {
    fromSel.insertAdjacentHTML('beforeend', `<option value="${wk}">Wk${wk}</option>`);
    toSel.insertAdjacentHTML('beforeend',   `<option value="${wk}">Wk${wk}</option>`);
  });
  fromSel.value = allWeeks[0];
  toSel.value   = allWeeks[allWeeks.length - 1];

  let selectedCode = null;
  let currentRows  = [];
  let catChart     = null;

  function filteredWeeks() {
    if (GLOBAL_MONTH === 'all') return allWeeks;
    const lo = Math.min(parseInt(fromSel.value), parseInt(toSel.value));
    const hi = Math.max(parseInt(fromSel.value), parseInt(toSel.value));
    return allWeeks.filter(w => w >= lo && w <= hi);
  }

  function renderCatChart() {
    const isAll  = GLOBAL_MONTH === 'all';
    const weeks  = filteredWeeks().filter(w => CAT.by_week[String(w)]);
    const cities = CAT.cities;
    const colors = ['#58a6ff','#f78166','#3fb950','#d29922','#bc8cff'];
    const cols   = isAll ? monthsForWeeks(weeks) : weeks;

    const datasets = cities.map((city, idx) => ({
      label: city,
      data: isAll
        ? monthlyPctSeries(cols, w => {
            const rec = CAT.by_week[String(w)]?.[city];
            return rec ? [rec.igcc, rec.orders] : null;
          })
        : cols.map(w => {
            const rec = CAT.by_week[String(w)][city];
            return rec ? rec.pct : null;
          }),
      borderColor: colors[idx % colors.length],
      backgroundColor: colors[idx % colors.length] + '30',
      tension: .3,
      spanGaps: true,
    }));

    if (catChart) catChart.destroy();
    catChart = new Chart(document.getElementById('nectr-cat-chart'), {
      type: 'line',
      data: { labels: isAll ? cols : cols.map(w => 'Wk' + w), datasets },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom' } },
        scales: { y: { ticks: { callback: v => v + '%' } } },
      },
    });
  }

  function renderItemTable() {
    const weeks = filteredWeeks();
    const agg = {};   // code -> [igcc, orders]
    weeks.forEach(wk => {
      const wkd = ITEMS_N.by_week[String(wk)];
      if (!wkd) return;
      for (const code in wkd) {
        const [igcc, orders] = wkd[code];
        if (!agg[code]) agg[code] = [0, 0];
        agg[code][0] += igcc;
        agg[code][1] += orders;
      }
    });
    const allRows = Object.keys(agg)
      .map(code => {
        const [igcc, orders] = agg[code];
        return { code, name: ITEMS_N.names[code] || code, igcc, orders, pct: orders ? igcc / orders * 100 : 0 };
      })
      .sort((a, b) => b.igcc - a.igcc);

    const iq = itemSearchEl.value.trim().toLowerCase();
    const rows = iq
      ? allRows.filter(r => r.name.toLowerCase().includes(iq) || String(r.code).toLowerCase().includes(iq))
      : allRows;

    currentRows = rows;
    if (selectedCode && !rows.some(r => r.code === selectedCode)) selectedCode = null;

    const isAll = GLOBAL_MONTH === 'all';
    fromSel.disabled = toSel.disabled = isAll;
    document.getElementById('nectr-count').textContent = rows.length + ' items · ' +
      (isAll ? 'All Months' : (weeks.length ? 'Wk' + Math.min(...weeks) + '–Wk' + Math.max(...weeks) : '—'));

    const cols = isAll ? monthsForWeeks(weeks) : weeks.slice(-TREND_N);
    let html = `<table><thead><tr>
      <th>#</th><th>Item</th><th>Item Code</th><th>Complaints</th><th>Orders</th><th>IGCC%</th>
      ${isAll ? monthHeadHTML(cols) : trendHeadHTML(cols)}
    </tr></thead><tbody>`;
    rows.forEach((r, i) => {
      const bg = r.code === selectedCode ? 'background:rgba(88,166,255,.18);' : '';
      const getter = wk => {
        const wkd = ITEMS_N.by_week[String(wk)];
        return wkd ? (wkd[r.code] || null) : null;
      };
      const series = isAll ? monthlyPctSeries(cols, getter) : pctSeries(cols, getter);
      html += `<tr class="nectr-row" data-code="${r.code}" style="cursor:pointer;${bg}">
        <td>${i + 1}</td>
        <td>${r.name}</td>
        <td>${r.code}</td>
        <td>${r.igcc.toLocaleString()}</td>
        <td>${r.orders.toLocaleString()}</td>
        <td>${r.pct.toFixed(2)}%</td>
        ${trendCellsHTML(series)}
      </tr>`;
    });
    html += '</tbody></table>';
    const tblEl = document.getElementById('nectr-tbl');
    tblEl.innerHTML = html;
    tblEl.querySelectorAll('tr.nectr-row').forEach(tr => {
      tr.addEventListener('click', () => {
        const code = tr.dataset.code;
        selectedCode = (selectedCode === code) ? null : code;
        tblEl.querySelectorAll('tr.nectr-row').forEach(r2 => {
          r2.style.background = (r2.dataset.code === selectedCode) ? 'rgba(88,166,255,.18)' : '';
        });
        renderRCA();
      });
    });
  }

  function renderRCA() {
    const weeks  = filteredWeeks();
    const grid   = document.getElementById('nectr-rca-grid');
    const titleEl = document.getElementById('nectr-rca-title');
    grid.innerHTML = '';

    let mix;
    if (selectedCode) {
      const itemRow = currentRows.find(r => r.code === selectedCode);
      const itemName = itemRow ? itemRow.name : (ITEM_RCA.names[selectedCode] || selectedCode);
      mix = itemRcaMixPanIndia(selectedCode, weeks);
      titleEl.textContent = `RCA Bucket Mix — ${itemName} (Pan India)`;
    } else {
      mix = scopeRcaMixPanIndia(weeks);
      titleEl.textContent = `RCA Bucket Mix — all Nectr items (click a row above for item-level RCA)`;
    }

    const SPOC_ORDER = ['Pod','WH','Sourcing','CX','DP'];
    const SPOC_COLORS = {
      'Pod':     { border:'#58a6ff', bg:'rgba(88,166,255,.18)' },
      'WH':      { border:'#f78166', bg:'rgba(247,129,102,.18)' },
      'Sourcing':{ border:'#d29922', bg:'rgba(210,153,34,.18)' },
      'CX':      { border:'#3fb950', bg:'rgba(63,185,80,.18)' },
      'DP':      { border:'#bc8cff', bg:'rgba(188,140,255,.18)' },
    };

    if (!SPOC_ORDER.some(spoc => mix[spoc])) {
      grid.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0">No RCA data available for this selection.</div>';
      return;
    }

    SPOC_ORDER.forEach(spoc => {
      const sd = mix[spoc];
      if (!sd) return;
      const col = SPOC_COLORS[spoc] || { border:'#8b949e', bg:'rgba(139,148,158,.15)' };

      const card = document.createElement('div');
      card.className = 'spoc-card';
      card.style.borderTop = `3px solid ${col.border}`;

      const hdr = document.createElement('div');
      hdr.className = 'spoc-card-hdr';
      hdr.style.background = col.bg;
      hdr.innerHTML = `
        <div>
          <div class="spoc-name" style="color:${col.border}">${spoc}</div>
          <div class="spoc-meta">${sd.igcc.toLocaleString()} complaints · ${sd.share}% of total</div>
        </div>
        <div class="spoc-pct" style="color:${col.border}">${sd.share}%</div>`;
      card.appendChild(hdr);

      const tbl = document.createElement('table');
      tbl.className = 'spoc-reason-tbl';
      tbl.innerHTML = `<thead><tr>
        <th>Reason</th><th>Complaints</th><th style="min-width:100px">Share of SPOC</th>
      </tr></thead>`;
      const tbody = document.createElement('tbody');
      sd.reasons.forEach(r => {
        const barW = Math.max(2, Math.round(r.share));
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${r.reason}</td>
          <td>${r.igcc.toLocaleString()}</td>
          <td>
            <div class="share-bar-wrap">
              <span style="font-size:11px;font-weight:600;color:${col.border};min-width:36px;text-align:right">${r.share}%</span>
              <span class="share-bar" style="width:${barW}px;background:${col.border}"></span>
            </div>
          </td>`;
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      card.appendChild(tbl);
      grid.appendChild(card);
    });
  }

  function buildMix(spocReason) {
    const grand = Object.values(spocReason).reduce((s, rr) => s + Object.values(rr).reduce((a,b) => a+b, 0), 0);
    const out = {};
    for (const spoc in spocReason) {
      const reasons = spocReason[spoc];
      const spocIgcc = Object.values(reasons).reduce((a,b) => a+b, 0);
      out[spoc] = {
        igcc: spocIgcc,
        share: grand ? Math.round(spocIgcc / grand * 1000) / 10 : 0,
        reasons: Object.keys(reasons)
          .map(rn => ({ reason: rn, igcc: reasons[rn], share: spocIgcc ? Math.round(reasons[rn] / spocIgcc * 1000) / 10 : 0 }))
          .sort((a,b) => b.igcc - a.igcc),
      };
    }
    return out;
  }

  function scopeRcaMixPanIndia(weeks) {
    const spocReason = {};
    weeks.forEach(wk => {
      const wkd = ITEM_RCA.by_week[String(wk)];
      if (!wkd) return;
      const bucket = wkd.pan_india;
      for (const code in ITEMS_N.names) {
        const blk = bucket[code];
        if (!blk) continue;
        for (const spoc in blk.sp) {
          spocReason[spoc] = spocReason[spoc] || {};
          const r = blk.sp[spoc].r;
          for (const reason in r) {
            spocReason[spoc][reason] = (spocReason[spoc][reason] || 0) + r[reason];
          }
        }
      }
    });
    return buildMix(spocReason);
  }

  function itemRcaMixPanIndia(code, weeks) {
    const spocReason = {};
    weeks.forEach(wk => {
      const wkd = ITEM_RCA.by_week[String(wk)];
      if (!wkd) return;
      const blk = wkd.pan_india[code];
      if (!blk) return;
      for (const spoc in blk.sp) {
        spocReason[spoc] = spocReason[spoc] || {};
        const r = blk.sp[spoc].r;
        for (const reason in r) {
          spocReason[spoc][reason] = (spocReason[spoc][reason] || 0) + r[reason];
        }
      }
    });
    return buildMix(spocReason);
  }

  function renderAll() {
    renderCatChart();
    renderItemTable();
    renderRCA();
  }

  fromSel.addEventListener('change', renderAll);
  toSel.addEventListener('change',   renderAll);
  itemSearchEl.addEventListener('input', renderAll);

  registerWeekRangeTab('nectr', 'nectr-wk-from', 'nectr-wk-to', allWeeks);
  applyGlobalMonthToWeekTab('nectr');
  renderAll();
}

// ── Item QnP Tab (Store x Item x Week F&V QnP, reconciled against store total) ─
function initQnp() {
  const Q = QNP;
  const ALL_WEEKS       = Q.weeks;
  const ITEM_NAMES      = Q.item_names;
  const STORE_CITY      = Q.store_city;
  const STORE_WEEK      = Q.store_week;
  const STORE_WEEK_ITEM = Q.store_week_item;
  const ALL_STORES      = Q.all_stores;

  const fromSel   = document.getElementById('qnp-wk-from');
  const toSel     = document.getElementById('qnp-wk-to');
  const comboIn   = document.getElementById('qnp-store-input');
  const comboDrop = document.getElementById('qnp-store-drop');
  const comboClr  = document.getElementById('qnp-store-clear');
  const countEl   = document.getElementById('qnp-count');

  // Searchable store picker. Replaces the old pair of controls (a text box that
  // filtered a <select>) with one field: type to search, click to pick, ✕ to clear.
  // `selectedStore` is the single source of truth — '' means the overall view.
  let selectedStore = '';
  let selectedQnpItem = null;   // item drilled into for the reason breakdown
  const storeSel = {
    get value() { return selectedStore; },
    set value(v) {
      if ((v || '') !== selectedStore) selectedQnpItem = null;   // new store, clear item
      selectedStore = v || '';
      syncComboText();
    },
  };
  // the old code filtered by a separate search box; searchEl now reads the combo text
  // but only while the dropdown is open (so a chosen store's label isn't a filter)
  let comboQuery = '';
  const searchEl = { get value() { return comboQuery; } };
  const kpiRow    = document.getElementById('qnp-kpi-row');
  const overlapEl = document.getElementById('qnp-overlap-note');
  const covEl     = document.getElementById('qnp-coverage-note');
  const itemCard  = document.getElementById('qnp-item-card');
  const itemTitle = document.getElementById('qnp-item-title');
  const itemTbl   = document.getElementById('qnp-item-tbl');
  const lineSel   = document.getElementById('qnp-line-sel');
  const slabSel   = document.getElementById('qnp-slab-sel');
  const lineCard  = document.getElementById('qnp-line-card');
  const lineTbl   = document.getElementById('qnp-line-tbl');
  const slabCard  = document.getElementById('qnp-slab-card');
  const slabTbl   = document.getElementById('qnp-slab-tbl');
  const trdCard   = document.getElementById('qnp-trend-card');
  const trdTitle  = document.getElementById('qnp-trend-title');
  const trdTbl    = document.getElementById('qnp-trend-tbl');
  const rsnCard   = document.getElementById('qnp-reason-card');
  const rsnTitle  = document.getElementById('qnp-reason-title');
  const rsnTbl    = document.getElementById('qnp-reason-tbl');
  const slCard    = document.getElementById('qnp-storelist-card');
  const slTitle   = document.getElementById('qnp-storelist-title');
  const slTbl     = document.getElementById('qnp-storelist-tbl');

  const PARTIAL   = Q.partial_weeks || {};
  const WEEK_DAYS = Q.week_days || {};

  lineSel.innerHTML = '<option value="">All Lines</option>'
    + LINES.map(l => `<option value="${l.key}">${l.label} (${l.range})</option>`).join('');
  slabSel.innerHTML = '<option value="">All slabs</option>'
    + SLABS.map(s => `<option value="${s.key}">${s.label}</option>`).join('');

  // store -> {pct, total, igcc, slab, line} for the current week selection.
  // Recomputed whenever weeks change, since a store's slab depends on the range.
  let statsCache = { key: null, map: null };
  function storeStats(weeks) {
    const ck = weeks.join(',');
    if (statsCache.key === ck) return statsCache.map;
    const map = {};
    ALL_STORES.forEach(s => {
      const a = aggStoreLevel([s], weeks);
      // round once, then use that same value for display AND classification
      const pct = a.total ? round2(a.pct) : null;
      map[s] = { total: a.total, igcc: a.igcc, pct,
                 slab: slabOf(pct), line: lineOf(pct) };
    });
    statsCache = { key: ck, map };
    return map;
  }

  // Weekly QnP% series for one store. STORE_WEEK entries are [orders, igcc] while
  // pctSeries expects [igcc, orders] — normalised here so every caller gets it right.
  function storePctSeries(store, wks) {
    const byWk = STORE_WEEK[store];
    return pctSeries(wks, wk => {
      const rec = byWk ? byWk[String(wk)] : null;
      return rec ? [rec[1], rec[0]] : null;
    });
  }

  // Monthly counterpart to storePctSeries — one weighted QnP% per calendar month.
  function storeMonthlyPctSeries(store, months) {
    const byWk = STORE_WEEK[store];
    return monthlyPctSeries(months, wk => {
      const rec = byWk ? byWk[String(wk)] : null;
      return rec ? [rec[1], rec[0]] : null;
    });
  }

  // stores passing the Line + Slab + text filters
  function filteredStores(weeks) {
    const stats = storeStats(weeks);
    const q  = searchEl.value.trim().toLowerCase();
    const ln = lineSel.value, sb = slabSel.value;
    return ALL_STORES.filter(s => {
      const st = stats[s];
      if (ln && (!st.line || st.line.key !== ln)) return false;
      if (sb && (!st.slab || st.slab.key !== sb)) return false;
      if (q) {
        const city = (STORE_CITY[s] || '').toLowerCase();
        if (!s.toLowerCase().includes(q) && !city.includes(q)) return false;
      }
      return true;
    });
  }

  ALL_WEEKS.forEach(wk => {
    const nd  = WEEK_DAYS[String(wk)];
    const lbl = PARTIAL[String(wk)] ? `Wk${wk} (partial · ${nd}/7d)` : `Wk${wk}`;
    fromSel.insertAdjacentHTML('beforeend', `<option value="${wk}">${lbl}</option>`);
    toSel.insertAdjacentHTML('beforeend',   `<option value="${wk}">${lbl}</option>`);
  });
  if (ALL_WEEKS.length) {
    // Default to the last 4 *complete* weeks — ending on a 2-day partial week would
    // make the headline counts look like a collapse rather than a short week.
    const complete = ALL_WEEKS.filter(w => !PARTIAL[String(w)]);
    const pool     = complete.length ? complete : ALL_WEEKS;
    fromSel.value  = pool[Math.max(0, pool.length - 4)];
    toSel.value    = pool[pool.length - 1];
  }

  function filteredWeeks() {
    if (GLOBAL_MONTH === 'all') return ALL_WEEKS;
    if (!fromSel.value || !toSel.value) return ALL_WEEKS;
    const lo = Math.min(parseInt(fromSel.value), parseInt(toSel.value));
    const hi = Math.max(parseInt(fromSel.value), parseInt(toSel.value));
    return ALL_WEEKS.filter(w => w >= lo && w <= hi);
  }

  function syncComboText() {
    if (selectedStore) {
      const st = (statsCache.map || {})[selectedStore];
      const pct = st && st.pct != null ? st.pct.toFixed(2) + '%' : '—';
      comboIn.value = `${selectedStore} — ${STORE_CITY[selectedStore] || '—'} · ${pct}`;
      comboClr.style.display = 'block';
    } else {
      comboIn.value = '';
      comboClr.style.display = 'none';
    }
  }

  const COMBO_MAX = 400;   // cap rendered rows; typing narrows further

  function renderCombo() {
    const weeks = filteredWeeks();
    const stats = storeStats(weeks);
    const list  = filteredStores(weeks);
    let h = `<div class="qnp-opt" data-store="" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);color:var(--muted)">— overall (all stores) —</div>`;
    list.slice(0, COMBO_MAX).forEach(s => {
      const st = stats[s], L = st.line;
      h += `<div class="qnp-opt" data-store="${s}" style="padding:7px 12px;cursor:pointer;display:flex;gap:10px;align-items:center;justify-content:space-between">
        <span><b>${s}</b> <span style="color:var(--muted)">${STORE_CITY[s] || '—'}</span></span>
        <span style="white-space:nowrap">${st.pct == null ? '—' : st.pct.toFixed(2) + '%'}
          ${L ? `<span class="tier-pill" style="background:${L.bg};color:${L.fg};margin-left:6px">${L.key}</span>` : ''}</span>
      </div>`;
    });
    if (!list.length) {
      h += `<div style="padding:10px 12px;color:var(--muted)">No store matches this search / filter</div>`;
    } else if (list.length > COMBO_MAX) {
      h += `<div style="padding:8px 12px;color:var(--muted);font-size:12px;border-top:1px solid var(--border)">showing first ${COMBO_MAX} of ${list.length} — keep typing to narrow</div>`;
    }
    comboDrop.innerHTML = h;
    comboDrop.querySelectorAll('.qnp-opt').forEach(el => {
      // mousedown, not click: it fires before the input's blur closes the dropdown
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        storeSel.value = el.dataset.store || '';   // setter also clears any drilled item
        comboQuery = '';
        closeCombo();
        renderAll();
      });
      el.addEventListener('mouseenter', () => { el.style.background = 'var(--surface2)'; });
      el.addEventListener('mouseleave', () => { el.style.background = ''; });
    });
  }

  function openCombo()  { renderCombo(); comboDrop.style.display = 'block'; }
  function closeCombo() { comboDrop.style.display = 'none'; }

  // Called whenever the Line/Slab/week filters change: drop a selected store that no
  // longer passes them rather than showing a store outside the active filter.
  function refreshStoreOptions() {
    const weeks = filteredWeeks();
    const savedQuery = comboQuery;
    comboQuery = '';                                  // validate against filters only
    const allowed = new Set(filteredStores(weeks));
    comboQuery = savedQuery;
    if (selectedStore && !allowed.has(selectedStore)) storeSel.value = '';
    syncComboText();
    if (comboDrop.style.display === 'block') renderCombo();
  }

  // Canonical store-level total/igcc, summed over a set of stores + weeks (source of truth).
  function aggStoreLevel(stores, weeks) {
    let total = 0, igcc = 0;
    stores.forEach(s => {
      const sw = STORE_WEEK[s];
      if (!sw) return;
      weeks.forEach(wk => {
        const rec = sw[String(wk)];
        if (!rec) return;
        total += rec[0] || 0;
        igcc  += rec[1] || 0;
      });
    });
    return { total, igcc, pct: total ? igcc / total * 100 : 0 };
  }

  // Item-level rows for one store across the selected weeks — its own metric, not forced to reconcile to the store total.
  function storeItemRows(store, weeks) {
    const agg = {};
    const swi = STORE_WEEK_ITEM[store];
    if (!swi) return [];
    weeks.forEach(wk => {
      const items = swi[String(wk)];
      if (!items) return;
      for (const code in items) {
        const [total, igcc] = items[code];
        if (!agg[code]) agg[code] = [0, 0];
        agg[code][0] += total || 0;
        agg[code][1] += igcc || 0;
      }
    });
    return Object.keys(agg)
      .map(code => {
        const [total, igcc] = agg[code];
        return { code, name: ITEM_NAMES[code] || code, total, igcc, pct: total ? igcc / total * 100 : 0 };
      })
      .sort((a, b) => b.igcc - a.igcc);
  }

  function renderOverall(weeks) {
    const stats = storeStats(weeks);
    const shown = filteredStores(weeks);
    const agg   = aggStoreLevel(shown, weeks);
    const scoped = !!(lineSel.value || slabSel.value || searchEl.value.trim());

    kpiRow.innerHTML = kpiHTML('Stores', shown.length.toLocaleString(),
                               scoped ? `of ${ALL_STORES.length} (filtered)` : 'in selected range')
      + kpiHTML('Total F&V Orders', agg.total.toLocaleString(), '')
      + kpiHTML('IGCC Orders', agg.igcc.toLocaleString(), '')
      + kpiHTML('Store-level QnP%', agg.pct.toFixed(2) + '%', 'canonical store metric — source of truth');
    overlapEl.style.display = 'none';
    itemCard.style.display = 'none';
    trdCard.style.display  = 'none';   // store list carries per-store trends already

    // stores with no orders in range can't be classified — count them separately so
    // the Line/slab tables always add up to the store total
    const classifiable = ALL_STORES.filter(s => stats[s].pct != null);
    const unclassified = ALL_STORES.length - classifiable.length;

    // ── Line summary ────────────────────────────────────────────────────────
    let lh = `<table><thead><tr>
      <th>Line</th><th>QnP% range</th><th class="num">Stores</th><th class="num">% of stores</th>
      <th class="num">Orders</th><th class="num">IGCC</th><th class="num">QnP%</th>
    </tr></thead><tbody>`;
    LINES.forEach(L => {
      const mem = classifiable.filter(s => stats[s].line && stats[s].line.key === L.key);
      const a = aggStoreLevel(mem, weeks);
      const share = classifiable.length ? mem.length / classifiable.length * 100 : 0;
      const on = lineSel.value === L.key;
      lh += `<tr style="cursor:pointer${on ? ';background:rgba(88,166,255,.14)' : ''}" data-line="${L.key}">
        <td><span class="tier-pill" style="background:${L.bg};color:${L.fg}">${L.label}</span></td>
        <td style="color:var(--muted)">${L.range}</td>
        <td class="num" style="font-weight:600">${mem.length.toLocaleString()}</td>
        <td class="num">${share.toFixed(1)}%</td>
        <td class="num">${a.total.toLocaleString()}</td>
        <td class="num">${a.igcc.toLocaleString()}</td>
        <td class="num" style="color:${L.fg};font-weight:600">${a.total ? a.pct.toFixed(2) + '%' : '—'}</td>
      </tr>`;
    });
    if (unclassified) {
      lh += `<tr><td colspan="2" style="color:var(--muted)">No orders in range (unclassified)</td>
             <td class="num">${unclassified.toLocaleString()}</td><td colspan="4"></td></tr>`;
    }
    lh += '</tbody></table>';
    lineTbl.innerHTML = lh;
    lineCard.style.display = 'block';
    lineTbl.querySelectorAll('tr[data-line]').forEach(tr => {
      tr.addEventListener('click', () => {
        lineSel.value = (lineSel.value === tr.dataset.line) ? '' : tr.dataset.line;
        slabSel.value = '';
        refreshStoreOptions(); renderAll();
      });
    });

    // ── Slab distribution ───────────────────────────────────────────────────
    let sh = `<table><thead><tr>
      <th>Slab</th><th>Line</th><th class="num">Stores</th><th class="num">% of stores</th>
      <th class="num">Orders</th><th class="num">IGCC</th><th class="num">QnP%</th><th>Share</th>
    </tr></thead><tbody>`;
    const maxN = Math.max(1, ...SLABS.map(s =>
      classifiable.filter(x => stats[x].slab && stats[x].slab.key === s.key).length));
    SLABS.forEach(S => {
      const mem = classifiable.filter(s => stats[s].slab && stats[s].slab.key === S.key);
      const a = aggStoreLevel(mem, weeks);
      const share = classifiable.length ? mem.length / classifiable.length * 100 : 0;
      // a slab sits wholly inside one Line, so colour it by the slab's midpointless
      // upper bound — take the Line of any representative value inside the slab
      const rep = S.hi === Infinity ? S.lo + 0.01 : S.hi;
      const L = lineOf(rep) || LINES[0];
      const on = slabSel.value === S.key;
      sh += `<tr style="cursor:pointer${on ? ';background:rgba(88,166,255,.14)' : ''}" data-slab="${S.key}">
        <td style="font-weight:600">${S.label}</td>
        <td><span class="tier-pill" style="background:${L.bg};color:${L.fg}">${L.key}</span></td>
        <td class="num" style="font-weight:600">${mem.length.toLocaleString()}</td>
        <td class="num">${share.toFixed(1)}%</td>
        <td class="num">${a.total.toLocaleString()}</td>
        <td class="num">${a.igcc.toLocaleString()}</td>
        <td class="num">${a.total ? a.pct.toFixed(2) + '%' : '—'}</td>
        <td><span style="display:inline-block;height:8px;border-radius:4px;background:${L.fg};width:${(mem.length / maxN * 90).toFixed(1)}px"></span></td>
      </tr>`;
    });
    sh += '</tbody></table>';
    slabTbl.innerHTML = sh;
    slabCard.style.display = 'block';
    slabTbl.querySelectorAll('tr[data-slab]').forEach(tr => {
      tr.addEventListener('click', () => {
        slabSel.value = (slabSel.value === tr.dataset.slab) ? '' : tr.dataset.slab;
        lineSel.value = '';
        refreshStoreOptions(); renderAll();
      });
    });

    // ── Store list for the current filter ───────────────────────────────────
    const rows = shown.map(s => ({ s, ...stats[s] }))
                      .sort((a, b) => (b.pct == null ? -1 : b.pct) - (a.pct == null ? -1 : a.pct));
    slTitle.textContent = `Stores — ${rows.length.toLocaleString()}`
      + (lineSel.value ? ` · ${lineSel.value} Line` : '')
      + (slabSel.value ? ` · ${(SLABS.find(x => x.key === slabSel.value) || {}).label}` : '');
    const isAll = GLOBAL_MONTH === 'all';
    const stCols = isAll ? monthsForWeeks(weeks) : weeks.slice(-TREND_N);
    let th = `<table><thead><tr>
      <th>#</th><th>Store</th><th>City</th><th class="num">Orders</th><th class="num">IGCC</th>
      <th class="num">QnP%</th><th>Slab</th><th>Line</th>
      ${isAll ? monthHeadHTML(stCols) : trendHeadHTML(stCols)}
    </tr></thead><tbody>`;
    rows.forEach((r, i) => {
      const series = isAll ? storeMonthlyPctSeries(r.s, stCols) : storePctSeries(r.s, stCols);
      th += `<tr class="qnp-store-row" data-store="${r.s}" style="cursor:pointer">
        <td>${i + 1}</td>
        <td style="font-weight:600">${r.s}</td>
        <td>${STORE_CITY[r.s] || '—'}</td>
        <td class="num">${r.total.toLocaleString()}</td>
        <td class="num">${r.igcc.toLocaleString()}</td>
        <td class="num" style="font-weight:600">${r.pct == null ? '—' : r.pct.toFixed(2) + '%'}</td>
        <td>${r.slab ? r.slab.label : '—'}</td>
        <td>${linePill(r.pct)}</td>
        ${trendCellsHTML(series)}
      </tr>`;
    });
    th += '</tbody></table>';
    slTbl.innerHTML = th;
    slCard.style.display = 'block';
    slTbl.querySelectorAll('tr.qnp-store-row').forEach(tr => {
      tr.addEventListener('click', () => { storeSel.value = tr.dataset.store; renderAll(); });
    });

    const scopeLbl = lineSel.value ? `${lineSel.value} Line`
                   : slabSel.value ? ((SLABS.find(x => x.key === slabSel.value) || {}).label || 'slab')
                   : 'all stores';
    renderReasons(shown, scopeLbl);

    countEl.textContent = `${shown.length} stores`
      + (scoped ? ` of ${ALL_STORES.length}` : '');
  }

  function renderStore(store, weeks) {
    const st = aggStoreLevel([store], weeks);
    const items = storeItemRows(store, weeks);
    const itemIgccSum = items.reduce((s, r) => s + r.igcc, 0);
    const gap = itemIgccSum - st.igcc;
    const gapPct = st.igcc ? (gap / st.igcc * 100) : 0;

    const sPct  = st.total ? round2(st.pct) : null;
    const sSlab = slabOf(sPct);
    const sLine = lineOf(sPct);

    lineCard.style.display = 'none';
    slabCard.style.display = 'none';
    slCard.style.display   = 'none';
    renderStoreTrend(store, weeks);

    if (selectedQnpItem) {
      const nm = ITEM_NAMES[selectedQnpItem] || (RCA_SI.names || {})[selectedQnpItem] || selectedQnpItem;
      renderReasonsFrom(rcaItemReasonRows(store, selectedQnpItem, weeks),
                        `store ${store} · ${nm} (${selectedQnpItem})`,
                        '— click the item row again to go back to the whole store');
    } else {
      renderReasons([store], `store ${store}`);
    }

    kpiRow.innerHTML = kpiHTML('Store', `${store} (${STORE_CITY[store] || '—'})`, '')
      + kpiHTML('Total F&V Orders', st.total.toLocaleString(), '')
      + kpiHTML('IGCC Orders', st.igcc.toLocaleString(), '')
      + kpiHTML('Store-level QnP%', st.pct.toFixed(2) + '%', 'canonical store metric — source of truth')
      + kpiHTML('Slab', sSlab ? sSlab.label : '—',
                sLine ? `${sLine.label} · ${sLine.range}` : 'no orders in range');

    overlapEl.style.display = 'block';
    overlapEl.innerHTML = `<b>Note:</b> the store-level IGCC count above (${st.igcc.toLocaleString()}) is the authoritative number for this store. ` +
      `Summed across the items below, IGCC orders total ${itemIgccSum.toLocaleString()}` +
      (gap > 0
        ? ` — ${gap.toLocaleString()} (${gapPct.toFixed(1)}%) higher than the store total, because a single complaint can be flagged against more than one item and is then counted once per item.`
        : gap < 0
          ? ` — ${Math.abs(gap).toLocaleString()} lower than the store total, since some flagged complaints could not be matched to a specific item.`
          : ` — matches the store total exactly for this selection.`);

    itemCard.style.display = 'block';
    itemTitle.textContent = !weeks.length ? `${store} — Item × Week breakdown`
      : GLOBAL_MONTH === 'all' ? `${store} — Item × Month breakdown (All Months)`
      : `${store} — Item × Week breakdown (Wk${Math.min(...weeks)}–Wk${Math.max(...weeks)})`;

    let html;
    if (!items.length) {
      html = '<div style="color:var(--muted);font-size:13px;padding:8px 0">No item-level rows for this store in the selected week range.</div>';
    } else {
      const isAll = GLOBAL_MONTH === 'all';
      const tw = isAll ? monthsForWeeks(weeks) : weeks.slice(-TREND_N);
      const B  = RCA_SI.buckets || [];
      html = `<table><thead><tr>
        <th>#</th><th>Item</th><th>Item Code</th><th>Orders</th><th>IGCC</th><th>Item QnP%</th>
        ${isAll ? monthHeadHTML(tw) : trendHeadHTML(tw)}
        <th class="num" style="border-left:1px solid var(--border)">RCA</th>
        ${B.map(b => `<th class="num" style="min-width:52px" title="RCA bucket: ${b}">${b}</th>`).join('')}
        <th>Top bucket</th>
      </tr></thead><tbody>`;
      items.forEach((r, i) => {
        const sel = r.code === selectedQnpItem;
        const getter = wk => {
          const swi = STORE_WEEK_ITEM[store];
          if (!swi) return null;
          const wkd = swi[String(wk)];
          const rec = wkd ? wkd[r.code] : null;
          // store_week_item is [orders, igcc]; pctSeries/monthlyPctSeries want [igcc, orders]
          return rec ? [rec[1], rec[0]] : null;
        };
        const series = isAll ? monthlyPctSeries(tw, getter) : pctSeries(tw, getter);
        const bk    = rcaBuckets(store, weeks, r.code);
        const bkTot = bk.reduce((a, b) => a + b, 0);
        let topIdx = -1, topVal = 0;
        bk.forEach((v, k) => { if (v > topVal) { topVal = v; topIdx = k; } });
        const topLbl = topIdx >= 0
          ? `<span class="tier-pill" style="background:${SPOC_BG[B[topIdx]] || 'rgba(139,148,158,.12)'};color:${SPOC_FG[B[topIdx]] || 'var(--muted)'}">${B[topIdx]} ${(topVal / bkTot * 100).toFixed(0)}%</span>`
          : '<span style="color:var(--muted)">—</span>';
        html += `<tr class="qnp-item-row" data-code="${r.code}" title="Click for this item's RCA reason breakdown"
                     style="cursor:pointer${sel ? ';background:rgba(88,166,255,.18)' : ''}">
          <td>${i + 1}</td>
          <td>${r.name}</td>
          <td>${r.code}</td>
          <td>${r.total.toLocaleString()}</td>
          <td>${r.igcc.toLocaleString()}</td>
          <td>${r.pct.toFixed(2)}%</td>
          ${trendCellsHTML(series)}
          <td class="num" style="border-left:1px solid var(--border);font-weight:600">${bkTot ? bkTot.toLocaleString() : '<span style="color:var(--muted)">—</span>'}</td>
          ${bk.map(v => `<td class="num">${v ? v.toLocaleString() : '<span style="color:var(--muted)">·</span>'}</td>`).join('')}
          <td>${topLbl}</td>
        </tr>`;
      });
      html += '</tbody></table>';
    }
    itemTbl.innerHTML = html;
    countEl.textContent = `${items.length} items · store ${store}`;

    // Clicking an item name drills the reason breakdown down to that item; clicking the
    // same row again returns the breakdown to the whole store.
    if (selectedQnpItem && !items.some(r => r.code === selectedQnpItem)) selectedQnpItem = null;
    itemTbl.querySelectorAll('tr.qnp-item-row').forEach(tr => {
      tr.addEventListener('click', () => {
        selectedQnpItem = (selectedQnpItem === tr.dataset.code) ? null : tr.dataset.code;
        renderAll();
        // guarded: scrollIntoView is missing in some environments, and an exception
        // here would fire after the render and surface as an uncaught error
        if (typeof rsnCard.scrollIntoView === 'function') {
          rsnCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
    });

    // RCA is a separate, manually-tagged source from the QnP IGCC column, and some
    // tagged complaints sit on item codes outside the F&V order set — say so rather
    // than letting the two columns look like they should tie out.
    const rcaTotal   = rcaStoreTotal(store, weeks);
    const rcaOnItems = items.reduce((s, r) => s + rcaBuckets(store, weeks, r.code).reduce((a, b) => a + b, 0), 0);
    const rcaOutside = rcaTotal - rcaOnItems;
    if (rcaTotal) {
      overlapEl.innerHTML += `<br><br><b>RCA buckets:</b> ${rcaTotal.toLocaleString()} RCA-tagged complaints for this store in range, `
        + `split across CX / Pod / Sourcing / WH. This is a <i>different source</i> from the IGCC column `
        + `(${st.igcc.toLocaleString()}) — RCA covers only complaints that were manually reason-tagged, so the two do not tie out.`
        + (rcaOutside > 0
            ? ` ${rcaOutside.toLocaleString()} of them sit on item codes with no F&V order row and so aren't in the table above.`
            : '');
    }
  }

  // Week-by-week QnP% for one store: every selected week with its own orders, IGCC,
  // QnP%, WoW delta and the slab/Line it fell into that week.
  function renderStoreTrend(store, weeks) {
    const byWk = STORE_WEEK[store] || {};
    if (GLOBAL_MONTH === 'all') {
      const months = monthsForWeeks(weeks);
      const series = storeMonthlyPctSeries(store, months);
      trdTitle.textContent = `Store ${store} — QnP% month on month`;
      let mh = `<table><thead><tr>
        <th>Month</th><th class="num">Weeks</th><th class="num">Orders</th><th class="num">IGCC</th>
        <th class="num">QnP%</th><th class="num">MoM Δ</th><th>Slab</th><th>Line</th>
      </tr></thead><tbody>`;
      let mprev = null;
      months.forEach((m, i) => {
        let orders = 0, igcc = 0, nwk = 0;
        (MONTH_WKS[m] || []).forEach(wk => {
          const rec = byWk[String(wk)];
          if (rec) { orders += rec[0] || 0; igcc += rec[1] || 0; nwk++; }
        });
        const p2 = round2(series[i]);
        const d  = (series[i] != null && mprev != null) ? series[i] - mprev : null;
        const sl = p2 == null ? null : slabOf(p2);
        mh += `<tr>
          <td style="font-weight:600">${m}</td>
          <td class="num">${nwk || '—'}</td>
          <td class="num">${orders.toLocaleString()}</td>
          <td class="num">${igcc.toLocaleString()}</td>
          <td class="num" style="font-weight:600">${p2 == null ? '—' : p2.toFixed(2) + '%'}</td>
          <td class="num">${wowPPBadge(d == null ? null : { delta: d })}</td>
          <td>${sl ? sl.label : '—'}</td>
          <td>${linePill(p2)}</td>
        </tr>`;
        if (series[i] != null) mprev = series[i];
      });
      mh += `</tbody></table>
        <div style="margin-top:12px;display:flex;align-items:center;gap:12px;color:var(--muted);font-size:12px">
          <span>Trend</span>${sparkSVG(series, 240, 34)}
          <span>${wowPPBadge(wowFromSeries(series))} latest vs previous month</span>
        </div>`;
      trdTbl.innerHTML = mh;
      trdCard.style.display = 'block';
      return;
    }
    const series = storePctSeries(store, weeks);
    trdTitle.textContent = `Store ${store} — QnP% week on week`;
    let h = `<table><thead><tr>
      <th>Week</th><th class="num">Days</th><th class="num">Orders</th><th class="num">IGCC</th>
      <th class="num">QnP%</th><th class="num">WoW Δ</th><th>Slab</th><th>Line</th>
    </tr></thead><tbody>`;
    let prev = null;
    weeks.forEach((wk, i) => {
      const rec    = byWk[String(wk)];
      const orders = rec ? rec[0] : 0;
      const igcc   = rec ? rec[1] : 0;
      const p2     = round2(series[i]);
      const d      = (series[i] != null && prev != null) ? series[i] - prev : null;
      const nd     = WEEK_DAYS[String(wk)];
      const sl     = p2 == null ? null : slabOf(p2);
      h += `<tr>
        <td style="font-weight:600">Wk${wk}${PARTIAL[String(wk)] ? ' <span style="color:var(--muted);font-size:11px">partial</span>' : ''}</td>
        <td class="num">${nd == null ? '—' : nd + '/7'}</td>
        <td class="num">${orders.toLocaleString()}</td>
        <td class="num">${igcc.toLocaleString()}</td>
        <td class="num" style="font-weight:600">${p2 == null ? '—' : p2.toFixed(2) + '%'}</td>
        <td class="num">${wowPPBadge(d == null ? null : { delta: d })}</td>
        <td>${sl ? sl.label : '—'}</td>
        <td>${linePill(p2)}</td>
      </tr>`;
      if (series[i] != null) prev = series[i];
    });
    h += `</tbody></table>
      <div style="margin-top:12px;display:flex;align-items:center;gap:12px;color:var(--muted);font-size:12px">
        <span>Trend</span>${sparkSVG(series, 240, 34)}
        <span>${wowPPBadge(wowFromSeries(series))} latest vs previous week</span>
      </div>`;
    trdTbl.innerHTML = h;
    trdCard.style.display = 'block';
  }

  // Reason breakdown for the current scope: count + share of RCA-tagged complaints,
  // biggest first, each tagged with the SPOC bucket that owns it.
  function renderReasons(storeList, scopeLabel) {
    renderReasonsFrom(rcaReasonRows(storeList, filteredWeeks()), scopeLabel, '');
  }

  function renderReasonsFrom(result, scopeLabel, hint) {
    const { total, rows } = result;
    if (!total) {
      if (hint) {
        rsnTitle.textContent = `RCA reason breakdown — ${scopeLabel}`;
        rsnTbl.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px 0">`
          + `No RCA-tagged complaints for this selection. ${hint}</div>`;
        rsnCard.style.display = 'block';
      } else {
        rsnCard.style.display = 'none';
      }
      return;
    }
    rsnTitle.textContent = `RCA reason breakdown — ${scopeLabel} · ${total.toLocaleString()} tagged complaints`
      + (hint ? `  ${hint}` : '');
    const max = rows[0].igcc || 1;
    let h = `<table><thead><tr>
      <th>#</th><th>Basic Reason for IGCC</th><th>SPOC</th>
      <th class="num">IGCC</th><th class="num">Share</th><th style="width:200px">&nbsp;</th>
    </tr></thead><tbody>`;
    rows.forEach((r, i) => {
      const fg = SPOC_FG[r.spoc] || 'var(--muted)';
      const bg = SPOC_BG[r.spoc] || 'rgba(139,148,158,.12)';
      h += `<tr>
        <td>${i + 1}</td>
        <td style="font-weight:600">${r.reason}</td>
        <td><span class="tier-pill" style="background:${bg};color:${fg}">${r.spoc}</span></td>
        <td class="num" style="font-weight:600">${r.igcc.toLocaleString()}</td>
        <td class="num">${r.share.toFixed(1)}%</td>
        <td><span style="display:inline-block;height:8px;border-radius:4px;background:${fg};width:${(r.igcc / max * 190).toFixed(1)}px"></span></td>
      </tr>`;
    });
    h += `</tbody><tfoot><tr style="border-top:2px solid var(--border)">
      <td></td><td style="font-weight:700">Total</td><td></td>
      <td class="num" style="font-weight:700">${total.toLocaleString()}</td>
      <td class="num" style="font-weight:700">100.0%</td><td></td>
    </tr></tfoot></table>`;
    rsnTbl.innerHTML = h;
    rsnCard.style.display = 'block';
  }

  function renderAll() {
    const weeks = filteredWeeks();
    const store = storeSel.value;
    fromSel.disabled = toSel.disabled = (GLOBAL_MONTH === 'all');
    if (!weeks.length) {
      kpiRow.innerHTML = '';
      overlapEl.style.display = 'none';
      itemCard.style.display = 'none';
      countEl.textContent = '';
      return;
    }
    if (store) renderStore(store, weeks);
    else renderOverall(weeks);

    if (Q.day_from && Q.day_to) {
      countEl.textContent += ` · ${Q.day_from} → ${Q.day_to}`;
    }

    // Flag only the partial weeks actually inside the current selection — their
    // order/IGCC counts are not comparable to full weeks (QnP% still is).
    const selPartial = weeks.filter(w => PARTIAL[String(w)]);
    if (selPartial.length) {
      covEl.style.display = 'block';
      covEl.innerHTML = '<b>Partial weeks in this selection:</b> ' +
        selPartial.map(w => `Wk${w} (${PARTIAL[String(w)]} of 7 days)`).join(', ') +
        '. Order and IGCC <i>counts</i> for those weeks are lower simply because fewer days are covered — ' +
        'compare QnP% rather than absolute counts, or exclude them from the range above. ' +
        `Item-level data currently spans ${Q.day_from} → ${Q.day_to} (${Q.n_days} days).`;
    } else {
      covEl.style.display = 'none';
    }
  }

  refreshStoreOptions();

  comboIn.addEventListener('focus', () => { comboQuery = ''; comboIn.value = ''; openCombo(); });
  comboIn.addEventListener('input', () => { comboQuery = comboIn.value.trim(); openCombo(); });
  comboIn.addEventListener('blur', () => {
    // small delay so a click on an option still registers
    setTimeout(() => { closeCombo(); comboQuery = ''; syncComboText(); }, 150);
  });
  comboIn.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeCombo(); comboIn.blur(); }
    if (e.key === 'Enter') {
      const first = [...comboDrop.querySelectorAll('.qnp-opt')].find(el => el.dataset.store);
      if (first) {
        storeSel.value = first.dataset.store;
        comboQuery = ''; closeCombo(); renderAll(); comboIn.blur();
      }
    }
  });
  comboClr.addEventListener('mousedown', e => {
    e.preventDefault();
    storeSel.value = ''; comboQuery = '';
    closeCombo(); renderAll();
  });

  lineSel.addEventListener('change', () => { slabSel.value = ''; refreshStoreOptions(); renderAll(); });
  slabSel.addEventListener('change', () => { lineSel.value = ''; refreshStoreOptions(); renderAll(); });
  // Slabs are relative to the selected weeks, so the per-store stats must be
  // recomputed (not reused) whenever the range changes.
  const onWeeks = () => { statsCache = { key: null, map: null }; refreshStoreOptions(); renderAll(); };
  fromSel.addEventListener('change', onWeeks);
  toSel.addEventListener('change', onWeeks);

  registerWeekRangeTab('qnp', 'qnp-wk-from', 'qnp-wk-to', ALL_WEEKS);
  applyGlobalMonthToWeekTab('qnp');
  renderAll();
}
