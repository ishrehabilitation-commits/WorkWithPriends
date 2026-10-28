// All data here is made up. Never put real patient data in tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseResponse, resolveFunct } from '../wellsky.js';
import { buildFieldList, toYmd, fromDateFor, admitFromCells } from '../fields.js';
import { nameKey, parseGrid, matchPatient, buildGridRequest } from '../grid.js';
import { buildRequest } from '../wellsky.js';
import { scanLaunchScreen, openPatient, fillFunctFields } from '../inject-ltrax.js';

const row = (FORMCODE, QUESTTABLENUM, RESPTEXT, FORMDATE = '20261014', FORMTIME = '0900') =>
  ({ FORMCODE, QUESTTABLENUM: String(QUESTTABLENUM), RESPTEXT, FORMDATE, FORMTIME, ACC: 'TEST001' });

test('admission takes the worst score, discharge the most recent per discipline', () => {
  const rows = parseResponse({ ORESULTS: [
    row('E79', 7737, '03. Partial/moderate assistance'),
    row('E81', 7737, '02. Substantial/maximal assistance'),
    row('E50', 7737, '04. Supervision', '20261020'),
    row('E79', 7753, 'No'),
  ] });
  assert.equal(resolveFunct(rows, 'admit').values.GG0170D, 2);
  assert.equal(resolveFunct(rows, 'discharge').values.GG0170D, 4);
});

test('buildFieldList maps to LTRAX names in template order and skips GG0110Z', () => {
  const { values } = resolveFunct(parseResponse({ ORESULTS: [
    row('E79', 7753, 'Yes'), row('E79', 7748, '04. Supervision'), row('E79', 7497, 'Walker'),
    row('E81', 7754, '05. Setup or clean-up ONLY'),
  ] }), 'admit');
  const fields = buildFieldList(values, 'admit');
  const names = fields.map(f => f.name);
  assert.ok(names.indexOf('radWheelchairScooterUseAdmit') < names.indexOf('selAdmitMobilityPerformanceWheel50FeetTwoTurns'));
  assert.equal(fields.find(f => f.item === 'GG0130A').value, '5');
  assert.equal(fields.find(f => f.name === 'radPriorDeviceUseManualWheelChair').value, '0');
  assert.ok(!names.includes('radPriorDeviceUseNOTA'));
  assert.ok(!buildFieldList(values, 'discharge').some(f => f.item === 'GG0100B' || f.item === 'H0400'));
});

test('helpers', () => {
  assert.equal(toYmd('3/7/2026'), '20260307');
  assert.equal(toYmd('2026-03-07'), '20260307');
  assert.equal(fromDateFor('', new Date('2026-10-26T00:00:00Z'), 10), '20261016');
  assert.equal(toYmd('20270101'), '20270101');
  assert.equal(admitFromCells({ Name: 'x', 'Admit Date': '1/1/2027', 'Admit Status': '' }), '20270101');
});

function withDom(html, fn) {
  const dom = new JSDOM(html);
  const g = globalThis;
  const saved = { document: g.document, Event: g.Event, getComputedStyle: g.getComputedStyle };
  Object.assign(g, { document: dom.window.document, Event: dom.window.Event, getComputedStyle: dom.window.getComputedStyle });
  try { return fn(dom.window.document); } finally { Object.assign(g, saved); }
}

