/* WorkWithPriends – Census tab: vitals.
 * HOHSVTSDJ returns JSONDATA as an array of string chunks; joined, they are one
 * JSON object whose `vitals` array holds one entry per charting time (oldest
 * first), each with only the vitals charted then (bp, pulse, oxygen, ...).
 * We keep the latest of each vital and every abnormal reading in the last 24 h.
 * Pure functions only (no chrome.* calls) so it can be tested in Node. */
(function (root) {
  'use strict';

  const VITALS_URL = '/Interactant/get/HOHSVTSDJ';
  const LOOKBACK_DAYS = 7; // how far back to look for a "latest" value

  function buildVitalsBody({ userId, token, facility, account, from, to }) {
    return JSON.stringify({
      name: 'HOHSVTSDJ', timeout: 90000,
      data: {
        USERID: userId, PASSWD: token, REQLV6: Number(facility), REQACC: Number(account),
        REQSDT: String(from), REQEDT: String(to), REQUCL: userId, REQVIEWS: 0, REQTYP: '',
        REQINCMIST: 'Y', REQVSLISTING: 'Y', INCLUDELIMITS: 'N', INCLUDESEQ: 'N', RUNTYP: 'A',
      },
    });
  }

  function parseVitals(text) {
    const j = typeof text === 'string' ? JSON.parse(text) : text;
    if (j.RTRNCD) throw new Error('HOHSVTSDJ error: ' + j.RTRNCD);
    const d = j.JSONDATA;
    const s = Array.isArray(d) ? d.join('') : String(d || '');
    if (!s.trim()) return [];
    const o = JSON.parse(s);
    return Array.isArray(o.vitals) ? o.vitals : [];
  }

  // 20261124 + 905 -> Date(2026-11-24 09:05) in the browser's (facility's) time zone
  function when(date, time) {
    const n = Number(date), t = Number(time) || 0;
    return new Date(Math.floor(n / 10000), Math.floor(n / 100) % 100 - 1, n % 100, Math.floor(t / 100), t % 100);
  }
  const pad = n => String(n).padStart(2, '0');
  const stamp = d => `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const num = v => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));

  /* Each vital: how to read it from an entry, how to show it, and when it's abnormal.
   * Readings flagged as charting mistakes or duplicates (<field>Mistake / <field>Duplicate = Y) are ignored.
   * MAP has no threshold yet, so it's shown but never flagged. */
  const VITALS = [
    { key: 'bp', label: 'BP', field: 'bp',
      read: e => { const m = String(e.bp || '').match(/(\d+)\s*\/\s*(\d+)/); return m ? { sys: +m[1], dia: +m[2] } : null; },
      show: v => `${v.sys}/${v.dia}`,
      test: v => [
        v.sys <= 90 && ['SBP', 'SBP ≤ 90', v.sys], v.sys >= 180 && ['SBP', 'SBP ≥ 180', v.sys],
        v.dia <= 40 && ['DBP', 'DBP ≤ 40', v.dia], v.dia >= 100 && ['DBP', 'DBP ≥ 100', v.dia],
      ].filter(Boolean) },
    { key: 'oxygen', label: 'SpO2', field: 'oxygen', read: e => num(e.oxygenSort), show: v => `${v}%`,
      test: v => v < 90 ? [['SpO2', 'SpO2 < 90%', v]] : [] },
    { key: 'temp', label: 'Temp', field: 'temperature',
      read: e => { const n = num(e.tempSort); return n == null ? null : { n, text: String(e.temperature).replace(/\s*°?\s*F$/i, '') + '°' }; },
      show: v => v.text,
      test: v => v.n >= 100.4 ? [['Temp', 'Temp ≥ 100.4', v.n]] : [] },
    { key: 'pulse', label: 'HR', field: 'pulse', read: e => num(e.pulseSort), show: v => String(v),
      test: v => v <= 50 ? [['HR', 'HR ≤ 50', v]] : v >= 120 ? [['HR', 'HR ≥ 120', v]] : [] },
    // Pain: numeric scale or Wong-Baker faces. "Refused/Unable" (-1) is shown but not flagged.
    { key: 'pain', label: 'Pain', field: 'pain',
      read: e => (e.pain != null ? { n: num(e.painSort), text: String(e.pain) } : e.wong != null ? { n: num(e.wongSort), text: String(e.wong) + ' (Wong)' } : null),
      show: v => v.text,
      test: v => v.n > 0 ? [['Pain', 'Pain reported', v.n]] : [] },
    { key: 'map', label: 'MAP', field: 'mapBP', read: e => num(e.mapBPSort), show: v => String(v), test: () => [] },
    { key: 'glucose', label: 'Glu', field: 'glucose',
      read: e => (e.glucose != null ? { n: num(e.glucSort), text: String(e.glucose).replace(/\s*mg\/dL/i, '') } : null),
      show: v => v.text,
      test: v => v.n == null || v.n < 0 ? [] : v.n < 70 ? [['Glu', 'Glucose < 70', v.n]] : v.n > 300 ? [['Glu', 'Glucose > 300', v.n]] : [] },
  ];
  const bad = (e, f) => e[f + 'Mistake'] === 'Y' || e[f + 'Duplicate'] === 'Y';

  /**
   * entries -> {
   *   latest: { bp: { label, value, at, stamp, abnormal }, ... }   (only vitals that were charted)
   *   abnormal: [{ group, reason, value, display, at, stamp }]     (last 24 h, newest first)
   *   fever24: true | false | null                                  (null = no temperature in 24 h)
   * }
   */
  function evaluate(entries, now = new Date()) {
    const since = new Date(now.getTime() - 24 * 3600 * 1000);
    const latest = {}, abnormal = [];
    let temps24 = 0, fever24 = false;
    const sorted = entries.slice().sort((a, b) => when(a.date, a.time) - when(b.date, b.time));
    for (const e of sorted) {
      const at = when(e.date, e.time);
      for (const v of VITALS) {
        if (bad(e, v.field) || (v.key === 'pain' && e.pain == null && bad(e, 'wong'))) continue;
        const val = v.read(e); if (val == null) continue;
        const hits = v.test(val);
        latest[v.key] = { label: v.label, value: v.show(val), at, stamp: stamp(at), abnormal: hits.map(h => h[1]) };
        if (at >= since && at <= now) {
          if (v.key === 'temp') { temps24++; if (hits.length) fever24 = true; }
          for (const [group, reason, value] of hits) abnormal.push({ group, reason, value, display: v.show(val), at, stamp: stamp(at) });
        }
      }
    }
    abnormal.sort((a, b) => b.at - a.at);
    return { latest, abnormal, fever24: temps24 ? fever24 : null };
  }

  /** Abnormal readings grouped by rule: count, the most extreme value and its time. */
  function groupAbnormal(abnormal) {
    const groups = new Map();
    for (const a of abnormal) {
      const g = groups.get(a.reason) || { reason: a.reason, group: a.group, count: 0, worst: a, items: [] };
      g.count++; g.items.push(a);
      const low = /≤|</.test(a.reason);
      if (low ? a.value < g.worst.value : a.value > g.worst.value) g.worst = a;
      groups.set(a.reason, g);
    }
    return [...groups.values()];
  }

  const ORDER = VITALS.map(v => v.key);
  const latestText = res => ORDER.filter(k => res.latest[k]).map(k => `${res.latest[k].label} ${res.latest[k].value} (${res.latest[k].stamp})`).join('; ');
  const abnormalText = res => groupAbnormal(res.abnormal)
    .map(g => `${g.reason}: ${g.worst.display} at ${g.worst.stamp}${g.count > 1 ? ` (${g.count}x)` : ''}`).join('; ');

  const api = { VITALS_URL, LOOKBACK_DAYS, buildVitalsBody, parseVitals, evaluate, groupAbnormal, latestText, abnormalText, ORDER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WWPVitals = api;
})(typeof self !== 'undefined' ? self : this);
