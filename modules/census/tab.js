/*
 * WorkWithPriends – Census tab (extension world).
 * Current patients at the header's facility with their PT/OT/ST orders, evals,
 * caseload pickup, FMP / Mobility Team / Group / Team, plus recent discharges.
 * Exports a census CSV, a discharges CSV, and the therapy-schedule data that the
 * Excel macro in modules/census/excel/ reads (UpdateFromWellSky).
 * The WellSky calls are same-origin from this tab, using the signed-in session.
 * Ported from the WellSky Rehab Census extension v0.3.0 (dashboard.js);
 * the queries, merge and exports live in census-data.js (WWPCensus).
 */
(() => {
  const WS = window.WWPCensus;
  const TYPES = [['LTCH', 'LTAC'], ['Rehab', 'IRF'], ['BHS', 'Geri-Psych'], ['Other', 'Other']];
  const DISC = ['PT', 'OT', 'ST'];

  // ------------------------------------------------------------------ //
  //  WellSky session and requests                                       //
  // ------------------------------------------------------------------ //

  async function getSession() {
    const s = await chrome.runtime.sendMessage({ type: 'wwp:getSession' });
    if (!s?.token) throw new Error('No WellSky session found in this tab. Log in to WellSky, then refresh.');
    return s;
  }

  // HCS.userId only exists in the page's own world; page-bridge.js reads it.
  function getUserId() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { document.removeEventListener('wwp:userId', onAnswer); reject(new Error("Couldn't read your WellSky user ID. Reload the WellSky tab and try again.")); }, 2000);
      function onAnswer(e) {
        clearTimeout(timer);
        document.removeEventListener('wwp:userId', onAnswer);
        e.detail ? resolve(String(e.detail)) : reject(new Error("WellSky hasn't finished signing you in yet. Wait for it to load, then refresh."));
      }
      document.addEventListener('wwp:userId', onAnswer);
      document.dispatchEvent(new CustomEvent('wwp:getUserId'));
    });
  }

  async function post(url, contentType, body) {
    try {
      const res = await fetch(location.origin + url, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': contentType, 'X-Requested-With': 'XMLHttpRequest', Accept: '*/*' },
        body,
      });
      return { ok: res.ok, status: res.status, text: await res.text() };
    } catch (e) {
      return { ok: false, status: 0, text: String(e) };
    }
  }
  const dataHub = (q, token) => post(WS.DATAHUB_URL, 'application/x-www-form-urlencoded; charset=UTF-8', WS.buildDataHubBody(q, token));
  const json = (url, body) => post(`${url}?t=${Date.now()}`, 'application/json', body);

  // Same two passes as the standalone census: patient lists, evals and orders,
  // then caseload pickup and FMP from HXHFRPT.
  async function loadCensus(fac, dcDays, setStatus) {
    const { token } = await getSession();
    const userId = await getUserId();
    const today = WS.ymd(new Date());

    setStatus('Pulling census, discharges and evaluations…');
    const evalReqs = DISC.flatMap(d => WS.EVAL_FORMS[d].map(f => ({ d, q: WS.evalFormQuery(fac, f) })));
    const [cur, dc, ord, ...ev] = await Promise.all([
      dataHub(WS.patientListQuery(fac), token),
      dataHub(WS.patientListQuery(fac, WS.daysAgoYmd(dcDays)), token),
      json(WS.ORDERS_URL, WS.buildOrdersBody({ userId, token, facility: fac, to: today })),
      ...evalReqs.map(e => dataHub(e.q, token)),
    ]);
    const current = WS.parseDataHub(cur.text);
    const discharges = WS.parseDataHub(dc.text);
    const evals = { PT: [], OT: [], ST: [] };
    evalReqs.forEach((e, i) => evals[e.d].push(...WS.parseDataHub(ev[i].text)));
    const warnings = [];
    let orders = null;
    try { orders = WS.parseOrders(ord.text); } catch { warnings.push('Orders: could not load'); }

    setStatus('Checking caseload pickup and FMP…');
    const admits = current.map(p => Number(p.MMADDT)).filter(Boolean);
    const from = admits.length ? Math.min(...admits) : today;
    const Q = WS.HX_QUESTIONS;
    const hx = (d, quest, dateType, opts = {}) => json(WS.HXHFRPT_URL, WS.buildHxBody({
      userId, token, facility: fac, code: Q[d].code, cat: Q[d].cat, quest,
      from: opts.from || from, to: today, dateType, account: opts.account,
    }));
    const safeHx = (r, label) => {
      try { if (!r.ok) throw new Error(`HTTP ${r.status}`); return WS.parseHx(r.text); }
      catch (e) { warnings.push(`${label}: ${e.message}`); return null; }
    };
    const p2 = await Promise.all([
      hx('PT', Q.PT.noPickup, 'A'), hx('OT', Q.OT.noPickup, 'A'), hx('ST', Q.ST.noPickup, 'A'),
      hx('PT', Q.PT.fmp, 'F'), hx('OT', Q.OT.fmp, 'F'),
    ]);
    const noPickup = { PT: safeHx(p2[0], 'PT pickup'), OT: safeHx(p2[1], 'OT pickup'), ST: safeHx(p2[2], 'ST pickup') };
    const fmp = { PT: safeHx(p2[3], 'PT FMP'), OT: safeHx(p2[4], 'OT FMP') };

    // If a bulk FMP pull failed, ask per evaluated account from its eval date.
    for (const d of ['PT', 'OT']) {
      if (fmp[d]) continue;
      const accts = evals[d].filter(e => current.some(p => String(p.MMACCT) === String(e.MMACCT)));
      const res = await Promise.all(accts.map(e => hx(d, Q[d].fmp, 'F', { from: e.FRMADT, account: e.MMACCT })));
      fmp[d] = res.flatMap(r => { try { return WS.parseHx(r.text); } catch { return []; } });
    }

    return { ...WS.mergeData({ current, discharges, evals, noPickup, fmp, orders: orders || undefined }), warnings };
  }

  // ------------------------------------------------------------------ //
  //  Tab                                                                //
  // ------------------------------------------------------------------ //

  WWP.addTab({ id: 'census', label: 'Census', init });

  function init(view, ctx) {
    const { esc } = ctx;
    const settings = { dcDays: 7, types: TYPES.map(([k]) => k) };
    const state = { patients: [], discharges: [], sort: { key: 'room', dir: 1 }, loaded: false, busy: false, facility: null };

    view.classList.add('census');
    view.innerHTML = `
      <form class="controls">
        <button type="submit" class="primary">Refresh</button>
        <label>D/C window <input name="dcDays" type="number" min="1" max="60"></label>
        <span class="cz-types">${TYPES.map(([k, l]) => `<label><input type="checkbox" name="type" value="${k}"> ${l}</label>`).join('')}</span>
        <label>Search <input name="search" type="search" placeholder="Name, room, acct, MD"></label>
      </form>
      <div class="controls cz-exports">
        <button type="button" data-a="csv">Census CSV</button>
        <button type="button" data-a="csvDc">Discharges CSV</button>
        <button type="button" data-a="sched" title="Copies the data for the Excel macro UpdateFromWellSky">Copy for Schedule</button>
        <button type="button" data-a="schedFile" title="Same data as a file, if the clipboard doesn't work">Schedule file</button>
      </div>
      <p class="status" role="status"></p>
      <div class="view">
        <div class="cz-stats"></div>
        <div class="scroll"><table class="cz-census">
          <thead><tr>
            <th data-key="room">Room</th><th data-key="name">Patient</th><th data-key="type">Type</th>
            <th data-key="admit">Admit / From</th><th data-key="physician">Physician</th><th>Case Mgr</th>
            <th>PT</th><th>OT</th><th>ST</th>
            <th class="c" title="Mobility Team (Out of Bed)">Mobility</th><th class="c">Group</th><th class="c" data-key="team">Team</th>
            <th>D/C plan</th>
          </tr></thead>
          <tbody><tr><td colspan="13" class="cz-empty">Refresh to load the census.</td></tr></tbody>
        </table></div>
        <h2 class="cz-dctitle">Recent discharges</h2>
        <div class="scroll"><table class="cz-dc">
          <thead><tr><th>D/C</th><th>Patient</th><th>Room</th><th>Type</th><th>Admit</th><th>Discharged to</th></tr></thead>
          <tbody></tbody>
        </table></div>
      </div>`;

    const $ = s => view.querySelector(s);
    const statusEl = $('.status');
    const setStatus = (msg, err) => { statusEl.textContent = msg || ''; statusEl.classList.toggle('error', !!err); };
    const short = n => WS.fmtDate(n).slice(0, 5);
    const yn = v => v === 'Yes' ? '<span class="cz-yn yes">Yes</span>' : v === 'No' ? '<span class="cz-yn no">No</span>' : '<span class="cz-yn unk">?</span>';
    const needsEval = (r, d) => r[d].order && r[d].order.active && !r[d].evalDate;

    function visiblePatients() {
      const q = $('[name=search]').value.trim().toLowerCase();
      const { key, dir } = state.sort;
      const val = r => ({ room: r.room, name: r.name, type: r.type, admit: Number(r.admitDate), physician: r.physician, team: r.team })[key];
      return state.patients
        .filter(r => settings.types.includes(r.type))
        .filter(r => !q || [r.name, r.room, r.acct, r.mrn, r.physician, r.caseManager].join(' ').toLowerCase().includes(q))
        .sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * dir || a.room.localeCompare(b.room); });
    }

    function orderLine(o) {
      if (!o) return '';
      return `<div class="cz-ord${o.active ? '' : ' ended'}" title="${esc(o.text)} (${esc(o.by)})">${o.kind === 'Screen' ? 'Screen' : 'Order'} ${esc(short(o.date))}${o.active ? '' : ' (ended)'}</div>`;
    }

    function discCell(r, d) {
      const x = r[d];
      if (!x.evalDate) {
        if (needsEval(r, d)) return `<td class="cz-disc alert">${orderLine(x.order)}<span class="cz-tag need">Needs ${x.order.kind === 'Screen' ? 'screen' : 'eval'}</span></td>`;
        return `<td class="cz-disc">${orderLine(x.order) || `<span class="cz-muted">${x.ordered === 'No' ? 'No order' : 'No eval'}</span>`}</td>`;
      }
      const fmp = d === 'PT' ? r.fmpPT : d === 'OT' ? r.fmpOT : null;
      return `<td class="cz-disc">${orderLine(x.order)}<div title="${esc(x.evalBy)}">Eval ${esc(short(x.evalDate))}</div>
        <div class="cz-tags">${x.caseload === 'Yes' ? '<span class="cz-tag on">Caseload</span>' : x.caseload === 'No' ? '<span class="cz-tag off">Not picked up</span>' : '<span class="cz-tag">?</span>'}
        ${fmp === 'Yes' ? '<span class="cz-tag fmp">FMP</span>' : ''}</div></td>`;
    }

    function render() {
      const all = state.patients;
      const count = t => all.filter(r => r.type === t).length;
      ctx.setCount(all.filter(r => settings.types.includes(r.type) && DISC.some(d => needsEval(r, d))).length);
      if (!state.loaded) return;

      $('.cz-stats').innerHTML = [
        ['Census', all.length], ['LTAC', count('LTCH')], ['IRF', count('Rehab')], ['Geri-Psych', count('BHS')],
        ['Needs eval', all.filter(r => settings.types.includes(r.type) && DISC.some(d => needsEval(r, d))).length],
        ['PT caseload', all.filter(r => r.PT.caseload === 'Yes').length],
        ['OT caseload', all.filter(r => r.OT.caseload === 'Yes').length],
        ['ST caseload', all.filter(r => r.ST.caseload === 'Yes').length],
        ['FMP', all.filter(r => r.fmpPT === 'Yes' || r.fmpOT === 'Yes').length],
        [`D/C last ${settings.dcDays}d`, state.discharges.length],
      ].map(([l, n]) => `<div class="cz-stat"><b>${n}</b><span>${esc(l)}</span></div>`).join('');

      $('.cz-census tbody').innerHTML = visiblePatients().map(r => `
        <tr class="t-${r.type}">
          <td class="cz-room">${esc(r.room || '—')}</td>
          <td><div class="cz-name">${esc(r.name)}</div>
            <div class="cz-sub">${esc(r.age)}${esc(r.sex[0] || '')} · Acct ${esc(r.acct)}${r.mrn ? ' · MRN ' + esc(r.mrn) : ''}</div></td>
          <td><span class="cz-type">${esc(WS.TYPE_LABEL[r.type])}</span></td>
          <td><div>${esc(short(r.admitDate))} <span class="cz-muted">· day ${esc(r.los)}</span></div>
            <div class="cz-sub" title="${esc(r.admitFromType)}">${esc(r.admitFrom || '—')}</div></td>
          <td><div>${esc(r.physician || '—')}</div><div class="cz-sub">${esc(r.coPhysician)}</div></td>
          <td>${esc(r.caseManager || '—')}</td>
          ${discCell(r, 'PT')}${discCell(r, 'OT')}${discCell(r, 'ST')}
          <td class="c">${yn(r.mobility)}</td><td class="c">${yn(r.group)}</td><td class="c cz-team">${esc(r.team)}</td>
          <td>${r.dcStatus || r.dcTo ? `<div>${esc(r.dcTo || '—')}</div><div class="cz-sub">${esc(r.dcStatus)}</div>` : '<span class="cz-muted">—</span>'}</td>
        </tr>`).join('') || '<tr><td colspan="13" class="cz-empty">No patients match.</td></tr>';

      $('.cz-dc tbody').innerHTML = state.discharges.map(r => `
        <tr class="${r.expired ? 'expired' : ''}">
          <td>${esc(short(r.dcDate))}</td>
          <td><div class="cz-name">${esc(r.name)}</div><div class="cz-sub">${esc(r.age)}${esc(r.sex[0] || '')} · Acct ${esc(r.acct)}</div></td>
          <td>${esc(r.room)}</td><td><span class="cz-type">${esc(WS.TYPE_LABEL[r.type])}</span></td>
          <td>${esc(short(r.admitDate))}</td><td><div>${esc(r.dcTo || '—')}</div><div class="cz-sub">${esc(r.dcStatus)}</div></td>
        </tr>`).join('') || '<tr><td colspan="6" class="cz-empty">No discharges in this window.</td></tr>';
      $('.cz-dctitle').textContent = `Recent discharges (last ${settings.dcDays} days)`;

      view.querySelectorAll('.cz-census th[data-key]').forEach(th => {
        th.dataset.sorted = th.dataset.key === state.sort.key ? (state.sort.dir > 0 ? 'asc' : 'desc') : '';
      });
    }

    async function refresh() {
      if (state.busy) return;
      state.busy = true;
      $('button[type=submit]').disabled = true;
      const fac = ctx.facility();
      try {
        const res = await loadCensus(fac, settings.dcDays, setStatus);
        Object.assign(state, { patients: res.patients, discharges: res.discharges, loaded: true, facility: fac });
        render();
        const at = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        setStatus(`Updated ${at}${res.warnings.length ? ' · ' + res.warnings.join('; ') : ''}`, res.warnings.length > 0);
      } catch (e) {
        setStatus(e.message, true);
      } finally {
        state.busy = false;
        $('button[type=submit]').disabled = false;
      }
    }

    function download(name, text, type = 'text/csv;charset=utf-8') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    const stamp = () => `${state.facility}_${WS.ymd(new Date())}`;
    const schedText = () => WS.scheduleTsv(state.patients, state.facility);

    const saveSettings = () => chrome.storage.sync.set({ census: settings });
    view.addEventListener('submit', e => { e.preventDefault(); refresh(); });
    view.addEventListener('input', e => { if (e.target.name === 'search') render(); });
    view.addEventListener('change', e => {
      if (e.target.name === 'dcDays') {
        settings.dcDays = Math.min(60, Math.max(1, Number(e.target.value) || 7));
        e.target.value = settings.dcDays;
        saveSettings();
        if (state.loaded) refresh();
      }
      if (e.target.name === 'type') {
        settings.types = [...view.querySelectorAll('[name=type]:checked')].map(c => c.value);
        saveSettings();
        render();
      }
    });
    view.addEventListener('click', async e => {
      const th = e.target.closest('.cz-census th[data-key]');
      if (th) {
        const k = th.dataset.key;
        state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 };
        render();
        return;
      }
      const a = e.target.closest('button[data-a]')?.dataset.a;
      if (!a) return;
      if (!state.loaded) { setStatus('Nothing loaded yet. Click Refresh first.', true); return; }
      if (a === 'csv') download(`census_${stamp()}.csv`, WS.toCsv(visiblePatients(), WS.CENSUS_COLUMNS));
      if (a === 'csvDc') download(`discharges_${stamp()}.csv`, WS.toCsv(state.discharges, WS.DISCHARGE_COLUMNS));
      if (a === 'schedFile') download(`wellsky_schedule_${stamp()}.txt`, schedText(), 'text/plain;charset=utf-8');
      if (a === 'sched') {
        try {
          await navigator.clipboard.writeText(schedText());
          setStatus(`Copied ${state.patients.length} patients. In Excel run UpdateFromWellSky (Alt+F8).`);
        } catch {
          setStatus('The clipboard is blocked here. Use "Schedule file" instead.', true);
        }
      }
    });
    ctx.onFacilityChange(() => { if (state.loaded) refresh(); });

    chrome.storage.sync.get('census').then(({ census }) => {
      Object.assign(settings, census || {});
      $('[name=dcDays]').value = settings.dcDays;
      view.querySelectorAll('[name=type]').forEach(cb => { cb.checked = settings.types.includes(cb.value); });
    });

    return {
      onShow() { if (!state.loaded && !state.busy) refresh(); },
    };
  }
})();
