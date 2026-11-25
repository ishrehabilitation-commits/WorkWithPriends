/* WorkWithPriends – Census tab: concerning orders in the last 48 hours.
 * HOHLOAC lists a patient's orders (with history), one LOACDATA entry each.
 * We match ORDERPROCDESC (the order's name, not the free-text description,
 * which says things like "intravenously") against the watch list below.
 * Pure functions only (no chrome.* calls) so it can be tested in Node. */
(function (root) {
  'use strict';

  const ORDERS_URL = '/Interactant/get/HOHLOAC';
  const WINDOW_HOURS = 48;

  const WATCH = [
    { key: 'xray', label: 'X-ray', re: /\bX-?\s?RAY\b/i },
    { key: 'abg', label: 'ABG', re: /Arterial\s+Blood\s+Gas/i },
    { key: 'restraint', label: 'Restraints', re: /Q2H\s+Restraint\s+Check|Restraint\s+Placement/i },
    { key: 'dvt', label: 'Venous doppler', re: /VENOUS\s+(UPPER|LOWER)/i },
  ];

  function buildOrdersBody({ userId, token, facility, account }) {
    return JSON.stringify({
      name: 'HOHLOAC', timeout: 90000,
      data: {
        USERID: userId, PASSWD: token, PTLVL6: Number(facility), PTACCN: Number(account),
        REQTYPE: 'ALL', REQINCPRN: 'B', REQORDER: '', REQINDEX: '', REQDIAG: '', REQPHYS: '',
        REQFSH: '', REQRXORDTYPE: '', REQDESC: '', REQHISTORY: 'Y',
      },
    });
  }

  function parseOrders(text) {
    const j = typeof text === 'string' ? JSON.parse(text) : text;
    if (j.RTRNCD) throw new Error('HOHLOAC error: ' + j.RTRNCD);
    const r = j.LOACDATA;
    return !r ? [] : Array.isArray(r) ? r : [r];
  }

  function when(date, time) {
    const n = Number(date), t = Number(time) || 0;
    if (!n) return null;
    return new Date(Math.floor(n / 10000), Math.floor(n / 100) % 100 - 1, n % 100, Math.floor(t / 100), t % 100);
  }
  const pad = n => String(n).padStart(2, '0');
  const stamp = d => `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const strip = s => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

  /** Orders placed in the last 48 h that match the watch list, newest first. */
  function evaluate(orders, now = new Date()) {
    const since = new Date(now.getTime() - WINDOW_HOURS * 3600 * 1000);
    const out = [];
    for (const o of orders) {
      const name = strip(o.ORDERPROCDESC);
      const w = WATCH.find(x => x.re.test(name));
      if (!w) continue;
      const at = when(o.ORDERDATE, o.ORDERTIME);
      if (!at || at < since || at > now) continue;
      const status = strip(o.STATUS);
      out.push({
        key: w.key, label: w.label, name, at, stamp: stamp(at), status,
        stopped: /^discontinued/i.test(status), detail: strip(o.DESCRIPTION), by: strip(o.CLINICIAN),
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  const csvText = list => list.map(o => `${o.name} (${o.stamp}${o.status ? ', ' + o.status : ''})`).join('; ');

  const api = { ORDERS_URL, WINDOW_HOURS, WATCH, buildOrdersBody, parseOrders, evaluate, csvText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WWPConcernOrders = api;
})(typeof self !== 'undefined' ? self : this);
