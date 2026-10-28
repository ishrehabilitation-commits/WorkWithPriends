/**
 * LTRAX sync (service worker side): pulls Section GG codes from WellSky and fills the
 * LTRAX Funct tab. The "LTRAX sync" dashboard tab (tab.js) starts it; this file does the
 * work so it keeps going while the panel is hidden.
 *
 * scan:  LTRAX launch screen -> incomplete patients at the facility's Site -> matched by
 *        name + admit date against the WellSky grid (HOHSRCH) -> WellSky HXHFRPT per matched
 *        patient -> resolveFunct() values + compliance flags. Nothing in LTRAX is changed.
 * apply: for each selected patient, open them in LTRAX, fill the Funct tab, save with
 *        "Next: Pain/Falls", check the tab turned green, then HOME to release the lock.
 *        One patient at a time in the same tab (LTRAX logs you out on a second window).
 *
 * WellSky calls run in the WellSky tab that asked (page world, so they can use HCS).
 * State lives in chrome.storage.session (memory only, cleared when the browser closes).
 */
import { buildRequest, parseResponse, resolveFunct } from './wellsky.js';
import { LAUNCH_SCREEN, TAB_STATUS, EXIT_ROUTINE } from './ltrax-template.js';
import { buildFieldList, fromDateFor, admitFromCells } from './fields.js';
import { GRID_URL, FACILITIES, buildGridRequest, parseGrid, matchPatient } from './grid.js';
import * as L from './inject-ltrax.js';
import { callInteractant } from './inject-wellsky.js';

const HXHFRPT_URL = '/Interactant/get/HXHFRPT';
const LTRAX_TABS = ['https://ltrax.com/*', 'https://*.ltrax.com/*'];
const STEP_TIMEOUT = 30000;
const STATE_KEY = 'ltraxSync';

// ---------- state ----------
async function getState() {
  return (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] ?? { phase: 'idle', patients: [] };
}
async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ [STATE_KEY]: next });
  return next;
}
async function updatePatient(key, patch) {
  const s = await getState();
  await setState({ patients: s.patients.map(p => (p.key === key ? { ...p, ...patch } : p)) });
}

// ---------- tab helpers ----------
async function findLtraxTab() {
  const tabs = await chrome.tabs.query({ url: LTRAX_TABS });
  if (!tabs.length) throw new Error('No LTRAX tab found. Open LTRAX in a tab, sign in and leave it on the launch screen.');
  return tabs.find(t => /LaunchScreen|Assessment/i.test(t.url ?? '')) ?? tabs[0];
}

// Runs func in every frame and returns the first non-null result.
async function run(tabId, func, args = [], world = 'ISOLATED') {
  const out = await chrome.scripting.executeScript({ target: { tabId, allFrames: world === 'ISOLATED' }, func, args, world });
  return out.map(r => r.result).find(r => r != null) ?? null;
}

