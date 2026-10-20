/*
 * WorkWithPriends – GG review tab (extension world).
 * Lists the Section GG flags for each Inpatient Rehab patient: discrepancies in
 * one note, PT vs OT conflicts, declines, not performed and improvements.
 * Double-click a flag (or press its button) to open the note at the question.
 * PT vs OT flags offer "Fix PT note" / "Fix OT note".
 * The data pull and the note navigation run in the page (engine.js,
 * navigator.js); bridge.js passes messages between the two.
 * Ported from irf-gg-extension v0.2's panel.js.
 */
(() => {
  const TYPES = {
    'DISCREPANCY':   { color: '#d93025', label: 'Discrepancy' },
    'PT vs OT':      { color: '#a142f4', label: 'PT vs OT' },
    'DECLINED':      { color: '#e37400', label: 'Declined' },
    'NOT PERFORMED': { color: '#5f6368', label: 'Not performed' },
    'IMPROVED':      { color: '#188038', label: 'Improved' },
  };

  // Page events carry JSON strings, which cross between the two worlds intact.
  const send = (type, detail) => document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(detail) }));
  const on = (type, fn) => document.addEventListener(type, e => { try { fn(JSON.parse(e.detail)); } catch (err) { /* not ours */ } });

  let runId = 0;
  const pending = new Map();
  on('wwp:gg:result', d => { const r = pending.get(d.id); if (r) { pending.delete(d.id); r(d); } });
  const runReview = facility => new Promise(resolve => {
    const id = ++runId;
    pending.set(id, resolve);
    send('wwp:gg:run', { id, facility });
  });

  WWP.addTab({ id: 'gg', label: 'GG review', init });

  function init(view, ctx) {
    const { esc } = ctx;
    view.innerHTML = `
      <form class="controls">
        <button type="submit" class="primary">Review patients</button>
        <span class="hint">Double-click a flag to open the note at that question.</span>
      </form>
      <div class="filters"></div>
      <p class="status" role="status"></p>
      <div class="view gg-list"><p class="empty">Review patients to check Section GG scores in PT and OT notes.</p></div>`;

    const $ = s => view.querySelector(s);
    const list = $('.gg-list'), statusEl = $('.status'), runBtn = $('button[type=submit]');
    const off = new Set(['IMPROVED']);                     // hidden by default
    let results = null, busy = false, opening = false;

    const setStatus = (msg, err) => { statusEl.textContent = msg || ''; statusEl.classList.toggle('error', !!err); };

    function renderFilters() {
      $('.filters').innerHTML = Object.entries(TYPES).map(([k, v]) => {
        const n = results ? results.reduce((a, r) => a + r.flags.filter(f => f.type === k).length, 0) : 0;
        return `<button type="button" class="chip ${off.has(k) ? 'off' : ''}" data-t="${esc(k)}" aria-pressed="${!off.has(k)}">` +
          `<i style="background:${v.color}"></i>${v.label} ${results ? n : ''}</button>`;
      }).join('');
    }

    function render() {
      renderFilters();
      if (!results) return;
      const total = results.reduce((a, r) => a + r.flags.filter(f => f.type !== 'IMPROVED').length, 0);
      ctx.setCount(total);
      if (!results.length) { list.innerHTML = '<p class="empty">No Inpatient Rehab patients on the work list.</p>'; return; }
      list.innerHTML = results.map((r, pi) => {
        const flags = r.flags.map((f, fi) => ({ f, fi })).filter(x => !off.has(x.f.type));
        return `<section class="gg-patient"><h2>${esc(r.patient.name)} <small>Rm ${esc(r.patient.room || '')} · Acct ${esc(r.patient.account)} · since ${esc(r.from)} · ${r.responses} responses</small></h2>` +
          (flags.length ? flags.map(({ f, fi }) => `
            <div class="flag" data-p="${pi}" data-f="${fi}" title="${f.actions.length > 1 ? 'Choose which note to fix' : 'Double-click to open the note'}">
              <span class="badge" style="background:${TYPES[f.type].color}">${TYPES[f.type].label}</span>
              <span class="item">${esc(f.item)} <span class="meta">· ${esc(f.disc)} · ${esc(f.when)}</span></span>
              <span class="meta">${esc(f.detail)}</span>
              <span class="acts">${f.actions.map((a, ai) => `<button type="button" data-a="open" data-i="${ai}">${esc(a.label)}</button>`).join('')}</span>
            </div>`).join('') : '<p class="note">No flags.</p>') + '</section>';
      }).join('');
    }

    async function refresh() {
      if (busy) return;
      busy = true; runBtn.disabled = true;
      setStatus('Loading work list and PT/OT forms…');
      const res = await runReview(ctx.facility());
      if (res.ok) {
        results = res.results;
        setStatus(`Reviewed ${results.length} patient(s) · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
        render();
      } else setStatus(res.error, true);
      busy = false; runBtn.disabled = false;
    }

    // While a note is open the panel is out of the way, so the navigator's
    // progress shows in the corner instead.
    on('wwp:gg:status', ({ msg, err }) => { setStatus(msg, err); if (msg) ctx.toast(msg, err); });
    on('wwp:gg:saved', async () => {                       // re-check after a save so the fixed flag drops off
      const msg = statusEl.textContent;
      await refresh();
      setStatus(msg + ' · list refreshed');
    });

    function openFlag(row, ai) {
      if (busy || opening || !row) return;
      opening = true; row.classList.add('busy');
      ctx.hide();                                          // get out of the way of the note
      const done = new Promise(resolve => {
        const listener = e => { document.removeEventListener('wwp:gg:opened', listener); resolve(JSON.parse(e.detail)); };
        document.addEventListener('wwp:gg:opened', listener);
      });
      send('wwp:gg:open', { p: +row.dataset.p, f: +row.dataset.f, a: ai });
      done.then(res => {
        if (res.ok) {
          const msg = `Opened ${res.discipline} note ${res.when}. Use "Change to…" in the callout, then Save note.`;
          setStatus(msg); ctx.toast(msg);
        } else { setStatus(res.error, true); ctx.show(); }
        row.classList.remove('busy'); opening = false;
      });
    }

    view.addEventListener('submit', e => { e.preventDefault(); refresh(); });
    view.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (chip) { const t = chip.dataset.t; off.has(t) ? off.delete(t) : off.add(t); render(); return; }
      const a = e.target.closest('[data-a=open]');
      if (a) openFlag(a.closest('.flag'), +a.dataset.i);
    });
    view.addEventListener('dblclick', e => {
      const row = e.target.closest('.flag');
      if (!row || e.target.closest('button')) return;
      const f = results[+row.dataset.p].flags[+row.dataset.f];
      if (f.actions.length === 1) openFlag(row, 0);        // PT vs OT needs an explicit choice
      else setStatus('Choose "Fix PT note" or "Fix OT note".');
    });
    ctx.onFacilityChange(() => {
      if (results) setStatus('Facility changed. Review patients again to see its patients.');
    });

    renderFilters();
    return {
      onShow() { if (!results && !busy) runBtn.focus(); },
    };
  }
})();
