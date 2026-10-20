/*
 * WorkWithPriends – GG review bridge (MAIN world).
 * engine.js and navigator.js need WellSky's own Ext/HCS objects, so they run in
 * the page. The dashboard tab (tab.js) runs in the extension's world, so the
 * two talk through DOM events whose detail is a JSON string:
 *   wwp:gg:run    {id, facility}  → wwp:gg:result {id, ok, results | error}
 *   wwp:gg:open   {p, f, a}       → wwp:gg:status {msg, err} …, wwp:gg:opened {ok, error}
 *                                   and wwp:gg:saved {} after the note is saved
 * The full results (with each flag's navigator target) stay here; the tab gets
 * a plain copy and refers to flags by index.
 */
(() => {
  const send = (type, detail) => document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(detail) }));
  const read = e => { try { return JSON.parse(e.detail); } catch (err) { return {}; } };
  const ready = () => window.Ext && window.HCS && HCS.load && HCS.viewport && HCS.viewport.down &&
    HCS.viewport.down('#mainTabPanel') && window.IRFReview && window.IRFNavigator;
  let results = null;

  const plain = out => out.map(r => ({
    patient: { name: r.patient.name, room: r.patient.room, account: r.patient.account },
    from: r.from, responses: r.rows.length,
    flags: r.flags.map(f => ({
      type: f.type, disc: f.disc, when: f.when, item: f.item, detail: f.detail,
      actions: f.actions.map(a => ({ label: a.label })),
    })),
  }));

  document.addEventListener('wwp:gg:run', async e => {
    const { id, facility } = read(e);
    try {
      if (!ready()) throw new Error('WellSky is still loading. Wait for the main screen, then refresh.');
      const CFG = IRFReview.CFG;
      if (+facility) CFG.facility = CFG.worklist.REQLVL6 = +facility;
      results = await IRFReview.run({ all: true });
      send('wwp:gg:result', { id, ok: true, results: plain(results) });
    } catch (err) {
      send('wwp:gg:result', { id, ok: false, error: err.message });
    }
  });

  document.addEventListener('wwp:gg:open', async e => {
    const { p, f, a } = read(e);
    const flag = results && results[p] && results[p].flags[f];
    const act = flag && flag.actions[a];
    if (!act) { send('wwp:gg:opened', { ok: false, error: 'That flag is out of date. Refresh the list.' }); return; }
    try {
      await IRFNavigator.open(act.target,
        (msg, err) => send('wwp:gg:status', { msg: msg || '', err: !!err }),
        () => send('wwp:gg:saved', {}));
      send('wwp:gg:opened', { ok: true, discipline: act.target.discipline, when: act.target.when });
    } catch (err) {
      send('wwp:gg:opened', { ok: false, error: err.message });
    }
  });
})();