// Same layout as the live launch screen: section titles sit in their own table above each
// table.assess, cells are padded with &nbsp;, and a colspan footer row closes each table.
const title = t => `<table class="launch-screen-border"><tr><td><b>${t}&nbsp;Assessments</b></td></tr></table>`;
const LAUNCH = `
${title('Pre-Admission')}<table class="assess"><tr><th>&nbsp;#&nbsp;</th><th>&nbsp;<a href=".">Patient Name</a>&nbsp;</th><th>&nbsp;Status&nbsp;</th><th>&nbsp;Site&nbsp;</th></tr>
  <tr><td>&nbsp;1&nbsp;</td><td>&nbsp;<a href="#">Pre, Patient</a>&nbsp;</td><td>&nbsp;&nbsp;</td><td>&nbsp;Shreveport&nbsp;</td></tr></table>
${title('Admission')}<table class="assess"><tr><th>&nbsp;#&nbsp;</th><th>&nbsp;<a href=".">Patient Name</a>&nbsp;</th><th>&nbsp;<a href=".">Admit Date</a>&nbsp;</th>
  <th>&nbsp;Warnings&nbsp;</th><th>&nbsp;LOS&nbsp;</th><th>&nbsp;Admit Status&nbsp;</th><th>&nbsp;<a href=".">Site <img></a>&nbsp;</th></tr>
  <tr><td>&nbsp;1&nbsp;</td><td align="LEFT">&nbsp;<a href="#">Test, Alpha</a>&nbsp;</td><td class="awaiting_completion_deadline_near">&nbsp;10-22-2026&nbsp;</td>
    <td>&nbsp;&nbsp;</td><td>&nbsp;<i>4</i>&nbsp;</td><td>&nbsp;&nbsp;&nbsp;</td><td>&nbsp;Shreveport&nbsp;</td></tr>
  <tr><td>&nbsp;2&nbsp;</td><td>&nbsp;<a href="#">Test, Beta</a>&nbsp;</td><td>&nbsp;10-14-2026&nbsp;</td>
    <td>&nbsp;&nbsp;</td><td>&nbsp;<i>12</i>&nbsp;</td><td>&nbsp;Accepted by CMS&nbsp;</td><td>&nbsp;Bossier City&nbsp;</td></tr>
  <tr><td colspan="7"><div>1 - 2 of 2 assessments</div></td></tr></table>
${title('Discharge')}<table class="assess"><tr><th>&nbsp;#&nbsp;</th><th>&nbsp;Patient Name&nbsp;</th><th>&nbsp;Admit Date&nbsp;</th><th>&nbsp;Discharge&nbsp;<br>&nbsp;Date&nbsp;</th>
  <th>&nbsp;Admit Status&nbsp;</th><th>&nbsp;Disch. Status&nbsp;</th><th>&nbsp;Site&nbsp;</th></tr>
  <tr><td>&nbsp;1&nbsp;</td><td>&nbsp;<a href="#">Test, Gamma</a>&nbsp;</td><td>&nbsp;09-01-2026&nbsp;</td><td>&nbsp;10-20-2026&nbsp;</td>
    <td>&nbsp;Accepted by CMS&nbsp;</td><td>&nbsp;&nbsp;</td><td>&nbsp;Pierremont&nbsp;</td></tr>
  <tr><td colspan="7">1 - 1 of 1 assessments</td></tr></table>`;

test('scanLaunchScreen returns only blank-status rows, skipping Pre-Admission', () => withDom(LAUNCH, doc => {
  const { rows } = scanLaunchScreen();
  assert.deepEqual(rows.map(r => [r.section, r.name, r.cells['Admit Date'], r.cells.Site]),
    [['admit', 'Test, Alpha', '10-22-2026', 'Shreveport'], ['discharge', 'Test, Gamma', '09-01-2026', 'Pierremont']]);
  assert.equal(admitFromCells(rows[0].cells), '20261022');
  let clicked = '';
  doc.querySelectorAll('a').forEach(a => a.addEventListener('click', () => { clicked = a.textContent; }));
  assert.equal(openPatient('discharge', 'Test, Gamma', '09-01-2026'), true);
  assert.equal(clicked, 'Test, Gamma');
  assert.equal(openPatient('admit', 'Test, Gamma', '09-01-2026'), null);
  assert.equal(openPatient('admit', 'Test, Alpha', '01-01-2020'), null);
}));

const FUNCT = `<form name="frmIRFPAI">
  <select name="selA"><option value="-32768"></option><option value="06">6</option><option value="03">3</option></select>
  <select name="selB"><option value="-32768"></option><option value="3">3</option><option value="4" selected>4</option></select>
  <input type="radio" name="radQ" value="-32768" checked><input type="radio" name="radQ" value="0"><input type="radio" name="radQ" value="1">
</form>`;

test('fillFunctFields fills blanks, reports mismatches, overwrites only when asked', () => withDom(FUNCT, doc => {
  const fields = [
    { item: 'A', name: 'selA', type: 'select', value: '6' },
    { item: 'B', name: 'selB', type: 'select', value: '3' },
    { item: 'Q', name: 'radQ', type: 'radio', value: '1' },
    { item: 'X', name: 'missing', type: 'select', value: '1' },
  ];
  let changed = 0;
  doc.getElementsByName('selA')[0].addEventListener('change', () => changed++);
  const r = Object.fromEntries(fillFunctFields(fields, false).map(x => [x.item, x.outcome]));
  assert.deepEqual(r, { A: 'filled', B: 'mismatch', Q: 'filled', X: 'missing' });
  assert.equal(doc.getElementsByName('selA')[0].value, '06');
  assert.equal(doc.getElementsByName('selB')[0].value, '4');
  assert.equal(doc.querySelector('input[name=radQ]:checked').value, '1');
  assert.equal(changed, 1);
  const again = Object.fromEntries(fillFunctFields(fields, true).map(x => [x.item, x.outcome]));
  assert.deepEqual(again, { A: 'same', B: 'overwritten', Q: 'same', X: 'missing' });
}));

