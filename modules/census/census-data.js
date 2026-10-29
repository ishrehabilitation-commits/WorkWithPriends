/* WorkWithPriends – Census tab data: WellSky query builders, response parsers,
 * the census merge, CSV and the therapy-schedule export for the Excel macro.
 * Pure functions only (no chrome.* calls) so it can be tested in Node.
 * Ported from the WellSky Rehab Census extension v0.3.0 (wellsky.js). */
(function (root) {
  'use strict';

  const RS = '␞'; // record separator WellSky uses between dataHub criteria
  const DATAHUB_URL = '/Interactant/resources/jsp/dataHub.jsp';
  const HXHFRPT_URL = '/Interactant/get/HXHFRPT';
  const ORDERS_URL = '/Interactant/get/HOHORLST';
  const ORDER_PROC_CODES = ['OT001', 'ST001', 'PT001', 'SPCHEVAL'];

  const FACILITIES = [
    { code: '204', name: 'Shreveport' },
    { code: '202', name: 'Pierremont' },
    { code: '203', name: 'Bossier' },
  ];

  // Patient types we can't be consulted on — always hidden.
  const EXCLUDED_TYPES = /respite|hospice/i;

  const PATIENT_FIELDS = ['MMPRMN', 'MMNAME', 'PHY_AM', 'CURPHY_CO', 'MMADDT', 'MMPAGE', 'MMPSEX',
    'MMPAFM', 'MMPAFM_TYP', 'CASE_MAN', 'MMPDTO', 'MMDSST', 'MMDSDT', 'MMPCT1', 'MMACCT'];

  // Initial-eval forms looked up via dataHub (add IRF form names here if they differ).
  const EVAL_FORMS = {
    PT: ['Physical Therapy Initial Evaluation LTCH [E79]'],
    OT: ['Occupational Therapy Initial Evaluation LTCH [E81]'],
    ST: ['SLP Initial Evaluation - LTCH'],
  };

  // HXHFRPT question lookups.
  //  noPickup: "<disc> Requirements:" answered "Not required" (RESP 1) => evaluated, not picked up
  //  fmp:      "<disc> Diagnosis/Assessment:" comment holding FMP / Out of Bed / Group / Team
  const HX_QUESTIONS = {
    PT: { code: 'E79', cat: 1154, noPickup: 9804, fmp: 7824 },
    OT: { code: 'E81', cat: 1153, noPickup: 9803, fmp: 8657 },
    ST: { code: 'S80', cat: 1160, noPickup: 9805 },
  };

  /* ---------- dates ---------- */
  function ymd(d) {
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }
  function daysAgoYmd(days, now = new Date()) {
    const d = new Date(now); d.setDate(d.getDate() - days); return ymd(d);
  }
  function ymdToDate(n) {
    n = Number(n); if (!n) return null;
    return new Date(Math.floor(n / 10000), Math.floor(n / 100) % 100 - 1, n % 100);
  }
  function fmtDate(n) {
    const d = ymdToDate(n); if (!d) return '';
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  }
  function daysBetween(fromYmd, toDate = new Date()) {
    const d = ymdToDate(fromYmd); if (!d) return null;
    const t = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
    return Math.round((t - d) / 86400000);
  }

  /* ---------- dataHub (form-urlencoded) ---------- */
  function buildDataHubBody(q, token) {
    const w = q.where;
    const parts = [
      ['sessionToken', token], ['maxColumns', '100'], ['application', q.application], ['callType', 'I'],
      ['fieldCount', String(q.fields.length)], ['fields', q.fields.join(',')],
      ['whereCount', String(w.length)],
      ['andOr', w.map((c, i) => (i ? c.andOr || 'and' : '')).join(',')],
      ['left', w.map(() => ' ').join(',')],
      ['choose', w.map(c => c.field).join(',')],
      ['action', w.map(c => c.op).join(',')],
      ['criteria', w.map(c => c.value).join(RS)],
      ['criteriaType', w.map(c => c.type || ' ').join(',')],
      ['right', w.map(() => ' ').join(',')],
      ['iMaxCount', '250000'],
    ];
    return parts.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  }

  function patientListQuery(facility, dischargedSinceYmd) {
    return {
      application: 'EMRGEN',
      fields: PATIENT_FIELDS.map(f => 'TMPMAST_' + f),
      where: [
        dischargedSinceYmd
          ? { field: 'TMPMAST_MMDSDT', op: '>=', value: String(dischargedSinceYmd) }
          : { field: 'TMPMAST_MMDSDT', op: '=', value: '0' },
        { field: 'TMPMAST_MMPLV6', op: '=', value: String(facility), type: 'C' },
      ],
    };
  }

  function evalFormQuery(facility, formName) {
    return {
      application: 'EMRFRMHDR',
      fields: ['HMLMAST4L_MMACCT', 'HMLMAST4L_MMPLV6', 'TXPFHDR_FRMCOD_DSC', 'TXPFHDR_FRMABY', 'TXPFHDR_FRMADT'],
      where: [
        { field: 'HMLMAST4L_MMPLV6', op: '=', value: String(facility), type: 'C' },
        { field: 'HMLMAST4L_MMDSDT', op: '=', value: '0' },
        { field: 'TXPFHDR_FRMCOD_DSC', op: '=', value: `'${formName}'`, type: 'D' },
      ],
    };
  }

  // dataHub replies with a JS object literal (unquoted top-level keys) whose `data` is valid JSON.
  function parseDataHub(text) {
    const t = String(text || '').trim();
    const i = t.indexOf('data:');
    if (!t.startsWith('{') || i < 0) throw new Error('Unexpected dataHub reply — WellSky session may have expired.');
    const header = JSON.parse(t.slice(0, i).replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":') + '"_":0}');
    if (header.returnCode) throw new Error('dataHub error: ' + header.returnCode);
    const data = JSON.parse(t.slice(i + 5, t.lastIndexOf('}')));
    return data;
  }

  /* ---------- HXHFRPT (JSON) ---------- */
  function buildHxBody({ userId, token, facility, code, cat, quest, from, to, dateType, account }) {
    return JSON.stringify({
      name: 'HXHFRPT', timeout: 90000,
      data: {
        USERID: userId, PASSWD: token, ILEVEL: 6, ILEVELCODE: Number(facility), IFORMAPP: 'EMR',
        IFROMDATE: String(from), ITODATE: String(to),
        ISELECTS: [{ CODE: code, CAT: cat, QUESTORTABLE: 'Q', QUESTTABLENUM: quest, RESP: 1, COL: 0, ROW: 0,
          BEGINPARENS: '(', ENDPARENS: ')', ANDOR: '' }],
        INUMSELECTS: 1, IROLLUP: 'N', DATETYPE: dateType, INURSESTATION: '',
        IACCOUNT: account ? Number(account) : '',
      },
    });
  }

  function parseHx(text) {
    const j = typeof text === 'string' ? JSON.parse(text) : text;
    if (j.RTRNCD) throw new Error('HXHFRPT error: ' + j.RTRNCD);
    const r = j.ORESULTS;
    return !r ? [] : Array.isArray(r) ? r : [r];
  }

  // "FMP: Yes / Out of Bed: No / Group: No / Team: 2" — WellSky wraps text by inserting spaces, so be lenient.
  function parseFmp(text) {
    const t = String(text || '');
    const yn = (label) => {
      const m = t.match(new RegExp(label + '\\s*:\\s*(y\\s?e\\s?s|n\\s?o)', 'i'));
      return m ? (/^y/i.test(m[1]) ? 'Yes' : 'No') : null;
    };
    const tm = t.match(/Team\s*:\s*(\d)/i);
    // raw = only what the comment actually states (null = not mentioned)
    const raw = { fmp: yn('FMP'), oob: yn('Out\\s?of\\s?Bed'), group: yn('Group'), team: tm ? Number(tm[1]) : null };
    return {
      fmp: raw.fmp || 'No', oob: raw.oob || 'No', group: raw.group || 'No', team: raw.team || 1,
      found: /FMP\s*:/i.test(t), raw,
    };
  }

  /* ---------- orders (HOHORLST) ---------- */
  function buildOrdersBody({ userId, token, facility, to }) {
    return JSON.stringify({
      name: 'HOHORLST', timeout: 90000,
      data: {
        USERID: userId, PASSWD: token, REQLVL: 6, LVLCOD: Number(facility), DATETYPE: 'A', FROMDATE: '', TODATE: String(to),
        REQNST: '', REQACC: '', REQIDX: '', PROCCOD: ORDER_PROC_CODES, PROCCOUNT: ORDER_PROC_CODES.length,
        FREQCOD: '', REQSTATUS: 'A', REQSELECT: '', REQNOORDER: 'ACTIVE', SHOWDISCHARGED: 'N',
      },
    });
  }
  function parseOrders(text) {
    const j = typeof text === 'string' ? JSON.parse(text) : text;
    if (j.RTRNCD) throw new Error('HOHORLST error: ' + j.RTRNCD);
    const r = j.ORDDATA;
    return !r ? [] : Array.isArray(r) ? r : [r];
  }
  // Which discipline an order belongs to, and whether it's a full eval or just a screen.
  function orderInfo(desc) {
    const t = String(desc || '').replace(/<[^>]*>/g, '');
    if (/^\s*PT\b|Physical Therapy/i.test(t)) return { disc: 'PT', kind: 'Eval', text: t };
    if (/^\s*OT\b|Occupational Therapy/i.test(t)) return { disc: 'OT', kind: 'Eval', text: t };
    if (/^\s*(SLP|ST)\b|Speech/i.test(t)) return { disc: 'ST', kind: /screen/i.test(t) ? 'Screen' : 'Eval', text: t };
    return null;
  }
  function ymdhmToDate(s) {
    s = String(s || ''); if (s.length < 8) return null;
    return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +(s.slice(8, 10) || 0), +(s.slice(10, 12) || 0));
  }

  /* ---------- merge ---------- */
  function typeKey(t) {
    t = String(t || '');
    if (/LTCH/i.test(t)) return 'LTCH';
    if (/Rehab/i.test(t)) return 'Rehab';
    if (/BHS|psych|geri/i.test(t)) return 'BHS';
    return 'Other';
  }
  const TYPE_LABEL = { LTCH: 'LTAC', Rehab: 'IRF', BHS: 'Geri-Psych', Other: 'Other' };

  function titleName(n) {
    return String(n || '').toLowerCase().replace(/(^|[\s,'-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
  }

  function latestBy(rows, keyFn, dateFn) {
    const out = new Map();
    for (const r of rows) {
      const k = String(keyFn(r)); const prev = out.get(k);
      if (!prev || Number(dateFn(r)) >= Number(dateFn(prev))) out.set(k, r);
    }
    return out;
  }

  /**
   * src = {
   *   current:   dataHub rows (current patients)
   *   discharges:dataHub rows (discharged since N days)
   *   evals:     { PT: rows, OT: rows, ST: rows }            (dataHub EMRFRMHDR)
   *   noPickup:  { PT: hxRows, OT: hxRows, ST: hxRows }       (optional)
   *   fmp:       { PT: hxRows, OT: hxRows }                   (optional)
   * }
   */
  function mergeData(src, now = new Date()) {
    const D = ['PT', 'OT', 'ST'];
    const evalIdx = {}, noPick = {}, fmpIdx = {};
    const mrn = new Map();
    const orderIdx = { PT: new Map(), OT: new Map(), ST: new Map() };
    for (const o of src.orders || []) {
      if (o.MEDRECNUM) mrn.set(String(o.ACCOUNTNUM), o.MEDRECNUM);
      const info = orderInfo(o.ORDERDESC); if (!info) continue;
      const start = ymdhmToDate(o.ORDERDATETIME || o.STARTDATETIME), end = ymdhmToDate(o.ENDDATETIME);
      const rec = { date: start ? ymd(start) : null, ts: Number(o.ORDERDATETIME || 0), kind: info.kind, text: info.text,
        by: o.ORDERINGCLIN || '', active: !end || end >= now };
      const k = String(o.ACCOUNTNUM), prev = orderIdx[info.disc].get(k);
      // prefer active over ended, full eval over screen, then most recent
      const score = r => (r.active ? 4 : 0) + (r.kind === 'Eval' ? 2 : 0);
      if (!prev || score(rec) > score(prev) || (score(rec) === score(prev) && rec.ts > prev.ts)) orderIdx[info.disc].set(k, rec);
    }
    for (const d of D) {
      evalIdx[d] = latestBy(src.evals?.[d] || [], r => r.MMACCT, r => r.FRMADT);
      noPick[d] = src.noPickup?.[d] ? new Set(src.noPickup[d].map(r => String(r.ACC))) : null;
      for (const r of src.noPickup?.[d] || []) if (r.MRN) mrn.set(String(r.ACC), r.MRN);
    }
    for (const d of ['PT', 'OT']) {
      fmpIdx[d] = src.fmp?.[d] ? latestBy(src.fmp[d], r => r.ACC, r => Number(r.FORMDATE) * 10000 + Number(r.FORMTIME || 0)) : null;
      for (const r of src.fmp?.[d] || []) if (r.MRN) mrn.set(String(r.ACC), r.MRN);
    }

    const patients = (src.current || [])
      .filter(p => !EXCLUDED_TYPES.test(p.MMPCT1 || ''))
      .map(p => {
        const acct = String(p.MMACCT);
        const row = {
          acct, mrn: mrn.get(acct) || '', room: p.MMPRMN || '', name: titleName(p.MMNAME), rawName: p.MMNAME,
          age: p.MMPAGE ?? '', sex: p.MMPSEX || '', type: typeKey(p.MMPCT1), typeRaw: p.MMPCT1 || '',
          physician: p.PHY_AM || '', coPhysician: p.CURPHY_CO || '', caseManager: p.CASE_MAN || '',
          admitDate: p.MMADDT, los: daysBetween(p.MMADDT, now),
          admitFrom: p.MMPAFM || '', admitFromType: p.MMPAFM_TYP || '',
          dcTo: p.MMPDTO || '', dcStatus: p.MMDSST || '', dcDate: p.MMDSDT || 0,
        };
        for (const d of D) {
          const e = evalIdx[d].get(acct);
          const o = orderIdx[d].get(acct) || null;
          row[d] = {
            order: o, ordered: src.orders ? (o ? 'Yes' : 'No') : '?',
            evalDate: e ? e.FRMADT : null, evalBy: e ? e.FRMABY : '',
            caseload: !e ? 'No' : noPick[d] ? (noPick[d].has(acct) ? 'No' : 'Yes') : '?',
          };
        }
        const fp = fmpIdx.PT?.get(acct), fo = fmpIdx.OT?.get(acct);
        const pf = parseFmp(fp?.RESPTEXT), of = parseFmp(fo?.RESPTEXT);
        row.fmpPT = pf.fmp; row.fmpOT = of.fmp;
        row.mobility = pf.oob === 'Yes' || of.oob === 'Yes' ? 'Yes' : 'No';
        row.group = pf.group === 'Yes' || of.group === 'Yes' ? 'Yes' : 'No';
        // FMP patients are Team 3; otherwise only what the eval form states (null = not stated).
        row.team = pf.raw.fmp === 'Yes' || of.raw.fmp === 'Yes' ? 3 : pf.raw.team || of.raw.team || null;
        row.fmpRaw = { PT: pf.raw, OT: of.raw };
        return row;
      })
      .sort((a, b) => a.room.localeCompare(b.room) || a.name.localeCompare(b.name));

    const discharges = (src.discharges || [])
      .filter(p => !EXCLUDED_TYPES.test(p.MMPCT1 || ''))
      .map(p => ({
        acct: String(p.MMACCT), room: p.MMPRMN || '', name: titleName(p.MMNAME), age: p.MMPAGE ?? '', sex: p.MMPSEX || '',
        type: typeKey(p.MMPCT1), physician: p.PHY_AM || '', admitDate: p.MMADDT, dcDate: p.MMDSDT,
        dcTo: p.MMPDTO || '', dcStatus: p.MMDSST || '',
        expired: /expired|died|death/i.test((p.MMDSST || '') + ' ' + (p.MMPDTO || '')),
      }))
      .sort((a, b) => b.dcDate - a.dcDate || a.name.localeCompare(b.name));

    return { patients, discharges };
  }

  /* ---------- CSV ---------- */
  const CENSUS_COLUMNS = [
    ['Account #', r => r.acct], ['Medical Record #', r => r.mrn], ['Room #', r => r.room],
    ['Patient Name', r => r.rawName], ['Age', r => r.age], ['Sex', r => r.sex],
    ['Patient Type', r => TYPE_LABEL[r.type]], ['Physician', r => r.physician], ['Co/Current Physician', r => r.coPhysician],
    ['Case Manager', r => r.caseManager],
    ['PT Order', r => r.PT.order ? `${r.PT.order.kind}${r.PT.order.active ? '' : ' (ended)'}` : r.PT.ordered],
    ['OT Order', r => r.OT.order ? `${r.OT.order.kind}${r.OT.order.active ? '' : ' (ended)'}` : r.OT.ordered],
    ['ST Order', r => r.ST.order ? `${r.ST.order.kind}${r.ST.order.active ? '' : ' (ended)'}` : r.ST.ordered],
    ['OT Caseload', r => r.OT.caseload], ['PT Caseload', r => r.PT.caseload], ['ST Caseload', r => r.ST.caseload],
    ['Group', r => r.group], ['FMP OT', r => r.fmpOT], ['FMP PT', r => r.fmpPT], ['Mobility Team', r => r.mobility],
    ['Team', r => r.team],
    ['Admit Date', r => fmtDate(r.admitDate)], ['Admit Location', r => r.admitFrom],
    ['Discharge Location', r => r.dcTo], ['Discharge Status', r => r.dcStatus], ['Discharge Date', r => fmtDate(r.dcDate)],
    ['PT Eval Date', r => fmtDate(r.PT.evalDate)], ['OT Eval Date', r => fmtDate(r.OT.evalDate)],
    ['ST Eval Date', r => fmtDate(r.ST.evalDate)],
  ];
  const DISCHARGE_COLUMNS = [
    ['Account #', r => r.acct], ['Room #', r => r.room], ['Patient Name', r => r.name], ['Age', r => r.age],
    ['Sex', r => r.sex], ['Patient Type', r => TYPE_LABEL[r.type]], ['Physician', r => r.physician],
    ['Admit Date', r => fmtDate(r.admitDate)], ['Discharge Date', r => fmtDate(r.dcDate)],
    ['Discharge Location', r => r.dcTo], ['Discharge Status', r => r.dcStatus],
  ];
  function toCsv(rows, cols) {
    const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    return '﻿' + [cols.map(c => q(c[0])).join(','), ...rows.map(r => cols.map(c => q(c[1](r))).join(','))].join('\r\n');
  }

  /* ---------- therapy schedule workbook (TSV for the Excel macro) ----------
   * Cell value conventions understood by the VBA importer:
   *   ''            leave the cell as it is
   *   '{CLEAR}'     clear the cell
   *   '{IFBLANK}x'  write x only if the cell is empty
   *   '{LINE1}x'    replace the first line, keep any later lines (Admit/D/C column)
   */
  function properWord(w) {
    return String(w || '').toLowerCase()
      .replace(/(^|[\s'-])([a-z])/g, (m, p, c) => p + c.toUpperCase())
      .replace(/\bMc([a-z])/g, (m, c) => 'Mc' + c.toUpperCase());
  }
  function scheduleName(raw, age, sex) {
    const [last, rest = ''] = String(raw || '').split(',');
    const first = rest.trim().split(/\s+/)[0] || '';
    const sx = String(sex || '').charAt(0).toUpperCase();
    return `${properWord(last.trim())}, ${properWord(first)}` + (age !== '' && age != null ? ` (${age}${sx})` : '');
  }
  const docLast = n => properWord(String(n || '').split(',')[0].trim());
  function scheduleRoom(room) {
    const m = String(room || '').match(/(\d{3}[A-Z])$/i);
    return m ? m[1].toUpperCase() : '';
  }
  function mmdd(n, withYear) {
    const s = fmtDate(n); if (!s) return '';
    return withYear ? s.slice(0, 6) + s.slice(8) : s.slice(0, 5);
  }

  function scheduleRow(r) {
    const disc = d => {
      const x = r[d];
      if (x.caseload === 'Yes') return 'Y';
      if (x.evalDate && x.caseload === 'No') return `No\n${d}`;
      if (x.evalDate) return '';                       // pickup unknown
      if (x.order && x.order.active) return 'Y';      // new eval ordered
      return x.ordered === '?' ? '' : 'N';
    };
    const fmp = d => {
      if (r[d].caseload === 'Yes') return '{CLEAR}';
      const v = r.fmpRaw?.[d]?.fmp;
      return v === 'Yes' ? 'Y' : v === 'No' ? 'N' : '';
    };
    // Group and Team are only written when the eval form says so (FMP means Team 3);
    // otherwise the cell is left as it is.
    const groups = [r.fmpRaw?.PT, r.fmpRaw?.OT].filter(Boolean).map(x => x.group).filter(Boolean);
    const group = groups.length ? (groups.includes('Yes') ? 'Y' : 'N') : '';
    const team = r.team ? String(r.team) : '';
    const evals = ['PT', 'OT', 'ST'].map(d => r[d].evalDate).filter(Boolean).map(Number);
    const docs = [...new Set([docLast(r.physician), docLast(r.coPhysician)].filter(Boolean))];
    return {
      room: scheduleRoom(r.room), acct: r.acct,
      A: scheduleName(r.rawName, r.age, r.sex),
      C: docs.join('\n'),
      F: disc('OT'), G: disc('PT'), H: disc('ST'),
      I: group, J: fmp('OT'), K: fmp('PT'), M: team,
      N: r.admitDate ? '{LINE1}' + mmdd(r.admitDate, true) : '',
      P: evals.length ? mmdd(Math.min(...evals)) : '',
    };
  }
  const SCHEDULE_COLS = ['room', 'A', 'C', 'F', 'G', 'H', 'I', 'J', 'K', 'M', 'N', 'P', 'acct'];
  function scheduleTsv(patients, facility, now = new Date()) {
    const esc = v => String(v ?? '').replace(/\\/g, '\\\\').replace(/\t/g, ' ').replace(/\r?\n/g, '\\n');
    const rows = patients.map(scheduleRow);
    return [`#WELLSKY-SCHEDULE\tv1\t${facility}\t${now.toISOString()}`, SCHEDULE_COLS.join('\t'),
      ...rows.map(r => SCHEDULE_COLS.map(c => esc(r[c])).join('\t'))].join('\r\n');
  }

  const api = {
    RS, DATAHUB_URL, HXHFRPT_URL, ORDERS_URL, buildOrdersBody, parseOrders, orderInfo, FACILITIES, EVAL_FORMS, HX_QUESTIONS, PATIENT_FIELDS, TYPE_LABEL,
    ymd, daysAgoYmd, fmtDate, daysBetween, buildDataHubBody, patientListQuery, evalFormQuery, parseDataHub,
    buildHxBody, parseHx, parseFmp, scheduleRow, scheduleTsv, scheduleName, scheduleRoom, mergeData, typeKey, toCsv, CENSUS_COLUMNS, DISCHARGE_COLUMNS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WWPCensus = api;
})(typeof self !== 'undefined' ? self : this);