// Polls until func returns non-null in some frame. Errors during page loads are expected.
async function waitFor(tabId, func, args, what) {
  const end = Date.now() + STEP_TIMEOUT;
  while (Date.now() < end) {
    try {
      const r = await run(tabId, func, args);
      if (r != null) return r;
    } catch { /* page is navigating */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// ---------- scan ----------
async function scan(wellskyTabId, facility) {
  await setState({ phase: 'scanning', error: null, patients: [], counts: null, facility, wellskyTabId });
  if (!FACILITIES[facility]) throw new Error(`LTRAX sync doesn't know facility ${facility}.`);
  const ltrax = await findLtraxTab();

  const launch = await run(ltrax.id, L.scanLaunchScreen);
  if (!launch) throw new Error(`The LTRAX tab isn't on the launch screen (${LAUNCH_SCREEN.url}). Click HOME there and try again.`);

  const gridRes = await run(wellskyTabId, callInteractant, [GRID_URL, buildGridRequest(facility)], 'MAIN');
  if (!gridRes || gridRes.error) throw new Error(gridRes?.error ?? 'No response from the WellSky grid.');
  const grid = parseGrid(gridRes);
  if (grid.error) throw new Error(grid.error);

  const noAdmitCol = launch.rows.length && !launch.rows.some(r => admitFromCells(r.cells));
  if (noAdmitCol) {
    const headers = Object.keys(launch.rows[0].cells).join(', ');
    throw new Error(`Couldn't read an admit date on the LTRAX launch screen. Columns: ${headers}`);
  }

  // LTRAX lists every facility: keep rows whose Site is ours, then require a WellSky grid match.
  const site = FACILITIES[facility].toLowerCase();
  const siteRows = launch.rows.filter(r => !('Site' in r.cells) || r.cells.Site.toLowerCase() === site);
  const patients = [];
  const seen = new Set();
  for (const r of siteRows) {
    const admit = admitFromCells(r.cells);
    const key = `${r.section}|${r.name}|${admit}`;
    if (seen.has(key)) continue; // same name + admit date twice: first row wins
    seen.add(key);
    const match = admit && matchPatient(grid.rows, r.name, admit);
    if (!match) continue;
    patients.push({ key, name: r.name, section: r.section, admit, admitText: r.cells['Admit Date'] ?? '', account: match.account, status: 'queued' });
  }
  // Counts only (no names) so a zero-match run can be diagnosed.
  await setState({ patients, counts: { ltrax: siteRows.length, grid: grid.rows.length, matched: patients.length } });

  for (const p of patients) {
    const mode = p.section === 'discharge' ? 'discharge' : 'admit';
    const request = buildRequest({ userId: null, sessionToken: null, account: p.account, mode, facility, fromDate: fromDateFor(p.admit) });
    const res = await run(wellskyTabId, callInteractant, [HXHFRPT_URL, request], 'MAIN');
    if (!res || res.error) {
      await updatePatient(p.key, { status: 'error', error: res?.error ?? 'No response from WellSky.' });
      continue;
    }
    const { values, flags } = resolveFunct(parseResponse(res), mode);
    const fields = buildFieldList(values, mode);
    await updatePatient(p.key, { status: fields.length ? 'ready' : 'nothing', fields, flags });
  }
  await setState({ phase: 'scanned' });
}

// ---------- apply ----------
async function applyOne(tabId, p, overwrite) {
  await waitFor(tabId, L.scanLaunchScreen, [], 'the LTRAX launch screen');
  if (!(await run(tabId, L.openPatient, [p.section, p.name, p.admitText]))) throw new Error('Patient is no longer listed on the launch screen.');

  let opened = false;
  try {
    await waitFor(tabId, L.hasElement, [TAB_STATUS.button], 'the assessment to open');
    opened = true;
    // Blank launch-screen status doesn't mean Funct is incomplete: skip it if the tab is already green.
    const before = await run(tabId, L.readTabColor);
    if (before === EXIT_ROUTINE.greenColor) return { skipped: true, color: before, complete: true };
    await run(tabId, L.clickElement, [TAB_STATUS.button]);
    const probe = p.fields[0]?.name;
    await waitFor(tabId, L.hasElement, [null, probe], 'the Funct tab');

    await run(tabId, L.muteDialogs, [], 'MAIN');
    const results = await run(tabId, L.fillFunctFields, [p.fields, overwrite]);
    if (!results) throw new Error('Funct tab fields not found.');
    const dialogs = (await run(tabId, L.readDialogs, [], 'MAIN')) ?? [];

    await run(tabId, L.clickElement, [EXIT_ROUTINE.saveButton]);
    // Saved once the Funct controls are gone and the next tab's nav is up.
    await waitFor(tabId, (sel, name) => (document.querySelector(sel) && !document.getElementsByName(name).length ? true : null),
      [TAB_STATUS.colorSwatch, probe], 'LTRAX to save');
    const color = await run(tabId, L.readTabColor);
    return { results, dialogs, color, complete: color === EXIT_ROUTINE.greenColor };
  } finally {
    // Always go HOME so the assessment lock is released, even after an error.
    if (opened) {
      await run(tabId, L.clickElement, [EXIT_ROUTINE.homeButton]).catch(() => {});
      await waitFor(tabId, L.scanLaunchScreen, [], 'HOME').catch(() => {});
    }
  }
}

async function apply(keys, overwrite) {
  await setState({ phase: 'applying', error: null });
  const ltrax = await findLtraxTab();
  const { patients } = await getState();
  for (const p of patients.filter(x => keys.includes(x.key) && x.status === 'ready')) {
    await updatePatient(p.key, { status: 'working' });
    try {
      const out = await applyOne(ltrax.id, p, overwrite);
      await updatePatient(p.key, { status: out.skipped ? 'already' : out.complete ? 'done' : 'incomplete', ...out });
    } catch (e) {
      await updatePatient(p.key, { status: 'error', error: e.message });
    }
  }
  await setState({ phase: 'applied' });
}

// ---------- messages from the dashboard tab ----------
export function registerLtraxSync() {
  // Lets the dashboard (a content script) read and follow the sync state.
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg?.type?.startsWith('wwp:ltrax:')) return false;
    let origin = '';
    try { origin = new URL(sender.url).origin; } catch { /* no url */ }
    if (sender.id !== chrome.runtime.id || !sender.tab?.id || !origin.endsWith('.specialtycare.wellsky.com')) {
      reply({ ok: false });
      return false;
    }
    const job = msg.type === 'wwp:ltrax:scan' ? scan(sender.tab.id, String(msg.facility))
      : msg.type === 'wwp:ltrax:apply' ? apply(msg.keys ?? [], !!msg.overwrite)
        : msg.type === 'wwp:ltrax:reset' ? setState({ phase: 'idle', patients: [], counts: null, error: null }) : null;
    if (!job) return false;
    job.catch(e => setState({ phase: 'error', error: e.message }));
    reply({ ok: true }); // the tab follows progress through storage
    return false;
  });
}
