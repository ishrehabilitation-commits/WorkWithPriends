// Made-up vitals only. Never put real patient data in tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const V = require('../vitals.js');
const L = require('../labs.js');

const now = new Date(2026, 10, 24, 22, 0);
const e = (date, time, x) => ({ level6: 204, account: 204000001, date, time, ...x });
// JSONDATA arrives as string chunks that only parse once joined.
function reply(vitals) {
  const s = JSON.stringify({ BMI: 25, vitals });
  return JSON.stringify({ JSONCOUNT: '2', JSONDATA: [s.slice(0, 40), s.slice(40)], RTRNCD: '' });
}

const sample = [
  e(20261120, 800, { bp: '120/70 mmHg Lying', pulse: '80 B/min', pulseSort: 80, glucose: '65 mg/dL', glucSort: 65 }),
  e(20261123, 2300, { bp: '85/38 mmHg Lying', mapBP: '54', mapBPSort: 54, pulse: '125 B/min', pulseSort: 125, oxygen: '88% RA', oxygenSort: 88 }),
  e(20261124, 300, { temperature: '100.6°F', tempSort: 100.6, pain: '6', painSort: 6 }),
  e(20261124, 400, { bp: '190/105 mmHg Sitting', bpMistake: 'Y', pulse: '45 B/min', pulseSort: 45, pulseDuplicate: 'Y' }),
  e(20261124, 1800, { bp: '82/50 mmHg Lying', pulse: '50 B/min', pulseSort: 50, oxygen: '95%', oxygenSort: 95, temperature: '98.0°F', tempSort: 98.0,
    pain: 'Refused/Unable', painSort: -1, glucose: '310 mg/dL', glucSort: 310 }),
];

test('parseVitals joins the JSONDATA chunks', () => {
  assert.equal(V.parseVitals(reply(sample)).length, 5);
  assert.deepEqual(V.parseVitals('{"JSONCOUNT":"0","JSONDATA":[],"RTRNCD":""}'), []);
});

test('latest of each vital with mm/dd hh:mm', () => {
  const r = V.evaluate(V.parseVitals(reply(sample)), now);
  assert.equal(V.latestText(r), 'BP 82/50 (11/24 18:00); SpO2 95% (11/24 18:00); Temp 98.0° (11/24 18:00); HR 50 (11/24 18:00); Pain Refused/Unable (11/24 18:00); MAP 54 (11/23 23:00); Glu 310 (11/24 18:00)');
  assert.deepEqual(r.latest.bp.abnormal, ['SBP ≤ 90']);
  assert.deepEqual(r.latest.pain.abnormal, []); // refused isn't pain
});

test('abnormal readings in the last 24 h only; mistakes and duplicates skipped', () => {
  const r = V.evaluate(sample, now);
  const got = r.abnormal.map(a => `${a.stamp} ${a.reason} ${a.display}`).sort();
  assert.deepEqual(got, [
    '11/23 23:00 DBP ≤ 40 85/38', '11/23 23:00 HR ≥ 120 125', '11/23 23:00 SBP ≤ 90 85/38', '11/23 23:00 SpO2 < 90% 88%',
    '11/24 03:00 Pain reported 6', '11/24 03:00 Temp ≥ 100.4 100.6°',
    '11/24 18:00 Glucose > 300 310', '11/24 18:00 HR ≤ 50 50', '11/24 18:00 SBP ≤ 90 82/50',
  ]);
  assert.equal(r.fever24, true);
  const sbp = V.groupAbnormal(r.abnormal).find(g => g.reason === 'SBP ≤ 90');
  assert.equal(sbp.count, 2);
  assert.equal(sbp.worst.display, '82/50');
  assert.match(V.abnormalText(r), /SBP ≤ 90: 82\/50 at 11\/24 18:00 \(2x\)/);
});

test('fever24 is null with no temperature in 24 h', () => {
  assert.equal(V.evaluate([e(20261120, 800, { temperature: '101.0°F', tempSort: 101 })], now).fever24, null);
  assert.equal(V.evaluate([e(20261124, 800, { temperature: '98.6°F', tempSort: 98.6 })], now).fever24, false);
});

test('Wong-Baker pain counts when above zero', () => {
  const r = V.evaluate([e(20261124, 900, { wong: '4', wongSort: 4 })], now);
  assert.equal(r.latest.pain.value, '4 (Wong)');
  assert.equal(r.abnormal[0].reason, 'Pain reported');
});

test('WBC < 5 becomes a hold with fever, drops without one, stays check with no temps', () => {
  const flags = [{ label: 'WBC', level: 'check', latest: true, value: '4.1', reason: '< 5.0, check for fever' }];
  assert.equal(L.applyFever(flags, true)[0].level, 'hold');
  assert.deepEqual(L.applyFever(flags, false), []);
  assert.equal(L.applyFever(flags, null)[0].level, 'check');
});

test('vitals request body', () => {
  const b = JSON.parse(V.buildVitalsBody({ userId: 'U', token: 'T', facility: '203', account: '203000001', from: 20261117, to: 20261124 }));
  assert.equal(b.name, 'HOHSVTSDJ');
  assert.deepEqual([b.data.PASSWD, b.data.REQUCL, b.data.REQLV6, b.data.REQACC, b.data.REQSDT, b.data.REQEDT], ['T', 'U', 203, 203000001, '20261117', '20261124']);
});
