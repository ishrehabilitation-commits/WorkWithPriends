/**
 * WellSky -> LTRAX Funct tab: request builder + merge rules.
 * Pairs with ltrax-template.js (LTRAX field names).
 *
 * Source: WellSky Form Reporting endpoint HXHFRPT (from your curl).
 * The response parser is still a stub: I haven't seen an HXHFRPT response yet.
 */

// ---------- 1. Request ----------
// Runs inside a WellSky tab (same origin), so the session cookies go along automatically.
// USERID = HCS.userId, PASSWD = HCS.sessionToken (WellSky page globals). Read them at run time
// and never hard-code them. From a content script these globals live in the page's own world,
// so use a script with world:'MAIN' (as your other extensions do) or run the fetch there.
const HXHFRPT_URL = '/Interactant/get/HXHFRPT';

// Admission selects, copied from your curl. E79 = PT eval, E81 = OT eval (I'm assuming
// these from the categories).
const ADMIT_SELECTS = [
  { CODE: 'E79', CAT: 1316 },                                          // Bowel & Bladder
  { CODE: 'E79', CAT: 1024, QUESTORTABLE: 'Q', QUESTTABLENUM: 7292 },  // prior functioning (mobility)
  { CODE: 'E79', CAT: 1024, QUESTORTABLE: 'Q', QUESTTABLENUM: 7497 },  // Prior Device Use [7497]
  { CODE: 'E79', CAT: 1123 },
  { CODE: 'E79', CAT: 1023 },
  { CODE: 'E81', CAT: 1027 },
  { CODE: 'E81', CAT: 1122 },
  { CODE: 'E81', CAT: 1316 },
  { CODE: 'E81', CAT: 743, QUESTORTABLE: 'Q', QUESTTABLENUM: 7497 },
  { CODE: 'E81', CAT: 743, QUESTORTABLE: 'Q', QUESTTABLENUM: 7292 },
];

// Discharge: also pull the daily/weekly notes so the most recent scores are included.
const DISCHARGE_EXTRA_SELECTS = [
  { CODE: 'E50', CAT: 1025 }, // PT Note - LTCH: Mobility
  { CODE: 'E50', CAT: 1126 }, // PT Note - LTCH: PT Weekly Team Conference Note
  { CODE: 'E50', CAT: 1316 }, // PT Note - LTCH: Bowel & Bladder
  { CODE: 'L84', CAT: 1028 }, // OT Note - LTCH: Activities of Daily Living
  { CODE: 'L84', CAT: 1128 }, // OT Note - LTCH: OT Weekly Team Conference Note
  { CODE: 'L84', CAT: 1316 }, // OT Note - LTCH: Bowel & Bladder
];

export function buildRequest({ userId, sessionToken, account, mode, fromDate = 'FIRSTOFMONTH', toDate, facility = 204 }) {
  const base = mode === 'discharge' ? [...ADMIT_SELECTS, ...DISCHARGE_EXTRA_SELECTS] : ADMIT_SELECTS;
  const selects = base.map((s, i) => ({
    ...s, BEGINPARENS: '(', ENDPARENS: ')', ANDOR: i === 0 ? '' : 'O',
  }));
  return {
    name: 'HXHFRPT',
    timeout: 90000,
    data: {
      USERID: userId,
      PASSWD: sessionToken,
      ILEVEL: 6, ILEVELCODE: Number(facility), IFORMAPP: 'EMR',
      IFROMDATE: fromDate, // for long stays, use the admit date (YYYYMMDD) instead of FIRSTOFMONTH
      ITODATE: toDate ?? new Date().toISOString().slice(0, 10).replace(/-/g, ''),
      ISELECTS: selects, INUMSELECTS: selects.length,
      IROLLUP: 'N', DATETYPE: 'A', INURSESTATION: '',
      IACCOUNT: account,
    },
  };
}

