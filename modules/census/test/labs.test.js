// Made-up lab values only. Never put real patient data in tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../labs.js');

// Builds a HOHLRSLT-shaped reply: dates newest first, rows = { name: [values by date] }.
function reply(dates, rows, extra = {}) {
  const cols = dates.length + 1;
  const head = { TABLELINE: 'H', TABLECOL1: 'Laboratory Results' };
  dates.forEach((d, i) => { head['TABLECOL' + (i + 2)] = d; });
  for (let c = cols + 1; c <= 51; c++) head['TABLECOL' + c] = '';
  const table = [head, { TABLELINE: 'C', TABLECOL1: 'Chemistry' }];
  for (const [name, vals] of Object.entries(rows)) {
    const r = { TABLELINE: 'D', TABLECOL1: name };
    vals.forEach((v, i) => { r['TABLECOL' + (i + 2)] = v; });
    table.push(r);
  }
  return JSON.stringify({ TABLEROWS: String(table.length), TABLECOLS: String(cols), RTRNCD: '', TABLEINFO: table, ...extra });
}
const D = ['11/24/2026 05:45', '11/22/2026 05:10', '11/19/2026 19:24'];
const run = (rows, dates = D) => L.evaluate(L.parseResults(reply(dates, rows)));
const pick = (flags, label) => flags.filter(f => f.label === label).map(f => [f.value, f.mmdd, f.level, f.latest]);

test('cleanNumber strips &nbsp; and the H/L/* markers', () => {
  assert.equal(L.cleanNumber('135&nbsp; L'), 135);
  assert.equal(L.cleanNumber('218&nbsp; * H'), 218);
  assert.equal(L.cleanNumber('135'), 135);
  assert.equal(L.cleanNumber('<0.5&nbsp;'), 0.5);
  assert.equal(L.cleanNumber('TNP&nbsp;'), null);
  assert.equal(L.cleanText('Negative&nbsp;'), 'Negative');
});

test('parseResults reads dates from the Laboratory Results row up to TABLECOLS', () => {
  const p = L.parseResults(reply(D, { Sodium: ['138&nbsp;', '', '124&nbsp; L'] }));
  assert.deepEqual(p.dates.map(d => [d.col, d.mmdd]), [[2, '11/24'], [3, '11/22'], [4, '11/19']]);
  assert.deepEqual(p.labs.get('sodium').values.map(v => [v.mmdd, v.value]), [['11/24', 138], ['11/19', 124]]);
});

test('parseCategories handles one or many categories', () => {
  assert.deepEqual(L.parseCategories('{"CATCOUNT":"2","CATINFO":[{"CATDESC":"Chemistry"},{"CATDESC":"Hematology"}],"RTRNCD":""}'), ['Chemistry', 'Hematology']);
  assert.deepEqual(L.parseCategories('{"CATCOUNT":"1","CATINFO":{"CATDESC":"Other Labs"},"RTRNCD":""}'), ['Other Labs']);
  assert.deepEqual(L.parseCategories('{"CATCOUNT":"0","RTRNCD":""}'), []);
});

test('request bodies carry the session token and categories', () => {
  const b = JSON.parse(L.buildResultsBody({ userId: 'U', token: 'T', facility: '204', account: '204000001', mrn: '', categories: ['Chemistry'], from: 20261101, to: 20261124 }));
  assert.equal(b.name, 'HOHLRSLT');
  assert.deepEqual([b.data.PASSWD, b.data.REQLV6, b.data.REQACC, b.data.REQMRN, b.data.REQFDT], ['T', 204, 204000001, '', '20261101']);
  assert.deepEqual(b.data.REQCAT, ['Chemistry']);
});

