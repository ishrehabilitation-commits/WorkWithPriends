/**
 * Turns resolveFunct() output into the list of LTRAX controls to set, in template order
 * (so GG0170Q is set before the wheelchair items it gates).
 */
import { FUNCT_TEMPLATE } from './ltrax-template.js';

// mode: 'admit' | 'discharge'. Returns [{ item, name, type: 'select'|'radio', value: '6' }].
export function buildFieldList(values, mode) {
  const key = mode === 'discharge' ? 'disch' : 'admit';
  const out = [];
  for (const t of FUNCT_TEMPLATE) {
    const name = t.ltrax?.[key];
    if (!name || t.item === 'GG0110Z') continue; // GG0110Z is computed by LTRAX
    const type = t.type.startsWith('radio') ? 'radio' : 'select';
    const v = t.item.startsWith('GG0110') ? values.GG0110?.[name] : values[t.item];
    if (v == null) continue;
    out.push({ item: t.item, name, type, value: String(v) });
  }
  return out;
}

// "10/14/2026", "10-14-2026", "2026-10-14" or "20261014" -> "20261014". Returns null if it can't tell.
export function toYmd(text) {
  const t = String(text || '').trim();
  if (/^\d{8}$/.test(t)) return t;
  let m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}${m[1].padStart(2, '0')}${m[2].padStart(2, '0')}`;
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  const d = /[a-z]/i.test(t) ? new Date(t) : null; // "Oct 14, 2026"
  return d && !isNaN(d) ? `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` : null;
}

// WellSky date range start: the admit date if LTRAX shows one, otherwise `fallbackDays` back.
export function fromDateFor(admitText, today = new Date(), fallbackDays = 90) {
  const ymd = toYmd(admitText);
  if (ymd) return ymd;
  const d = new Date(today.getTime() - fallbackDays * 864e5);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// The admit date from a launch-screen row (first column whose header looks like one).
export function admitFromCells(cells) {
  const keys = Object.keys(cells);
  const key = keys.find(h => /\badm\w*\.?\s*(date|dt)/i.test(h)) ?? keys.find(h => /\badm/i.test(h) && !/status/i.test(h));
  return key ? toYmd(cells[key]) : null;
}
