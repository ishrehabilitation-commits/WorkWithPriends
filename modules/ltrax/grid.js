/**
 * WellSky patient grid (HOHSRCH): finds each LTRAX patient's WellSky account number.
 * LTRAX has no shared ID, so patients are matched on name + admit date. If two patients
 * share both, the first grid row wins (rare at our size).
 */
import { toYmd } from './fields.js';

export const GRID_URL = '/Interactant/get/HOHSRCH';

// WellSky level-6 codes (REQLVL6 on the grid, ILEVELCODE on the form report).
export const FACILITIES = { 202: 'Pierremont', 203: 'Bossier City', 204: 'Shreveport' };

// Copied from the grid request; USERID, REQUSER and PASSWD are filled in inside the WellSky tab.
export function buildGridRequest(facility) {
  return {
    name: 'HOHSRCH',
    timeout: 90000,
    data: {
      USERID: null, PASSWD: null, REQUSER: null,
      REQSEARCHTYPE: 'C', REQLVL6: Number(facility),
      REQALERT: '', REQSEVR: '', REQCLASS: '', REQVIEW: 'H', REQSEARCHBY: 'A',
      REQNSTN: 0, REQMEDCART: 0, REQNAME: '', REQACCT: '', REQMRNO: '',
      REQDISCH: 'Y', REQDISCHDAY: 7, // in-house plus anyone discharged in the last 7 days
      REQACTIVE: 'Y', REQPREADMIT: 'N', REQINHOUSE: 'Y', REQOUTPATIENT: 'N',
      REQPHYTYPE: 'A', INCLUDEPHOTO: 'N',
    },
  };
}

// "DOE, JOHN A" / "Doe, John" / "DOE JR, JOHN" / "John Doe" -> "DOE|JOHN".
// LTRAX only shows the first given name, so middle names are dropped on both sides.
const SUFFIX = /\s+(JR|SR|II|III|IV)$/;
export function nameKey(name) {
  const t = String(name || '').toUpperCase().replace(/[^A-Z, ]/g, '').replace(/\s+/g, ' ').trim();
  if (t.includes(',')) {
    const [last, rest] = t.split(',', 2);
    return `${last.trim().replace(SUFFIX, '').replace(/ /g, '')}|${rest.trim().split(' ')[0] || ''}`;
  }
  const parts = t.split(/\s+/);
  return `${parts.at(-1)}|${parts.length > 1 ? parts[0] : ''}`;
}

export const patientKey = (name, admitYmd) => `${nameKey(name)}|${admitYmd}`;

// Grid columns seen live 2026-10-26: GRIDNAME, GRIDADMIT, GRIDACCT (plus GRIDMRNO, GRIDDISCHG, ...).
// The other patterns are fallbacks in case WellSky renames them.
const pickKey = (keys, ...res) => {
  for (const re of res) { const k = keys.find(x => re.test(x)); if (k) return k; }
  return null;
};

// Returns { rows: [{ name, admit: 'YYYYMMDD', account }], error? }.
export function parseGrid(json) {
  const list = Array.isArray(json?.ORESULTS) ? json.ORESULTS
    : Object.values(json || {}).find(v => Array.isArray(v) && v.length && typeof v[0] === 'object');
  if (!list?.length) return { rows: [], error: 'WellSky grid came back empty for this facility.' };
  const keys = Object.keys(list[0]);
  const k = {
    name: pickKey(keys, /^GRIDNAME$/i, /^(PAT|PT)?NAME$/i, /^(PAT|PT).*NAME$/i),
    last: pickKey(keys, /^(PAT|PT)?LAST(NAME)?$/i, /LNAME/i),
    first: pickKey(keys, /^(PAT|PT)?FIRST(NAME)?$/i, /FNAME/i),
    admit: pickKey(keys, /^GRIDADMIT$/i, /^ADM(IT)?(DATE|DT)$/i, /ADM.*(DATE|DT)/i),
    account: pickKey(keys, /^GRIDACCT$/i, /^ACC(T|OUNT)?(NO|NUM)?$/i, /ACCT|ACCOUNT/i),
  };
  if (!(k.name || k.last) || !k.admit || !k.account) {
    // Only the column names go in the message, never patient values.
    return { rows: [], error: `Couldn't find name/admit date/account in the WellSky grid. Columns: ${keys.join(', ')}` };
  }
  const rows = list.map(r => ({
    name: k.name ? r[k.name] : `${r[k.last]}, ${r[k.first] ?? ''}`,
    admit: toYmd(r[k.admit]),
    account: String(r[k.account] ?? '').trim(),
  }));
  const good = rows.filter(r => r.account && r.admit);
  if (rows.length && !good.length) {
    return { rows: [], error: `WellSky grid admit dates (${k.admit}) are in a format this version can't read.` };
  }
  return { rows: good };
}

// First grid row with the same name and admit date, or null.
export function matchPatient(gridRows, name, admitYmd) {
  const key = patientKey(name, admitYmd);
  return gridRows.find(r => patientKey(r.name, r.admit) === key) ?? null;
}
