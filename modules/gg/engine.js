/*
 * IRF GG Review – data engine (runs in the page's MAIN world).
 * Pulls patients (HOHSRCH) and PT/OT form responses (HXHFRPT) through the app's
 * own HCS.load(), which adds the session credentials, then flags:
 *   DISCREPANCY   same item, same note, different scores
 *   PT vs OT      same item scored differently by PT and OT on the same day
 *   DECLINED / IMPROVED / NOT PERFORMED   change vs the discipline's previous score
 * Each flag carries "actions" with a target note + fields for the navigator.
 */
(() => {
  const CFG = {
    patientType: /inpatient rehab/i,
    worklist: {               // HOHSRCH params (same as the EMR Work List defaults)
      REQSEARCHTYPE: 'C', REQLVL6: 204, REQUSER: '', REQALERT: null, REQSEVR: null,
      REQCLASS: null, REQVIEW: 'D', REQSEARCHBY: 'A', REQNSTN: null, REQMEDCART: 0,
      REQNAME: '', REQACCT: null, REQMRNO: null, REQDISCH: 'N', REQDISCHDAY: '',
      REQACTIVE: 'Y', REQPREADMIT: 'N', REQINHOUSE: 'Y', REQOUTPATIENT: 'N',
      REQPHYTYPE: 'A', INCLUDEPHOTO: 'N',
    },
    level: 6,                 // Facility
    facility: 204,            // Intensive Specialty Shreveport [204]
    dateType: 'F',            // A=Answered, F=Form Date, M=Admission, D=Discharge
    filters: [                // [form code, category]
      ['E79', 1123], ['E79', 1023], ['E79', 1126],               // PT Evaluation
      ['E50', 1025], ['E50', 1126], ['E50', 1026],               // PT Note - LTCH
      ['E81', 1027], ['E81', 1122], ['E81', 1128],               // OT Initial Eval LTCH
      ['L84', 1028], ['L84', 1128], ['L84', 1169], ['L84', 1029], // OT Note - LTCH
    ],
    discipline: { E79: 'PT', E50: 'PT', E81: 'OT', L84: 'OT' },
    crossDays: 0,             // PT vs OT compared on the same calendar day (1 = ±1 day)
  };

  const NOT_SCORED = {
    '07': 'Patient refused',
    '09': 'Not applicable / not previously performed',
    '10': 'Not attempted – environmental limitation',
    '88': 'Not attempted – medical condition/safety',
  };

  const ymd = d => Ext.Date.format(d, 'Ymd');
  const fmt = (d, t) => Ext.Date.format(d, 'm/d/y') + (t ? ' ' + Ext.Date.format(t, 'H:i') : '');
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const ALIASES = [
    [/\bft\b/g, 'feet'], [/\b2\b/g, 'two'],
    [/^lying sit on bedside$/, 'lying to sitting on side of bed'],
    [/^toileting transfer$/, 'toilet transfer'],
  ];
  const label = s => {
    let x = String(s).replace(/discharge goal/i, '').replace(/^[\s:\-]+/, '').split(':')[0];
    x = norm(x);
    ALIASES.forEach(([re, to]) => { x = x.replace(re, to); });
    return x.replace(/\s+/g, ' ').trim();
  };
  const codeOf = txt => (String(txt).match(/^\s*(\d{2})\b/) || [])[1] || null;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const load = (model, params) => new Promise((resolve, reject) => HCS.load(model, {
    params,
    success: resp => resp.ERRORS().getCount()
      ? reject(new Error(model + ': ' + JSON.stringify(resp.ERRORS().getAt(0).data)))
      : resolve(resp),
    failure: () => reject(new Error(model + ' request failed')),
  }));

  // ---------- Patients (HOHSRCH) ----------
  async function getRehabPatients(overrides = {}) {
    const resp = await load('HOHSRCH', { ...CFG.worklist, ...overrides });
    return resp.GRIDDATA().getRange()
      .filter(r => CFG.patientType.test(r.get('GRIDCAT1')))
      .map(r => ({
        name: r.get('GRIDNAME'), account: r.get('GRIDACCT'), mrn: r.get('GRIDMRNO'),
        lv6: r.get('GRIDLVL6N') || CFG.facility, admit: r.get('GRIDADMIT'), room: r.get('GRIDROOM'),
      }));
  }

  // ---------- Form responses (HXHFRPT) ----------
  async function search(patient, fromDate = patient.admit, toDate = new Date()) {
    const ISELECTS = CFG.filters.map(([CODE, CAT], i) => ({
      CODE, CAT, BEGINPARENS: '(', ENDPARENS: ')', ANDOR: i ? 'O' : '',
    }));
    const resp = await load('HXHFRPT', {
      ILEVEL: CFG.level, ILEVELCODE: CFG.facility, IFORMAPP: 'EMR',
      IFROMDATE: ymd(fromDate), ITODATE: ymd(toDate),
      ISELECTS, INUMSELECTS: ISELECTS.length, IROLLUP: 'N',
      DATETYPE: CFG.dateType, INURSESTATION: '', IACCOUNT: patient.account,
    });
    const Q = resp.OQUESTS(), T = resp.OTABLES(), F = resp.OFORMCODES(), C = resp.OCATS();
    const desc = (s, k, v) => (s.findExactRecord(k, v) || { get: () => '' }).get('DESCRIPTION');
    return resp.ORESULTS().getRange().map(r => {
      const isQ = r.get('QUESTORTABLE') === 'Q';
      const question = desc(isQ ? Q : T, 'NUMBER', r.get('QUESTTABLENUM'));
      return {
        discipline: CFG.discipline[r.get('FORMCODE')] || r.get('FORMCODE'),
        formCode: r.get('FORMCODE'), form: desc(F, 'CODE', r.get('FORMCODE')),
        cat: r.get('CAT'), category: desc(C, 'NUMBER', r.get('CAT')),
        qNum: r.get('QUESTTABLENUM'), question, response: r.get('RESPTEXT'),
        code: codeOf(r.get('RESPTEXT')),
        formDate: r.get('FORMDATE'), formTime: r.get('FORMTIME'), formSeq: r.get('FORMSEQ'),
        when: fmt(r.get('FORMDATE'), r.get('FORMTIME')),
        sortKey: ymd(r.get('FORMDATE')) + Ext.Date.format(r.get('FORMTIME') || new Date(0), 'Hi'),
        isGoal: /discharge goal/i.test(question),
        item: label(question),
      };
    });
  }

  // A navigator target: which note to open and which fields to highlight (with messages)
  const target = (patient, inst, steps) => ({
    patient: { name: patient.name, account: patient.account, mrn: patient.mrn, lv6: patient.lv6 },
    discipline: inst.discipline, formCode: inst.formCode, form: inst.form,
    noteDate: ymd(inst.formDate), noteTime: Ext.Date.format(inst.formTime, 'Hi'), when: inst.when,
    steps,                                   // [{ cat, qNum, html }]
  });

  // ---------- Analysis ----------
  function analyze(rows, patient) {
    const perf = rows.filter(r => !r.isGoal && r.code);
    const flags = [];
    const short = r => r.question.split(':')[0];

    const byInstance = {};
    perf.forEach(r => {
      const k = [r.formCode, r.sortKey, r.formSeq, r.item].join('|');
      (byInstance[k] = byInstance[k] || []).push(r);
    });

    // a) Same note, same item, different scores
    Object.values(byInstance).forEach(g => {
      if (new Set(g.map(r => r.code)).size < 2) return;
      const steps = g.map(r => ({
        cat: r.cat, qNum: r.qNum, code: r.code,
        suggest: [...new Map(g.filter(o => o.code !== r.code).map(o => [o.code, { code: o.code, why: o.category }])).values()],
        html: `<b>Discrepancy</b> – scored <b>${r.code}</b> here (${esc(r.category)}), but ` +
          g.filter(o => o !== r).map(o => `<b>${o.code}</b> under <b>${esc(o.category)}</b>`).join(', ') +
          ` in this same note.`,
      }));
      flags.push({
        type: 'DISCREPANCY', disc: g[0].discipline, when: g[0].when, item: short(g[0]),
        detail: g.map(r => `${r.category} = ${r.code}`).join('  vs  '),
        actions: [{ label: `Open ${g[0].discipline} note`, target: target(patient, g[0], steps) }],
      });
    });

    // One value per item per note (lowest if conflicted); keep the rows for highlighting
    const instances = Object.values(byInstance).map(g => ({ ...g[0], code: g.map(x => x.code).sort()[0], group: g }));
    // suggest = the values offered by the callout's "Change to" buttons
    const stepsFor = (inst, html, suggest = []) => inst.group.map(r => ({
      cat: r.cat, qNum: r.qNum, code: r.code, html, suggest: suggest.filter(x => x.code !== r.code) }));

    // b) PT vs OT
    const day = r => Ext.Date.clearTime(r.formDate, true).getTime();
    const pt = instances.filter(r => r.discipline === 'PT'), ot = instances.filter(r => r.discipline === 'OT');
    pt.forEach(a => ot.forEach(b => {
      if (a.item !== b.item || a.code === b.code) return;
      if (Math.abs(day(a) - day(b)) > CFG.crossDays * 864e5) return;
      flags.push({
        type: 'PT vs OT', disc: 'PT/OT', when: a.when.slice(0, 8), item: short(a),
        detail: `PT ${a.code} (${a.when}) vs OT ${b.code} (${b.when})`,
        actions: [
          { label: 'Fix PT note', target: target(patient, a, stepsFor(a,
            `<b>PT vs OT</b> – PT scored <b>${a.code}</b> here.<br>Scored by OT as <b>${b.code}</b> on ${b.when} (${esc(b.category)}).`, [{ code: b.code, why: 'OT' }])) },
          { label: 'Fix OT note', target: target(patient, b, stepsFor(b,
            `<b>PT vs OT</b> – OT scored <b>${b.code}</b> here.<br>Scored by PT as <b>${a.code}</b> on ${a.when} (${esc(a.category)}).`, [{ code: a.code, why: 'PT' }])) },
        ],
      });
    }));

    // c) Trend per discipline
    const timeline = {};
    instances.forEach(r => { const k = r.discipline + '|' + r.item; (timeline[k] = timeline[k] || []).push(r); });
    const summary = [];
    Object.values(timeline).forEach(list => {
      list.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
      const name = short(list[0]), disc = list[0].discipline;
      let last = null;
      list.forEach(r => {
        const scored = +r.code >= 1 && +r.code <= 6;
        if (!scored) {
          if (last) flags.push({
            type: 'NOT PERFORMED', disc, when: r.when, item: name,
            detail: `${r.code} ${NOT_SCORED[r.code] || ''} (was ${last.code} on ${last.when})`,
            actions: [{ label: `Open ${disc} note`, target: target(patient, r, stepsFor(r,
              `<b>Not performed</b> – coded <b>${r.code}</b> (${NOT_SCORED[r.code] || ''}).<br>Was <b>${last.code}</b> on ${last.when}.`, [{ code: last.code, why: 'previous' }])) }],
          });
          return;
        }
        if (last && r.code !== last.code) {
          const up = +r.code > +last.code;
          flags.push({
            type: up ? 'IMPROVED' : 'DECLINED', disc, when: r.when, item: name,
            detail: `${last.code} (${last.when}) → ${r.code}`,
            actions: [{ label: `Open ${disc} note`, target: target(patient, r, stepsFor(r,
              `<b>${up ? 'Improvement' : 'Decline'}</b> – scored <b>${r.code}</b> here.<br>Was <b>${last.code}</b> on ${last.when}.`, [{ code: last.code, why: 'previous' }])) }],
          });
        }
        last = r;
      });
      const goal = rows.find(g => g.isGoal && g.item === list[0].item && g.discipline === disc);
      summary.push({
        disc, item: name, history: list.map(r => `${r.when.slice(0, 5)}:${r.code}`).join('  '),
        latest: list[list.length - 1].code, dcGoal: goal ? goal.code || goal.response : '',
        goalMet: goal && goal.code && last ? (+last.code >= +goal.code ? 'Yes' : 'No') : '',
      });
    });
    const order = { DISCREPANCY: 0, 'PT vs OT': 1, DECLINED: 2, 'NOT PERFORMED': 3, IMPROVED: 4 };
    flags.sort((a, b) => order[a.type] - order[b.type] || b.when.localeCompare(a.when));
    summary.sort((a, b) => a.item.localeCompare(b.item) || a.disc.localeCompare(b.disc));
    return { flags, summary };
  }

  async function run({ all = true, index = 0 } = {}) {
    const patients = await getRehabPatients();
    const list = all ? patients : [patients[index]].filter(Boolean);
    const out = [];
    for (const p of list) {
      const rows = await search(p);
      out.push({ patient: p, from: fmt(p.admit), rows, ...analyze(rows, p) });
    }
    window.__irfResults = out;
    return out;
  }

  window.IRFReview = { run, getRehabPatients, search, analyze, load, CFG };
})();
