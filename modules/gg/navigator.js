/*
 * IRF GG Review – navigator (MAIN world).
 * Opens the patient chart on Notes, opens the matching note in Update mode,
 * jumps to the category holding each flagged question and highlights it with a
 * step-through callout ("Scored by OT as 04 on 10/12/26 ...").
 * The callout can change the value ("Change to 05 (OT)" → field turns green) and,
 * after the user confirms, presses the note's own Save button.
 */
(() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function waitFor(fn, ms = 20000, step = 150) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { const v = fn(); if (v) return v; } catch (e) { /* not ready yet */ }
      await sleep(step);
    }
    return null;
  }
  const pad = (n, len) => String(n).padStart(len, '0');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const DISC = { PT: /^(PT|PTA)$/, OT: /^(OT|COTA)$/ };
  let status = () => {};
  let onSaved = () => {};

  // ---------- 1. Patient tab → Notes ----------
  async function openNotes(p) {
    const tp = HCS.viewport.down('#mainTabPanel');
    const tabId = `Emr_${p.lv6}_${p.account}_${p.mrn}`;
    status('Opening patient chart…');
    HCS.view.Utils.openPatientTab(p.lv6, p.account, p.mrn, { optionSequence: 100 });   // 100 = Notes
    const tab = await waitFor(() => tp.items.findBy(t => t.itemId === tabId));
    if (!tab) throw new Error('Patient chart did not open');
    tp.setActiveTab(tab);
    status('Loading notes…');
    const notes = await waitFor(() => {
      const n = tab.down('emrNotes');
      const st = n && n.down('#notesGrid').getStore();
      return n && n.isVisible(true) && st && !st.isLoading() && st.getCount() ? n : null;
    });
    if (!notes) throw new Error('Notes list did not load');
    return notes;
  }

  // ---------- 2. Find the note row ----------
  function findNoteIndex(notes, t) {
    const st = notes.down('#notesGrid').getStore();
    return st.findBy(r =>
      Ext.Date.format(r.get('NOTEDATE'), 'Ymd') === t.noteDate &&
      Ext.Date.format(r.get('NOTETIME'), 'Hi') === t.noteTime &&
      (!DISC[t.discipline] || DISC[t.discipline].test(r.get('NOTEDISC'))));
  }

  async function widenDateRange(notes, t) {
    // Note is older than the Notes date range – move the From date back and search again
    const from = notes.query('datefield')[0];
    const btn = notes.query('button').find(b => b.text === 'Search');
    if (!from || !btn) return;
    from.setValue(Ext.Date.parse(t.noteDate, 'Ymd'));
    const st = notes.down('#notesGrid').getStore();
    btn.fireEvent('click', btn);
    await sleep(300);
    await waitFor(() => !st.isLoading());
  }

  // ---------- 3. Open in Update mode (or reuse the tab if the note is already open) ----------
  // Notes this extension opened, keyed by patient + note date/time + discipline → form tab
  const opened = new Map();
  const noteKey = t => [t.patient.account, t.noteDate, t.noteTime, t.discipline].join('|');
  const alive = ft => ft && !ft.destroyed && !ft.isDestroyed && ft.down('viewselection');
  const formTabsIn = cont => (cont ? cont.query('HCSclinicalformtab') : []).filter(alive);

  function activate(ft) {
    // bring the patient chart + the form's sub-tab to the front
    let c = ft;
    while (c) {
      const tp = c.ownerCt;
      if (tp && tp.isXType && tp.isXType('tabpanel') && tp.getActiveTab() !== c) tp.setActiveTab(c);
      c = tp;
    }
    return ft;
  }

  async function openNote(notes, idx, t) {
    const grid = notes.down('#notesGrid');
    const rec = grid.getStore().getAt(idx);
    const chart = notes.up('tabpanel') || notes.ownerCt;       // the patient's sub-tab panel
    const before = new Set(Ext.ComponentQuery.query('HCSclinicalformtab').map(c => c.id));
    grid.getSelectionModel().select(rec);
    grid.getView().focusRow && grid.getView().focusRow(rec);
    await sleep(400);                                         // let the toolbar enable
    const upd = notes.down('#updates');
    const canUpdate = upd && !upd.isDisabled() && rec.get('DISABLEUPDATE') !== 'Y';
    status(canUpdate ? 'Opening note for update…' : 'Opening note (view only)…');
    if (canUpdate) notes.onUpdateClick(upd.menu.down('#update'), 'U');
    else notes.showNote(notes.down('#inquire'), 'I');

    const ft = await waitFor(() => {
      // a) a brand-new form tab
      const fresh = Ext.ComponentQuery.query('HCSclinicalformtab')
        .find(c => !before.has(c.id) && alive(c) && c.down('viewselection').getStore().getCount());
      if (fresh) return fresh;
      // b) WellSky refused a duplicate and switched to the tab that already has this note
      const act = chart && chart.getActiveTab && chart.getActiveTab();
      if (act && act !== notes && act.isXType && act.isXType('HCSclinicalformtab') && alive(act)) return act;
      return null;
    }, 12000);
    if (ft) return ft;

    // c) still nothing: if exactly one open form tab in this chart matches the form + date, use it
    const date = Ext.Date.format(Ext.Date.parse(t.noteDate, 'Ymd'), 'm/d/Y');
    const name = String(t.form || '').toLowerCase();
    const matches = formTabsIn(chart).filter(c => {
      const txt = ((c.title || '') + ' ' + (c.el ? c.el.dom.innerText.slice(0, 300) : '')).toLowerCase();
      return (!name || txt.includes(name)) && txt.includes(date);
    });
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`That ${t.discipline} note may already be open in another tab – switch to it or close it and try again`);
    throw new Error('Note did not open');
  }

  // ---------- 4. Locate / change a question inside the open note ----------
  function findField(ft, cat, qNum) {
    const key = 'EMRQ' + pad(cat, 4) + pad(qNum, 7);
    return ft.query('[responseCodes]').find(f => String(f.responseCodes).includes(key)) || null;
  }

  async function goToField(ft, field) {
    const card = field.up('[isFormCategory]');
    const sel = ft.down('viewselection');
    if (card && sel) {
      const rec = sel.getStore().findRecord('itemId', card.itemId, 0, false, true, true);
      if (rec) { sel.getSelectionModel().select(rec); sel.fireEvent('itemclick', sel, rec); }
    }
    const holder = field.up('fieldset') || field;
    await waitFor(() => holder.rendered && holder.el && holder.el.dom.offsetParent, 5000);
    return holder;
  }

  // Leading number of the option text: "04. Supervision…" → 4
  const optNum = txt => { const m = String(txt || '').match(/^\s*0*(\d+)\s*\./); return m ? +m[1] : null; };
  const codeStr = n => (n == null ? '?' : pad(n, 2));
  const currentCode = field => codeStr(optNum(field.getRawValue && field.getRawValue()));

  // Set a GG combo to a code like '05' by matching the option text, the same way picking it would
  function setCode(field, code) {
    if (!field.getStore) return false;
    const st = field.getStore(), want = +code;
    const idx = st.findBy(r => optNum(r.get(field.displayField)) === want);
    if (idx < 0) return false;
    const rec = st.getAt(idx);
    field.setValue(rec.get(field.valueField));
    field.fireEvent('select', field, rec);
    field.fireEvent('blur', field);
    return true;
  }

  // ---------- 5. Highlight + callout ----------
  const CSS = `
    .irf-hl{outline:3px solid #d93025!important;outline-offset:2px;border-radius:4px;
      background:rgba(217,48,37,.07)!important;animation:irfPulse 1.1s ease-in-out 3}
    @keyframes irfPulse{50%{outline-color:#f9ab00}}
    .irf-fixed{outline:3px solid #188038!important;outline-offset:2px;border-radius:4px;
      background:rgba(24,128,56,.08)!important;position:relative}
    .irf-fixed::after{content:"\\2713  " attr(data-irf);position:absolute;right:8px;top:-9px;background:#188038;
      color:#fff;font:600 11px "Segoe UI",Arial,sans-serif;padding:1px 7px;border-radius:9px;pointer-events:none}
    .irf-callout{position:fixed;z-index:2147483000;width:360px;background:#202124;color:#fff;
      font:13px/1.45 "Segoe UI",Arial,sans-serif;padding:10px 12px 9px;border-radius:7px;
      box-shadow:0 6px 18px rgba(0,0,0,.35)}
    .irf-callout b{color:#fdd663}
    .irf-callout .irf-arrow{position:absolute;left:22px;top:-7px;border:7px solid transparent;
      border-top:0;border-bottom-color:#202124}
    .irf-callout.irf-above .irf-arrow{top:auto;bottom:-7px;border-bottom:0;border-top:7px solid #202124}
    .irf-callout .irf-q{font-weight:600;color:#c4e3ff;margin-bottom:4px;padding-right:18px}
    .irf-callout .irf-x{position:absolute;right:6px;top:4px;background:none;color:#aaa;font-size:15px;padding:0 4px}
    .irf-callout .irf-fix{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
    .irf-callout .irf-fix button{background:#1a73e8}
    .irf-callout .irf-done{margin-top:8px;color:#81c995;font-weight:600}
    .irf-callout .irf-bar{display:flex;gap:6px;align-items:center;margin-top:8px}
    .irf-callout .irf-bar span{flex:1;color:#bbb;font-size:12px}
    .irf-callout button{background:#3c4043;color:#fff;border:0;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:12px}
    .irf-callout button.irf-primary{background:#fdd663;color:#202124;font-weight:600}
    .irf-callout button.irf-save{background:#188038;color:#fff;font-weight:600}
    .irf-callout button:disabled{opacity:.4;cursor:default}
    .irf-modal{position:fixed;inset:0;z-index:2147483100;background:rgba(0,0,0,.35);display:flex;
      align-items:center;justify-content:center;font:13px/1.5 "Segoe UI",Arial,sans-serif}
    .irf-modal>div{background:#fff;color:#202124;border-radius:8px;width:400px;padding:16px 18px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
    .irf-modal h3{margin:0 0 8px;font-size:15px}
    .irf-modal ul{margin:6px 0 10px;padding-left:18px}
    .irf-modal .irf-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}
    .irf-modal button{border:0;border-radius:4px;padding:5px 14px;cursor:pointer;font-weight:600}
    .irf-modal .irf-ok{background:#188038;color:#fff}
    .irf-modal .irf-no{background:#e8eaed;color:#202124}`;
  function ensureCss() {
    if (document.getElementById('irf-nav-css')) return;
    const s = document.createElement('style'); s.id = 'irf-nav-css'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function confirmBox(title, html, okText) {
    return new Promise(resolve => {
      const m = document.createElement('div');
      m.className = 'irf-modal';
      m.innerHTML = `<div><h3>${title}</h3>${html}<div class="irf-btns">
        <button class="irf-no">Keep editing</button><button class="irf-ok">${okText}</button></div></div>`;
      document.body.appendChild(m);
      const done = v => { m.remove(); resolve(v); };
      m.querySelector('.irf-no').onclick = () => done(false);
      m.querySelector('.irf-ok').onclick = () => done(true);
    });
  }

  let tour = null;
  function endTour() {
    if (!tour) return;
    tour.items.forEach(i => i.holder && !i.holder.destroyed && i.holder.removeCls('irf-hl'));
    tour.box.remove(); clearInterval(tour.timer);
    window.removeEventListener('scroll', tour.place, true);
    tour = null;
  }

  // Press the note's own Save button and wait for WellSky to close the form
  async function saveNote(ft) {
    const btn = ft.down('HCSsavebutton') || ft.query('button').find(b => b.text === 'Save');
    if (!btn || btn.isDisabled()) throw new Error('Save button not available on this note');
    status('Saving note…');
    btn.el.dom.click();
    const closed = await waitFor(() => ft.destroyed || ft.isDestroyed || !ft.el, 8000);
    if (closed) return true;
    status('WellSky needs something before it saves – finish its prompt (e.g. missing required items).');
    return !!(await waitFor(() => ft.destroyed || ft.isDestroyed || !ft.el, 120000, 500));
  }

  async function startTour(ft, t) {
    endTour(); ensureCss();
    const items = t.steps.map(s => ({ ...s, field: findField(ft, s.cat, s.qNum) }));
    const box = document.createElement('div');
    box.className = 'irf-callout';
    document.body.appendChild(box);
    tour = { ft, t, items, box, i: 0 };
    const changes = () => tour.items.filter(x => x.changed);

    const place = () => {
      const it = tour && tour.items[tour.i];
      const dom = it && it.holder && it.holder.el && it.holder.el.dom;
      if (!dom || !dom.offsetParent || ft.destroyed) { box.style.display = 'none'; return; }
      const r = dom.getBoundingClientRect();
      box.style.display = '';
      const below = r.bottom + 10 + box.offsetHeight < window.innerHeight;
      box.classList.toggle('irf-above', !below);
      box.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 370)) + 'px';
      box.style.top = (below ? r.bottom + 10 : r.top - box.offsetHeight - 10) + 'px';
    };
    tour.place = place;
    window.addEventListener('scroll', place, true);
    tour.timer = setInterval(() => { if (ft.destroyed) endTour(); else place(); }, 250);

    function mark(it) {
      it.holder.removeCls('irf-hl');
      it.holder.addCls('irf-fixed');
      it.holder.el.dom.setAttribute('data-irf', `Changed ${it.changed.from} → ${it.changed.to}`);
    }
    function unmark(it) {
      it.holder.removeCls('irf-fixed');
      it.holder.el.dom.removeAttribute('data-irf');
    }

    async function save() {
      const list = changes();
      const ok = await confirmBox(`Save ${esc(t.discipline)} note ${esc(t.when)}?`,
        `<div>These changes will be saved to the note:</div><ul>${list.map(x =>
          `<li>${esc(x.label)}: <b>${x.changed.from}</b> → <b>${x.changed.to}</b></li>`).join('')}</ul>
         <div style="color:#5f6368;font-size:12px">This presses the note's Save button. Any WellSky prompts will still appear.</div>`,
        'Save note');
      if (!ok) return;
      box.style.visibility = 'hidden';
      try {
        const saved = await saveNote(ft);
        endTour();
        if (saved) { status(`Saved ${t.discipline} note ${t.when} (${list.length} change${list.length > 1 ? 's' : ''}).`); onSaved(t, list); }
        else status('Note not saved yet – finish or cancel the WellSky prompt.', true);
      } catch (e) { box.style.visibility = ''; status(e.message, true); }
    }

    const show = async i => {
      tour.i = i;
      tour.items.forEach(x => x.holder && x.holder.removeCls('irf-hl'));
      const it = tour.items[i];
      const n = tour.items.length;
      let html = it.html;
      if (it.field) {
        it.holder = await goToField(ft, it.field);
        it.label = String(it.holder.title || '').split(':')[0];
        if (!it.changed) it.holder.addCls('irf-hl');
        it.holder.el.dom.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } else {
        html += '<br><i>Could not find this question in the note.</i>';
      }
      const now = it.field ? currentCode(it.field) : null;
      const fixes = it.field && !it.changed ? (it.suggest || []).filter(s => s.code !== now) : [];
      const nChanged = changes().length;
      box.innerHTML = `<div class="irf-arrow"></div><button class="irf-x" data-a="close" title="Close">✕</button>
        ${it.label ? `<div class="irf-q">${esc(it.label)}</div>` : ''}${html}
        ${it.changed ? `<div class="irf-done">✓ Changed ${it.changed.from} → ${it.changed.to}
            <button data-a="undo" style="margin-left:6px">Undo</button></div>` : ''}
        ${fixes.length ? `<div class="irf-fix">${fixes.map(s =>
            `<button data-a="fix" data-code="${esc(s.code)}">Change to ${esc(s.code)} (${esc(s.why)})</button>`).join('')}</div>` : ''}
        <div class="irf-bar"><span>${n > 1 ? `${i + 1} of ${n}` : ''}</span>
        ${n > 1 ? '<button data-a="prev">Back</button><button data-a="next">Next</button>' : ''}
        ${nChanged ? `<button class="irf-save" data-a="save">Save note (${nChanged})</button>`
                   : '<button class="irf-primary" data-a="close">Got it</button>'}</div>`;

      const on = (a, fn) => box.querySelectorAll(`[data-a=${a}]`).forEach(b => { b.onclick = fn; });
      const prev = box.querySelector('[data-a=prev]'), next = box.querySelector('[data-a=next]');
      if (prev) prev.disabled = i === 0;
      if (next) next.disabled = i === n - 1;
      on('prev', () => show(i - 1));
      on('next', () => show(i + 1));
      on('close', endTour);
      on('save', save);
      on('fix', e => {
        const code = e.currentTarget.dataset.code;
        const from = currentCode(it.field), orig = it.field.getValue();
        if (!setCode(it.field, code)) { status(`Option ${code} not found for this question`, true); return; }
        it.changed = { from, to: code, orig };
        mark(it);
        // move on to the next step that still needs attention
        const nextIdx = tour.items.findIndex((x, j) => j > i && x.field && !x.changed);
        setTimeout(() => show(nextIdx > -1 ? nextIdx : i), nextIdx > -1 ? 700 : 0);
      });
      on('undo', () => {
        it.field.setValue(it.changed.orig);
        it.field.fireEvent('blur', it.field);
        unmark(it); it.changed = null;
        show(i);
      });
      setTimeout(place, 350);
    };
    await show(0);
  }

  // ---------- Public entry ----------
  async function open(t, onStatus, onSavedCb) {
    status = onStatus || (() => {});
    onSaved = onSavedCb || (() => {});
    endTour();
    // Already opened by us and still open? Just switch to it.
    let ft = opened.get(noteKey(t));
    if (alive(ft)) {
      status('Note already open – switching to it…');
      activate(ft);
      await sleep(300);
    } else {
      const notes = await openNotes(t.patient);
      let idx = findNoteIndex(notes, t);
      if (idx < 0) { status('Note older than date range – widening…'); await widenDateRange(notes, t); idx = findNoteIndex(notes, t); }
      if (idx < 0) throw new Error(`Could not find the ${t.discipline} note from ${t.when} in Notes`);
      ft = activate(await openNote(notes, idx, t));
      opened.set(noteKey(t), ft);
    }
    status('Finding the question…');
    await sleep(300);
    await startTour(ft, t);
    status('');
  }

  window.IRFNavigator = { open, endTour, findField, setCode };
})();