test('grid: match on name + admit date, first row wins on duplicates', () => {
  assert.equal(nameKey('Doe, John A'), 'DOE|JOHN');
  assert.equal(nameKey('JOHN DOE'), 'DOE|JOHN');
  assert.equal(nameKey('Doe, John'), nameKey('DOE, JOHN B'));
  assert.equal(nameKey('Doe, Joe'), nameKey('DOE, JOE BOB'));
  assert.equal(nameKey('Doe, John'), nameKey('DOE JR, JOHN'));
  assert.equal(nameKey("O'Neil-Smith, Ann"), nameKey('ONEILSMITH, ANN'));
  assert.equal(toYmd('10-25-2026'), '20261025');
  const grid = parseGrid({ ORESULTS: [{ GRIDNAME: 'DOE, JOHN B', GRIDADMIT: '20261025', GRIDACCT: 'T5' }] }).rows;
  assert.equal(matchPatient(grid, 'Doe, John', admitFromCells({ 'Birth Date': '01-01-1950', 'Admit Date': '10-25-2026' })).account, 'T5');
  const { rows } = parseGrid({ ORESULTS: [
    { PATNAME: 'DOE, JOHN', ADMDATE: '20270101', ACCT: 'T1' },
    { PATNAME: 'DOE, JOHN', ADMDATE: '20270101', ACCT: 'T2' },
    { PATNAME: 'DOE, JOHN', ADMDATE: '20261201', ACCT: 'T3' },
  ] });
  assert.equal(matchPatient(rows, 'Doe, John', '20270101').account, 'T1');
  assert.equal(matchPatient(rows, 'Doe, John', '20261201').account, 'T3');
  assert.equal(matchPatient(rows, 'Roe, Jane', '20270101'), null);
});

test('grid: live column names (GRIDNAME/GRIDADMIT/GRIDACCT)', () => {
  const { rows, error } = parseGrid({ ORESULTS: [{ GRIDNAME: 'DOE, JANE', GRIDADMIT: '10/01/2026', GRIDADMITT: '1200', GRIDADMITTING: 'X', GRIDACCT: 'T9', GRIDMRNO: 'M1' }] });
  assert.equal(error, undefined);
  assert.deepEqual(rows, [{ name: 'DOE, JANE', admit: '20261001', account: 'T9' }]);
  assert.match(parseGrid({ ORESULTS: [{ GRIDNAME: 'A, B', GRIDADMIT: '???', GRIDACCT: '1' }] }).error, /format/);
  assert.equal(toYmd('Oct 1, 2026'), '20261001');
});

test('grid: unknown columns report column names only', () => {
  const r = parseGrid({ ORESULTS: [{ FOO: 'secret', BAR: 'x' }] });
  assert.match(r.error, /FOO, BAR/);
  assert.doesNotMatch(r.error, /secret/);
});

test('facility code goes to both WellSky requests', () => {
  assert.equal(buildGridRequest('203').data.REQLVL6, 203);
  assert.equal(buildRequest({ account: 'T1', mode: 'admit', facility: '202' }).data.ILEVELCODE, 202);
});


test('fillFunctFields clicks radios and retries items unlocked by a later answer', () => withDom(`
  <select name="selR" disabled><option value="-32768"></option><option value="4">4</option></select>
  <input type="radio" name="radQ" value="0"><input type="radio" name="radQ" value="1"><input type="radio" name="radQ" value="-32768" checked>`, doc => {
  // Stand-in for LTRAX's handler: Q = Yes unlocks R.
  doc.querySelector('input[name=radQ][value="1"]').addEventListener('click', () => { doc.getElementsByName('selR')[0].disabled = false; });
  const r = fillFunctFields([
    { item: 'R', name: 'selR', type: 'select', value: '4' },
    { item: 'Q', name: 'radQ', type: 'radio', value: '1' },
  ], false);
  assert.deepEqual(r.map(x => x.outcome), ['filled', 'filled']);
  assert.equal(doc.getElementsByName('selR')[0].value, '4');
}));
