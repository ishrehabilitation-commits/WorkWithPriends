/* WorkWithPriends – Census tab: critical lab values.
 * Per patient: HOHLABCAT gives the lab categories, then HOHLRSLT with those
 * categories gives a table. Its header row (TABLECOL1 "Laboratory Results")
 * holds the result dates in TABLECOL2..TABLECOL{TABLECOLS}; every later row is
 * one lab, matched by its TABLECOL1 name, with values in the same columns.
 * Pure functions only (no chrome.* calls) so it can be tested in Node. */
(function (root) {
  'use strict';

  const CATEGORIES_URL = '/Interactant/get/HOHLABCAT';
  const RESULTS_URL = '/Interactant/get/HOHLRSLT';
  const MAX_COLS = 51; // WellSky returns at most 51 columns (name + 50 dates)

  /* ---------- requests ---------- */
  const num = v => (v === '' || v == null || isNaN(Number(v)) ? '' : Number(v));

  function buildCategoriesBody({ userId, token, facility, account, mrn }) {
    return JSON.stringify({
      name: 'HOHLABCAT', timeout: 90000,
      data: { USERID: userId, PASSWD: token, REQLV6: Number(facility), REQACC: num(account), REQMRN: num(mrn) },
    });
  }

  function buildResultsBody({ userId, token, facility, account, mrn, categories, from, to }) {
    return JSON.stringify({
      name: 'HOHLRSLT', timeout: 90000,
      data: {
        USERID: userId, PASSWD: token, REQLV6: Number(facility), REQACC: num(account), REQMRN: num(mrn),
        REQCAT: categories, REQTYPE: 'T', REQFDT: String(from), REQTDT: String(to), REQSTART: 1, REQREFRNG: '',
      },
    });
  }

  const asArray = r => (!r ? [] : Array.isArray(r) ? r : [r]);
  const parseJson = t => (typeof t === 'string' ? JSON.parse(t) : t);

  function parseCategories(text) {
    const j = parseJson(text);
    if (j.RTRNCD) throw new Error('HOHLABCAT error: ' + j.RTRNCD);
    return asArray(j.CATINFO).map(c => String(c.CATDESC || '').trim()).filter(Boolean);
  }

  /* ---------- values ---------- */
  // "135&nbsp; L" -> "135"; "Negative&nbsp;" -> "Negative"; "7.2&nbsp; * H" -> "7.2"
  function cleanText(v) {
    return String(v ?? '').split(/&nbsp;?| /i)[0].replace(/<[^>]*>/g, '').trim();
  }
  function cleanNumber(v) {
    const m = cleanText(v).replace(/,/g, '').match(/^[<>]?=?\s*(-?\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : null;
  }
  // "11/24/2026 05:45" -> "11/24"
  const mmdd = s => (String(s || '').match(/^(\d{1,2}\/\d{1,2})/) || [, ''])[1];
  const sortKey = s => {
    const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(\d{1,2})?:?(\d{2})?/);
    return m ? +m[3] * 1e8 + +m[1] * 1e6 + +m[2] * 1e4 + +(m[4] || 0) * 100 + +(m[5] || 0) : 0;
  };
  const normName = s => cleanText(s).toLowerCase().replace(/[:\s]+$/, '').replace(/\s+/g, ' ');

  /**
   * HOHLRSLT reply -> { dates: [{ col, date, mmdd }], labs: Map(normName -> { name, values: [{ col, date, mmdd, raw, text, value }] }) }
   * Values are newest first (the order WellSky gives the columns).
   */
  function parseResults(text) {
    const j = parseJson(text);
    if (j.RTRNCD) throw new Error('HOHLRSLT error: ' + j.RTRNCD);
    const rows = asArray(j.TABLEINFO);
    const hi = rows.findIndex(r => normName(r.TABLECOL1) === 'laboratory results');
    const dates = [], labs = new Map();
    if (hi < 0) return { dates, labs };
    const cols = Math.min(MAX_COLS, Number(j.TABLECOLS) || MAX_COLS);
    const head = rows[hi];
    for (let c = 2; c <= cols; c++) {
      const d = String(head['TABLECOL' + c] || '').trim();
      if (!d) { if (!j.TABLECOLS) break; continue; }
      dates.push({ col: c, date: d, mmdd: mmdd(d) });
    }
    for (const r of rows.slice(hi + 1)) {
      if (r.TABLELINE && r.TABLELINE !== 'D') continue; // C = category heading
      const name = cleanText(r.TABLECOL1);
      if (!name) continue;
      const values = [];
      for (const d of dates) {
        const raw = r['TABLECOL' + d.col];
        if (raw == null || String(raw).trim() === '') continue;
        values.push({ col: d.col, date: d.date, mmdd: d.mmdd, raw: String(raw), text: cleanText(raw), value: cleanNumber(raw) });
      }
      const key = normName(name);
      if (!labs.has(key)) labs.set(key, { name, values });
    }
    return { dates, labs };
  }

  /* ---------- criteria ----------
   * level: 'hold' = hard therapy hold, 'flag' = needs a look, 'check' = needs vitals to decide.
   * Choices where the reference sheet left room (see README):
   *  - Platelets come back in K/µL (259 = 259,000), so values under 1,000 are scaled by 1,000.
   *  - WBC < 2.5 or > 30 is a hold. WBC < 5.0 alone is 'check' until vitals (fever >= 100.4) are pulled.
   *  - Hgb < 7 is a hold, 7 to < 8 a flag.
   *  - PCO2 > 60 is a hold only with pH < 7.30 in the same draw; without a pH it's a flag.
   *  - Infection tests are positive unless the result says Negative (or Not Detected).
   *    TNP, Cancelled and similar are skipped.
   */
  const NUMERIC = [
    { key: 'hemoglobin', label: 'Hgb', test: v => v < 7 ? ['hold', '< 7'] : v < 8 ? ['flag', '< 8'] : null },
    { key: 'sodium', label: 'Na', test: v => v < 125 ? ['hold', '< 125'] : v > 155 ? ['hold', '> 155'] : null },
    { key: 'potassium', label: 'K', test: v => v <= 3.0 ? ['hold', '≤ 3.0'] : v >= 6.0 ? ['hold', '≥ 6.0'] : null },
    { key: 'white blood cell count', label: 'WBC',
      test: v => v < 2.5 ? ['hold', '< 2.5'] : v > 30 ? ['hold', '> 30'] : v < 5.0 ? ['check', '< 5.0, check for fever'] : null },
    { key: 'platelet count', label: 'Plt', show: v => v < 1000 ? `${v}K` : String(v),
      test: v => { const n = v < 1000 ? v * 1000 : v;
        return n < 5000 ? ['hold', '< 5,000, no ambulation'] : n < 20000 ? ['flag', '< 20,000, room treat, ambulation OK'] : null; } },
    { key: 'glucose', label: 'Glu', test: v => v < 70 ? ['hold', '< 70'] : v > 300 ? ['hold', '> 300'] : null },
    { key: 'abg po2', label: 'PO2', test: v => v < 55 ? ['hold', '< 55'] : null },
  ];
  const INFECTION = [
    { key: 'toxigenic c difficile', label: 'C diff' },
    { key: 'flu a by pcr', label: 'Flu A' },
    { key: 'flu b by pcr', label: 'Flu B' },
    { key: 'sars cov-2 result', label: 'COVID' },
    { key: 'rsv by pcr', label: 'RSV' },
  ];
  const NEGATIVE = /negative|not\s+detected|none\s+detected/i;
  const NOT_RESULTED = /^(tnp|test not performed|cancel+ed|canceled|pending|see (below|note)|x)$/i;

  /**
   * parsed = parseResults(...) -> [{ lab, label, level, reason, value, date, mmdd, latest }]
   * One entry per critical value. latest = it's that lab's most recent result.
   */
  function evaluate(parsed) {
    const { labs } = parsed;
    const out = [];
    const push = (lab, label, v, i, level, reason, display) =>
      out.push({ lab: lab.name, label, level, reason, value: display ?? v.text, date: v.date, mmdd: v.mmdd, latest: i === 0 });

    for (const c of NUMERIC) {
      const lab = labs.get(c.key); if (!lab) continue;
      lab.values.forEach((v, i) => {
        if (v.value == null) return;
        const r = c.test(v.value);
        if (r) push(lab, c.label, v, i, r[0], r[1], c.show ? c.show(v.value) : undefined);
      });
    }

    const pco2 = labs.get('abg pco2'), ph = labs.get('abg ph');
    if (pco2) pco2.values.forEach((v, i) => {
      if (v.value == null || v.value <= 60) return;
      const p = ph?.values.find(x => x.col === v.col && x.value != null);
      if (p && p.value < 7.30) push(pco2, 'PCO2', v, i, 'hold', `> 60 with pH ${p.value}`, `${v.text} / pH ${p.text}`);
      else if (!p) push(pco2, 'PCO2', v, i, 'flag', '> 60, no pH in this draw');
    });

    for (const c of INFECTION) {
      const lab = labs.get(c.key); if (!lab) continue;
      lab.values.forEach((v, i) => {
        if (!v.text || NOT_RESULTED.test(v.text) || NEGATIVE.test(v.text)) return;
        push(lab, c.label, v, i, 'hold', 'positive');
      });
    }

    const rank = { hold: 0, flag: 1, check: 2 };
    return out.sort((a, b) => (b.latest - a.latest) || rank[a.level] - rank[b.level] || sortKey(b.date) - sortKey(a.date));
  }

  /** Short summary for a patient: the newest critical value of each lab. */
  function summarize(flags) {
    const seen = new Set(), list = [];
    for (const f of flags) {
      if (seen.has(f.label)) continue;
      seen.add(f.label); list.push(f);
    }
    const level = list.some(f => f.latest && f.level === 'hold') ? 'hold'
      : list.some(f => f.latest && f.level === 'flag') ? 'flag'
      : list.some(f => f.latest) ? 'check' : list.length ? 'past' : null;
    return { level, list };
  }

  const csvText = flags => summarize(flags).list
    .map(f => `${f.label} ${f.value} (${f.mmdd})${f.latest ? '' : ' earlier'}`).join('; ');

  const api = {
    CATEGORIES_URL, RESULTS_URL, buildCategoriesBody, buildResultsBody, parseCategories, parseResults,
    cleanText, cleanNumber, evaluate, summarize, csvText, NUMERIC, INFECTION,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WWPLabs = api;
})(typeof self !== 'undefined' ? self : this);
