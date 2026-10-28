/**
 * Functions run inside the LTRAX tab with chrome.scripting.executeScript.
 * Chrome serializes each function on its own, so they must not use imports or
 * anything else from this module. They run in every frame; a frame that has
 * nothing to report returns null.
 */

// Reads the launch screen: rows in the Admission/Discharge tables whose status cell is blank.
// The "Admission Assessments" / "Discharge Assessments" titles sit in a separate table above
// each table.assess, so the section is told apart by its status headers instead:
// Discharge has "Disch. Status", Admission has only "Admit Status", Pre-Admission has neither.
export function scanLaunchScreen() {
  const tables = [...document.querySelectorAll('table.assess')];
  if (!tables.length) return null;
  const clean = s => (s || '').replace(/\s+/g, ' ').trim(); // \s covers &nbsp;
  const rows = [];
  for (const table of tables) {
    const trs = [...table.rows];
    const headerIdx = trs.findIndex(tr => tr.querySelector('th'));
    if (headerIdx < 0) continue;
    const headers = [...trs[headerIdx].cells].map(c => clean(c.textContent));
    const dischCol = headers.findIndex(h => /^disch\.? status$/i.test(h));
    const admitCol = headers.findIndex(h => /^admit status$/i.test(h));
    const section = dischCol >= 0 ? 'discharge' : admitCol >= 0 ? 'admit' : null;
    if (!section) continue;
    const statusCol = section === 'discharge' ? dischCol : admitCol;
    for (const tr of trs.slice(headerIdx + 1)) {
      if (tr.cells.length !== headers.length) continue; // footer rows use colspan
      const link = tr.querySelector('a');
      if (!link) continue;
      const status = clean(tr.cells[statusCol]?.textContent);
      if (status) continue; // only blank status = still needs work
      const cells = {};
      headers.forEach((h, i) => { if (h) cells[h] = clean(tr.cells[i]?.textContent); });
      rows.push({ section, name: clean(link.textContent), cells, rowText: clean(tr.textContent) });
    }
  }
  return { rows };
}

// Clicks the patient-name link on the row with this name and admit date in the given section.
export function openPatient(section, name, admitText) {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  for (const table of document.querySelectorAll('table.assess')) {
    const trs = [...table.rows];
    const header = trs.find(tr => tr.querySelector('th'));
    if (!header) continue;
    const headers = [...header.cells].map(c => clean(c.textContent));
    const isDisch = headers.some(h => /^disch\.? status$/i.test(h));
    const isAdmit = !isDisch && headers.some(h => /^admit status$/i.test(h));
    if (section === 'discharge' ? !isDisch : !isAdmit) continue;
    const admitCol = headers.findIndex(h => /^admit date$/i.test(h));
    for (const tr of trs) {
      const link = tr.querySelector('a');
      if (!link || clean(link.textContent) !== name) continue;
      if (admitText && admitCol >= 0 && clean(tr.cells[admitCol]?.textContent) !== admitText) continue;
      link.click();
      return true;
    }
  }
  return null;
}

// True in the frame that has an element matching the selector (or a control with that name).
export function hasElement(selector, name) {
  if (selector && document.querySelector(selector)) return true;
  if (name && document.getElementsByName(name).length) return true;
  return null;
}

export function clickElement(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  el.click();
  return true;
}

// Reads #FunctTabColor's background on the page after saving.
export function readTabColor() {
  const el = document.getElementById('FunctTabColor');
  return el ? getComputedStyle(el).backgroundColor : null;
}

// Sets the Funct tab controls. Only fills blanks ("-32768" or empty) unless overwrite is true.
// fields: [{ item, name, type: 'select'|'radio', value }]
export function fillFunctFields(fields, overwrite) {
  const BLANK = ['', '-32768'];
  const same = (a, b) => a === b || (a !== '' && b !== '' && parseInt(a, 10) === parseInt(b, 10));
  const fire = el => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (!fields.some(f => document.getElementsByName(f.name).length)) return null;

  const setOne = f => {
    const els = [...document.getElementsByName(f.name)];
    const r = { item: f.item, name: f.name, want: f.value };
    if (!els.length) return { ...r, outcome: 'missing' };

    if (f.type === 'select') {
      const sel = els[0];
      const opt = [...sel.options].find(o => same(o.value, f.value));
      r.was = sel.value;
      if (!opt) r.outcome = 'no-option';
      else if (sel.disabled) r.outcome = 'disabled';
      else if (same(sel.value, f.value)) r.outcome = 'same';
      else if (!BLANK.includes(sel.value) && !overwrite) r.outcome = 'mismatch';
      else { sel.value = opt.value; fire(sel); r.outcome = BLANK.includes(r.was) ? 'filled' : 'overwritten'; }
    } else {
      const radios = els.filter(e => e.type === 'radio');
      const target = radios.find(e => same(e.value, f.value));
      r.was = radios.find(e => e.checked)?.value ?? '';
      if (!target) r.outcome = 'no-option';
      else if (target.disabled) r.outcome = 'disabled';
      else if (target.checked) r.outcome = 'same';
      else if (!BLANK.includes(r.was) && !overwrite) r.outcome = 'mismatch';
      else {
        // A real click, so LTRAX's own handlers run: they keep the hidSaverad* fields in step
        // and enable/disable dependent items (Q -> R/RR/S/SS, GG0110 A-C -> Z).
        target.click();
        r.outcome = BLANK.includes(r.was) ? 'filled' : 'overwritten';
      }
    }
    return r;
  };
  const results = fields.map(setOne);
  // Some items are only enabled after an earlier answer (LTRAX skip logic), so retry those once.
  results.forEach((r, i) => { if (r.outcome === 'disabled') results[i] = setOne(fields[i]); });
  return results;
}

// Runs in the page world (world: 'MAIN'). LTRAX can pop alert()/confirm() boxes when related
// items change (e.g. Prior Device Use -> None of the above), which would freeze the run.
// Until the page navigates away, alerts are logged and confirms answered OK (the change is the
// one we meant to make). The messages are shown in the popup so nothing is hidden.
export function muteDialogs() {
  if (window.__ggDialogs) return true;
  window.__ggDialogs = [];
  const log = (kind, msg) => window.__ggDialogs.push(`${kind}: ${String(msg ?? '').slice(0, 300)}`);
  window.alert = msg => { log('alert', msg); };
  window.confirm = msg => { log('confirm (answered OK)', msg); return true; };
  return true;
}

export function readDialogs() {
  return window.__ggDialogs ? [...window.__ggDialogs] : null;
}
