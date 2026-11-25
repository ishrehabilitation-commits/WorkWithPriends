// Made-up orders only. Never put real patient data in tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const O = require('../concern-orders.js');

const now = new Date(2026, 10, 24, 22, 0);
const o = (name, date, time, status = 'Open', desc = name) => ({ ORDERPROCDESC: name, ORDERDATE: String(date), ORDERTIME: String(time), STATUS: status, DESCRIPTION: `<b>${desc}</b>`, CLINICIAN: 'Doe, Pat NP' });

test('matches the watch list by order name within 48 hours', () => {
  const list = O.evaluate([
    o('X-RAY CHEST SINGLE VIEW', 20261124, 815, 'Completed'),
    o('Arterial Blood Gas (ABG)', 20261123, 600, 'Discontinued: 11/23/2026 10:04'),
    o('Q2H Restraint Check', 20261123, 2300),
    o('Restraint Placement', 20261122, 2201),
    o('VENOUS LOWER BILATERAL', 20261124, 1300),
    o('X-RAY ABDOMEN 1 VIEW', 20261122, 2159),           // 48h 1m ago: out
    o('0.9 % Sodium Chloride', 20261124, 900, 'Open', 'Infuse intravenously'), // "venous" only in the description
    o('Weaning Trial', 20261124, 1031),
  ], now);
  assert.deepEqual(list.map(x => [x.label, x.stamp, x.stopped]), [
    ['Venous doppler', '11/24 13:00', false], ['X-ray', '11/24 08:15', false], ['Restraints', '11/23 23:00', false],
    ['ABG', '11/23 06:00', true], ['Restraints', '11/22 22:01', false],
  ]);
  assert.match(O.csvText(list), /^VENOUS LOWER BILATERAL \(11\/24 13:00, Open\); X-RAY CHEST SINGLE VIEW/);
});

test('parseOrders and request body', () => {
  assert.equal(O.parseOrders('{"LOACDATA":[{"ORDER":"1"}],"RTRNCD":""}').length, 1);
  assert.deepEqual(O.parseOrders('{"RTRNCD":""}'), []);
  const b = JSON.parse(O.buildOrdersBody({ userId: 'U', token: 'T', facility: '204', account: '204000001' }));
  assert.deepEqual([b.name, b.data.PASSWD, b.data.PTLVL6, b.data.PTACCN, b.data.REQHISTORY], ['HOHLOAC', 'T', 204, 204000001, 'Y']);
});