export async function fetchForms(opts) {
  const res = await fetch(`${HXHFRPT_URL}?t=${Date.now()}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: '*/*' },
    body: JSON.stringify(buildRequest(opts)),
  });
  return res.json();
}

// ---------- Response format (checked live 2026-10-23) ----------
// { ORESULTS: [ { FORMCODE:'E81', CAT:'1027', QUESTTABLENUM:'7754', RESP:'5',
//                 RESPTEXT:'05. Setup or clean-up ONLY', FORMDATE:'20261014', FORMTIME, FORMSEQ, ACC, ... } ],
//   OQUESTS:[{NUMBER,DESCRIPTION}], OCATS:[...], ONUMRESULTS, ... }
// IMPORTANT: RESP is the option's position in the list, NOT the code. Example: "88. Not attempted..."
// came back with RESP '10'. Always read the code from RESPTEXT.
// Comment questions (e.g. 8631, 8639, 8641, 9368) hold free text, so ignore them.

// WellSky question number -> LTRAX item. The same numbers appear on PT (E79 cat 1023) and OT (E81 cat 1122/1027).
export const QUESTION_MAP = {
  7292: 'GG0100B', // PLOF - Indoor Mobility (Ambulation)   e.g. "8 - Unknown"
  7497: 'GG0110',  // Prior Device Use (multi-select)      e.g. "Manual wheelchair", "Walker", "Other  Unknown"
  7754: 'GG0130A', // Eating
  7755: 'GG0130B', // Oral Hygiene
  7756: 'GG0130C', // Toileting Hygiene
  7734: 'GG0170A', // Roll left and right
  7735: 'GG0170B', // Sit to lying
  7736: 'GG0170C', // Lying to sitting on side of bed
  7737: 'GG0170D', // Sit to stand
  7738: 'GG0170E', // Chair/bed-to-chair transfer
  7761: 'GG0170F', // Toilet Transfer
  7740: 'GG0170I', // Walk 10 feet
  7741: 'GG0170J', // Walk 50 feet with two turns
  7742: 'GG0170K', // Walk 150 feet
  7753: 'GG0170Q', // Does individual use a wheelchair and/or scooter  ("Yes"/"No")
  // The four below only appear when 7753 = Yes in WellSky.
  7748: 'GG0170R',  // Wheel 50 feet with two turns
  7751: 'GG0170RR', // Type of wheelchair/scooter (50 ft)   e.g. "Manual wheelchair or scooter"
  7749: 'GG0170S',  // Wheel 150 feet
  7752: 'GG0170SS', // Type of wheelchair/scooter (150 ft)
  8655: 'H0350',   // Bladder Continence  e.g. "4. Always Incontinent"
  7140: 'H0400',   // Bowel Continence    e.g. "Always continent" (no number, so map by text)

  // Weekly Team Conference notes use DIFFERENT question numbers (checked 2026-10-23):
  // PT Weekly Team Conference Note (E50 cat 1126)
  9617: 'GG0170B', 9619: 'GG0170C', 9621: 'GG0170D', 9623: 'GG0170E',
  9625: 'GG0170I', 9627: 'GG0170J', 9629: 'GG0170K',
  // OT Weekly Team Conference Note (L84 cat 1128)
  9631: 'GG0130A', 9633: 'GG0130B', 9635: 'GG0130C', 9637: 'GG0170F',
  // Daily notes reuse the eval numbers: PT Mobility (E50 cat 1025) has 7734, 7736, 7740-7742,
  // 7748, 7749, 7751-7753. OT ADL (L84 cat 1028) has 7754-7756. Both notes have 7140/8655 (cat 1316).
};

// Which discipline each form belongs to (used for "most recent" at discharge)
export const FORM_DISCIPLINE = { E79: 'PT', E50: 'PT', E81: 'OT', L84: 'OT' };
// Discharge goals (7762-7764, 7766-7770, 7785, 9367) are also returned. This LTRAX form doesn't use them.

const BOWEL_TEXT = [
  [/always continent/i, 0], [/occasionally/i, 1], [/frequently/i, 2],
  [/always incontinent/i, 3], [/not rated/i, 9],
];
const BLADDER_TEXT = [
  [/always continent/i, 0], [/stress/i, 1], [/less than daily/i, 2], [/incontinent daily/i, 3],
  [/always incontinent/i, 4], [/no urine/i, 5], [/not applicable/i, 9],
];

function codeFromText(item, text) {
  const t = String(text || '').trim();
  if (item === 'GG0110') return t;                       // keep the option label
  if (item === 'GG0170Q') return /^yes/i.test(t) ? 1 : /^no/i.test(t) ? 0 : null;
  if (item === 'GG0170RR' || item === 'GG0170SS') return /motor/i.test(t) ? 2 : /manual/i.test(t) ? 1 : null;
  const m = t.match(/^(\d{1,2})\s*[.\-]/);               // "05. ...", "88. ...", "8 - Unknown", "4. Always..."
  if (m) return parseInt(m[1], 10);
  const table = item === 'H0400' ? BOWEL_TEXT : item === 'H0350' ? BLADDER_TEXT : null;
  return table?.find(([re]) => re.test(t))?.[1] ?? null;
}

// One row per answered question, mapped to an LTRAX item. Multi-select questions (7497) come back as
// one row per selected option, so all of them are kept.
export function parseResponse(json) {
  const ymd = s => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
  return (json.ORESULTS || [])
    .map(r => {
      const item = QUESTION_MAP[r.QUESTTABLENUM];
      if (!item) return null;
      const value = codeFromText(item, r.RESPTEXT);
      if (value == null) return null;
      return { item, value, form: r.FORMCODE, date: ymd(r.FORMDATE), time: r.FORMTIME, account: r.ACC };
    })
    .filter(Boolean);
}

// ---------- 2. Fixed values (until WellSky has a better source) ----------
export const FIXED_VALUES = {
  GG0170G: 10, // Car transfer: not attempted due to environment
  GG0170L: 88, // Walking 10 ft on uneven surfaces
  GG0170M: 88, // 1 step (curb)
  GG0170N: 88, // 4 steps
  GG0170O: 88, // 12 steps
  GG0170P: 88, // Picking up object
}; // applied to admission and discharge

// ---------- 3. Merge rules ----------
// Admission: worst value among conflicting entries. Discharge: best value from the most recent notes.
const code = v => (v == null || v === '' ? null : parseInt(String(v).trim(), 10)); // "02 - Sub..." -> 2
const isScore = n => n >= 1 && n <= 6;            // GG 6-point scale: higher = more independent
const NOT_ATTEMPTED = [88, 10, 9, 7];             // used only if no real 1-6 score exists

function pickGG(values, mode) {
  const nums = values.map(code).filter(n => n != null);
  const scores = nums.filter(isScore);
  if (scores.length) return mode === 'admit' ? Math.min(...scores) : Math.max(...scores);
  return NOT_ATTEMPTED.find(c => nums.includes(c)) ?? null;
}

// Bladder (H0350) / Bowel (H0400): LOWER = better (0 = always continent).
// 9 (and 5 for bladder) aren't ranked, so use them only if nothing else is charted.
function pickContinence(values, mode) {
  const nums = values.map(code).filter(n => n != null);
  const ranked = nums.filter(n => n >= 0 && n <= 4);
  if (ranked.length) return mode === 'admit' ? Math.max(...ranked) : Math.min(...ranked);
  return nums.includes(5) ? 5 : nums.includes(9) ? 9 : null;
}

// GG0100B prior mobility: 3 > 2 > 1 (8 = unknown, 9 = n/a). Admission only, so take the worst.
function pickPrior(values) {
  const nums = values.map(code).filter(n => n != null);
  const ranked = nums.filter(n => n >= 1 && n <= 3);
  if (ranked.length) return Math.min(...ranked);
  return nums.includes(8) ? 8 : nums.includes(9) ? 9 : null;
}


// ---------- 4. Prior Device Use (GG0110) ----------
// WellSky Q7497 is multi-select ("Manual wheelchair", "Motorized wheelchair and/or scooter",
// "Mechanical lift", "None"). Every option is No unless it's selected, and "None" is often left
// unchecked, so it counts as None whenever none of the three devices is selected.
// Union across PT and OT: if either discipline checked a device, it's Yes.
export function priorDevices(selectionStrings) {
  const all = selectionStrings.join(',').toLowerCase();
  const manual = /manual wheelchair/.test(all);
  const motor = /motorized/.test(all);
  const lift = /mechanical lift/.test(all);
  return {
    radPriorDeviceUseManualWheelChair: manual ? 1 : 0,
    radPriorDeviceUseMotorizedWheelChair: motor ? 1 : 0,
    radPriorDeviceUseMechanicalLift: lift ? 1 : 0,
    // GG0110Z is set by LTRAX itself
  };
}

// ---------- 5. Build the LTRAX values for one patient ----------
// rows: output of parseResponse(); mode: 'admit' | 'discharge'
// Returns { values: { GG0130A: 2, ... }, flags: [ 'text', ... ] }.
// Match values to LTRAX field names via FUNCT_TEMPLATE (ltrax.admit or ltrax.disch).
// Anything in flags is a compliance gap: leave that LTRAX field blank and fix the source in WellSky.
const SCORED_ITEMS = ['GG0130A', 'GG0130B', 'GG0130C', 'GG0170A', 'GG0170B', 'GG0170C', 'GG0170D',
  'GG0170E', 'GG0170F', 'GG0170I', 'GG0170J', 'GG0170K', 'H0350', 'H0400'];
const WHEEL_ITEMS = ['GG0170R', 'GG0170RR', 'GG0170S', 'GG0170SS'];

// Discharge: most recent entry per DISCIPLINE (PT = E79+E50, OT = E81+L84), so an old eval can't beat a newer note.
function mostRecentPerDiscipline(rows) {
  const stamp = r => r.date.getTime() * 1e4 + (parseInt(r.time, 10) || 0);
  const latest = {};
  for (const r of rows) {
    const d = FORM_DISCIPLINE[r.form] || r.form;
    if (!latest[d] || stamp(r) > stamp(latest[d])) latest[d] = r;
  }
  return Object.values(latest);
}

export function resolveFunct(rows, mode) {
  const byItem = {};
  for (const r of rows) (byItem[r.item] ??= []).push(r);
  const values = {};
  const flags = [];

  for (const [item, list] of Object.entries(byItem)) {
    if (item in FIXED_VALUES || item === 'GG0110') continue;
    const use = mode === 'discharge' ? mostRecentPerDiscipline(list) : list;
    const vals = use.map(r => r.value);
    if (item === 'GG0100B') { if (mode === 'admit') values[item] = pickPrior(vals); }
    else if (item === 'GG0170Q') values[item] = vals.includes(1) ? 1 : 0; // either discipline says Yes -> Yes
    else if (item === 'GG0170RR' || item === 'GG0170SS') values[item] = vals.includes(2) ? 2 : 1;
    else if (item === 'H0350' || item === 'H0400') values[item] = pickContinence(vals, mode);
    else values[item] = pickGG(vals, mode);
  }

  // Compliance: wheelchair use must be answered in WellSky (No is fine). Don't default to 88.
  if (!('GG0170Q' in values)) {
    flags.push('Wheelchair/scooter use (GG0170Q, WellSky Q7753) not answered: mark Yes or No in WellSky');
    WHEEL_ITEMS.forEach(k => delete values[k]);
  } else if (values.GG0170Q === 1) {
    WHEEL_ITEMS.filter(k => !(k in values))
      .forEach(k => flags.push(`${k} missing in WellSky (wheelchair use = Yes)`));
  } else {
    WHEEL_ITEMS.forEach(k => delete values[k]); // Q = No: LTRAX disables these
  }

  for (const k of SCORED_ITEMS) if (!(k in values)) flags.push(`${k} not charted in WellSky`);
  if (mode === 'admit' && !('GG0100B' in values)) flags.push('GG0100B prior mobility (Q7292) not charted');

  if (mode === 'discharge') {
    const forms = new Set(rows.map(r => r.form));
    if (!forms.has('E50')) flags.push('No PT Note - LTCH (E50) found: PT discharge scores come from the eval');
    if (!forms.has('L84')) flags.push('No OT Note - LTCH (L84) found: OT discharge scores come from the eval');
  }

  Object.assign(values, FIXED_VALUES);
  if (mode === 'admit') values.GG0110 = priorDevices((byItem.GG0110 || []).map(r => r.value));
  return { values, flags };
}
