/*
 * WorkWithPriends – LTRAX sync tab (extension world).
 * Finds the patients whose LTRAX assessment is still incomplete at the facility picked in
 * the header, pulls their Section GG codes from WellSky and fills the LTRAX Funct tab.
 * The work runs in the service worker (sync.js) so it keeps going while the panel is
 * hidden; this tab starts it and shows progress from chrome.storage.session.
 * Ported from SectionGGCompliance.
 */
(() => {
  const STATE_KEY = 'ltraxSync';
  const STATUS = {
    queued: 'Checking WellSky', ready: 'Ready', nothing: 'Nothing to fill', working: 'Filling',
    done: 'Done (Funct green)', already: 'Funct already green', incomplete: 'Saved, Funct not green', error: 'Error',
  };
  const COLORS = { ready: '#3b6fa3', done: '#2e7a4c', already: '#2e7a4c', incomplete: '#b26a00', error: '#b2412f' };

  WWP.addTab({ id: 'ltrax', label: 'LTRAX sync', init });

  function init(view, ctx) {
    const { esc } = ctx;
    view.innerHTML = `
      <form class="controls">
        <button type="submit" class="primary" data-a="scan">Find patients</button>
        <button type="button" data-a="apply" hidden>Fill selected in LTRAX</button>
        <label class="disch"><input type="checkbox" name="overwrite"> Overwrite LTRAX values that differ</label>
        <button type="button" data-a="reset">Clear</button>
        <span class="hint">Open LTRAX in another tab, signed in, on the launch screen.</span>
      </form>
      <p class="status" role="status"></p>
      <div class="view ltrax-list"><p class="empty">Find patients to check which LTRAX Funct tabs can be filled from WellSky.</p></div>`;

    const $ = s => view.querySelector(s);
    const list = $('.ltrax-list'), statusEl = $('.status');
    const unchecked = new Set();                           // patients the user turned off
    let state = { phase: 'idle', patients: [] };

    const setStatus = (msg, err) => { statusEl.textContent = msg || ''; statusEl.classList.toggle('error', !!err); };
    const send = msg => chrome.runtime.sendMessage(msg).catch(() => setStatus('The extension was reloaded. Refresh this page.', true));

    function outcomeLines(p) {
      if (!p.results) return [];
      const n = o => p.results.filter(r => r.outcome === o).length;
      const lines = [`Filled ${n('filled')}, overwritten ${n('overwritten')}, already matching ${n('same')}.`];
      for (const r of p.results) {
        if (r.outcome === 'mismatch') lines.push(`${r.item}: LTRAX has ${r.was}, WellSky says ${r.want} (not changed)`);
        else if (r.outcome === 'disabled') lines.push(`${r.item}: locked by LTRAX skip logic`);
        else if (!['filled', 'overwritten', 'same'].includes(r.outcome)) lines.push(`${r.item}: ${r.outcome}`);
      }
      return lines;
    }

    function render() {
      const busy = state.phase === 'scanning' || state.phase === 'applying';
      $('[data-a=scan]').disabled = busy;
      $('[data-a=apply]').disabled = busy;
      $('[data-a=apply]').hidden = !state.patients.some(p => p.status === 'ready');

      const c = state.counts;
      const msgs = {
        idle: '',
        scanning: 'Reading LTRAX and WellSky…',
        scanned: (c ? `Incomplete in LTRAX at this site: ${c.ltrax} · in WellSky grid: ${c.grid} · matched: ${c.matched}. ` : '')
          + (state.patients.length ? 'Untick anyone to skip, then Fill selected.' : 'Nothing to fill for this facility.'),
        applying: 'Filling LTRAX. Leave the LTRAX tab alone until this finishes.',
        applied: 'Finished.',
      };
      if (state.phase === 'error') setStatus(state.error, true);
      else setStatus(msgs[state.phase] ?? '');
      ctx.setCount(state.patients.filter(p => p.status === 'ready').length);

      if (!state.patients.length) {
        if (state.phase !== 'idle') list.innerHTML = '';
        return;
      }
      list.innerHTML = state.patients.map(p => {
        const notes = [
          p.error,
          p.fields?.length && !p.results ? `${p.fields.length} fields from WellSky` : null,
          ...outcomeLines(p),
          ...(p.dialogs ?? []).map(d => `LTRAX message: ${d}`),
        ].filter(Boolean);
        const flags = p.flags ?? [];
        return `<section class="gg-patient">
          <h2><label><input type="checkbox" data-key="${esc(p.key)}" ${p.status === 'ready' ? '' : 'disabled'}
            ${p.status === 'ready' && !unchecked.has(p.key) ? 'checked' : ''}> ${esc(p.name)}</label>
            <small>${p.section === 'discharge' ? 'Discharge' : 'Admission'} · admit ${esc(p.admitText)} · Acct ${esc(p.account)}</small></h2>
          <div class="flag">
            <span class="badge" style="background:${COLORS[p.status] ?? '#5d6b78'}">${esc(STATUS[p.status] ?? p.status)}</span>
            <span class="item">${notes.map(esc).join('<br>') || '&nbsp;'}</span>
            ${flags.length ? `<span class="meta">Fix in WellSky: ${flags.map(esc).join(' · ')}</span>` : ''}
          </div>
        </section>`;
      }).join('');
    }

    view.addEventListener('submit', e => {
      e.preventDefault();
      unchecked.clear();
      send({ type: 'wwp:ltrax:scan', facility: ctx.facility() });
    });
    view.addEventListener('click', e => {
      const a = e.target.closest('button[data-a]')?.dataset.a;
      if (a === 'reset') { unchecked.clear(); send({ type: 'wwp:ltrax:reset' }); }
      if (a === 'apply') {
        const keys = state.patients.filter(p => p.status === 'ready' && !unchecked.has(p.key)).map(p => p.key);
        if (!keys.length) { setStatus('Tick at least one patient.', true); return; }
        send({ type: 'wwp:ltrax:apply', keys, overwrite: $('[name=overwrite]').checked });
      }
    });
    view.addEventListener('change', e => {
      const key = e.target.dataset?.key;
      if (key) e.target.checked ? unchecked.delete(key) : unchecked.add(key);
    });

    chrome.storage.session.get(STATE_KEY).then(r => { state = r[STATE_KEY] ?? state; render(); }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && changes[STATE_KEY]) { state = changes[STATE_KEY].newValue ?? { phase: 'idle', patients: [] }; render(); }
    });
    ctx.onFacilityChange(() => {
      if (state.patients.length) setStatus('Facility changed. Find patients again to see its patients.');
    });

    return {
      onShow() { if (state.phase === 'idle') $('[data-a=scan]').focus(); },
    };
  }
})();
