// Made-up patients only. Never put real patient data in tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const WS = require('../census-data.js');

const now = new Date(2026, 9, 28);

test('parseDataHub reads the JS-literal reply and its JSON data', () => {
  const rows = WS.parseDataHub('{returnCode:0,count:1,data:[{"MMACCT":"1001","MMNAME":"DOE, JANE"}]}');
  assert.deepEqual(rows, [{ MMACCT: '1001', MMNAME: 'DOE, JANE' }]);
  assert.throws(() => WS.parseDataHub('<html>login</html>'), /session/);
});

test('parseFmp tolerates the spaces WellSky inserts when wrapping', () => {
  const f = WS.parseFmp('FMP: Y es / Out of Bed: No / Group: Yes / Team: 2');
  assert.deepEqual([f.fmp, f.oob, f.group, f.team], ['Yes', 'No', 'Yes', 2]);
  assert.deepEqual(WS.parseFmp('').raw, { fmp: null, oob: null, group: null, team: null });
});

const patient = (acct, room, type, extra = {}) => ({
  MMACCT: acct, MMPRMN: room, MMNAME: 'MCDOE, JOHN Q', MMPAGE: 64, MMPSEX: 'M', MMPCT1: type,
  PHY_AM: 'SMITH, ANN MD', CURPHY_CO: 'JONES, BOB MD', MMADDT: '20261020', MMDSDT: 0, ...extra,
});

test('mergeData: caseload, not picked up, needs eval, respite hidden', () => {
  const src = {
    current: [patient('1', 'SAMP00101A', 'LTCH'), patient('2', 'SAMP00102A', 'Respite'), patient('3', 'SAMP00103A', 'Rehab')],
    discharges: [],
    evals: { PT: [{ MMACCT: '1', FRMADT: '20261021', FRMABY: 'PT1' }], OT: [{ MMACCT: '1', FRMADT: '20261022' }], ST: [] },
    noPickup: { PT: [], OT: [{ ACC: '1' }], ST: [] },
    fmp: { PT: [{ ACC: '1', FORMDATE: '20261021', RESPTEXT: 'FMP: No / Out of Bed: Yes / Group: No / Team: 2' }], OT: [] },
    orders: [{ ACCOUNTNUM: '3', ORDERDESC: 'PT Eval and Treat', ORDERDATETIME: '202610250800', MEDRECNUM: 'M3' }],
  };
  const { patients } = WS.mergeData(src, now);
  assert.deepEqual(patients.map(p => p.acct), ['1', '3']);
  const [a, b] = patients;
  assert.equal(a.PT.caseload, 'Yes');
  assert.equal(a.OT.caseload, 'No');
  assert.equal(a.mobility, 'Yes');
  assert.equal(a.team, 2);
  assert.equal(b.PT.order.active, true);
  assert.equal(b.PT.evalDate, null);
  assert.equal(b.mrn, 'M3');
});

test('schedule export: room, name, columns and macro markers', () => {
  const { patients } = WS.mergeData({
    current: [patient('1', 'SAMP00360A', 'LTCH')],
    evals: { PT: [{ MMACCT: '1', FRMADT: '20261021' }], OT: [{ MMACCT: '1', FRMADT: '20261023' }], ST: [] },
    noPickup: { PT: [], OT: [{ ACC: '1' }], ST: [] },
    fmp: { PT: [], OT: [] },
    orders: [],
  }, now);
  const row = WS.scheduleRow(patients[0]);
  assert.equal(row.room, '360A');
  assert.equal(row.A, 'McDoe, John (64M)');
  assert.equal(row.C, 'Smith\nJones');
  assert.deepEqual([row.F, row.G, row.H], ['No\nOT', 'Y', 'N']);
  assert.equal(row.K, '{CLEAR}');
  assert.equal(row.I, '');
  assert.equal(row.M, '');
  assert.equal(row.N, '{LINE1}10/20/26');
  assert.equal(row.P, '10/21');
  const tsv = WS.scheduleTsv(patients, '204', now).split('\r\n');
  assert.match(tsv[0], /^#WELLSKY-SCHEDULE\tv1\t204\t/);
  assert.equal(tsv[2].split('\t')[3], 'No\\nOT');
});

test('schedule export: new eval is Y; team and group only when the form says so', () => {
  const base = { discharges: [], evals: { PT: [], OT: [], ST: [] }, noPickup: { PT: [], OT: [], ST: [] } };
  const { patients } = WS.mergeData({
    ...base,
    current: [patient('1', 'SAMP00110A', 'LTCH'), patient('2', 'SAMP00111A', 'LTCH'), patient('3', 'SAMP00112A', 'LTCH')],
    fmp: {
      PT: [{ ACC: '1', FORMDATE: '20261021', RESPTEXT: 'FMP: Yes / Out of Bed: No / Group: Yes' },
        { ACC: '2', FORMDATE: '20261021', RESPTEXT: 'FMP: No / Team: 2' }],
      OT: [],
    },
    orders: [{ ACCOUNTNUM: '3', ORDERDESC: 'PT Eval and Treat', ORDERDATETIME: '202610250800' }],
  }, now);
  const [fmp, stated, none] = patients.map(WS.scheduleRow);
  assert.deepEqual([fmp.M, fmp.I], ['3', 'Y']);
  assert.deepEqual([stated.M, stated.I], ['2', '']);
  assert.deepEqual([none.M, none.I, none.G], ['', '', 'Y']);
  assert.equal(patients[2].team, null);
});