test('chemistry and hemoglobin thresholds', () => {
  const f = run({
    Sodium: ['124&nbsp; L', '156&nbsp; H', '125&nbsp; L'],
    Potassium: ['3.0&nbsp; L', '6.0&nbsp; H', '3.1&nbsp;'],
    Glucose: ['69&nbsp; L', '301&nbsp; H', '300&nbsp; H'],
    'Glucose, Urine': ['Negative&nbsp;'],
    Hemoglobin: ['7.5&nbsp; L', '6.9&nbsp; L', '8.0&nbsp; L'],
  });
  assert.deepEqual(pick(f, 'Na'), [['124', '11/24', 'hold', true], ['156', '11/22', 'hold', false]]);
  assert.deepEqual(pick(f, 'K'), [['3.0', '11/24', 'hold', true], ['6.0', '11/22', 'hold', false]]);
  assert.deepEqual(pick(f, 'Glu'), [['69', '11/24', 'hold', true], ['301', '11/22', 'hold', false]]);
  assert.deepEqual(pick(f, 'Hgb'), [['7.5', '11/24', 'flag', true], ['6.9', '11/22', 'hold', false]]);
});

test('WBC: hold outside 2.5-30, check under 5 until vitals', () => {
  const f = run({ 'White Blood Cell Count': ['4.1&nbsp; L', '2.4&nbsp; L', '30.5&nbsp; H'] });
  assert.deepEqual(pick(f, 'WBC'), [['4.1', '11/24', 'check', true], ['2.4', '11/22', 'hold', false], ['30.5', '11/19', 'hold', false]]);
});

test('platelets in K/uL or raw counts', () => {
  const f = run({ 'Platelet Count': ['4&nbsp; L', '19&nbsp; L', '25000'] });
  assert.deepEqual(pick(f, 'Plt'), [['4K', '11/24', 'hold', true], ['19K', '11/22', 'flag', false]]);
  assert.deepEqual(pick(run({ 'Platelet Count': ['4500'] }), 'Plt'), [['4500', '11/24', 'hold', true]]);
});

test('ABG: PCO2 > 60 needs pH < 7.30 in the same draw; PO2 < 55', () => {
  const f = run({
    'ABG pH': ['7.25&nbsp; L', '7.30&nbsp; L', ''],
    'ABG PCO2': ['65&nbsp; H', '76.8&nbsp; * C', '61&nbsp; H'],
    'ABG PO2': ['54&nbsp; L', '62&nbsp; L', ''],
  });
  assert.deepEqual(pick(f, 'PCO2'), [['65 / pH 7.25', '11/24', 'hold', true], ['61', '11/19', 'flag', false]]);
  assert.deepEqual(pick(f, 'PO2'), [['54', '11/24', 'hold', true]]);
});

test('infection tests are positive unless Negative; TNP is skipped', () => {
  const f = run({
    'Toxigenic C difficile': ['Positive&nbsp; *'],
    'Flu A by PCR': ['Negative&nbsp;'],
    'Flu B by PCR': ['TNP&nbsp;'],
    'SARS CoV-2 Result': ['Not Detected&nbsp;', 'Detected&nbsp; *'],
    'RSV by PCR': ['', '', 'POSITIVE'],
  });
  assert.deepEqual(f.filter(x => ['C diff', 'Flu A', 'Flu B', 'COVID', 'RSV'].includes(x.label)).map(x => [x.label, x.value, x.latest]),
    [['C diff', 'Positive', true], ['COVID', 'Detected', false], ['RSV', 'POSITIVE', true]].sort((a, b) => b[2] - a[2]));
});

test('summarize: newest flag per lab and overall level', () => {
  const f = run({ Hemoglobin: ['9.0&nbsp; L', '6.8&nbsp; L'], Sodium: ['150&nbsp;'] });
  const s = L.summarize(f);
  assert.equal(s.level, 'past');
  assert.deepEqual(s.list.map(x => x.label), ['Hgb']);
  assert.equal(L.csvText(f), 'Hgb 6.8 (11/22) earlier');
  assert.equal(L.summarize(run({ Sodium: ['120'] })).level, 'hold');
  assert.equal(L.summarize([]).level, null);
});
