# WorkWithPriends

A Chrome (or Edge) extension that docks a dashboard inside WellSky Specialty
Care. Click the toolbar button on a WellSky tab to show or hide it. The facility
picker in the header applies to every tab.

## Tabs

- **IRF minutes**: each Inpatient Rehab patient's PT/OT/ST minutes for their
  current admission week against the 900-minute target, plus a **Missing
  minutes** list of charges entered with units but no minutes. Ported from
  [IRF-Chrome-Extension](https://github.com/ishrehabilitation-commits/IRF-Chrome-Extension).
- **GG review**: flags Section GG problems in PT and OT notes (discrepancies
  within a note, PT vs OT disagreements on the same day, declines, not
  performed, improvements). Double-click a flag to open the note at that
  question; the callout can change the score and save the note after you
  confirm. Ported from irf-gg-extension v0.2.

Nothing is stored outside the browser. Both tabs call WellSky with the session
you are already signed in with.

## Install

**Windows:** double-click `setup\WWP-Setup.cmd`. It installs Git if needed,
downloads this repository, sets up the **Update now** button and opens the
browser ready to add the extension. The file works on its own, so you can send
it to a coworker or put it on a network share.

**By hand:** clone this repository, open `chrome://extensions`, turn on
Developer mode, click **Load unpacked** and pick the folder. Then run the
one-time updater setup in [`updater/`](updater/README.md).

## Updates

The dashboard checks GitHub for a newer `version` in `manifest.json` every six
hours. When one is out, it shows **Update now**, which runs `git pull` through
the helper in `updater/` and reloads the extension. To ship an update, bump
`version` in `manifest.json` and merge to `main`.

## Files

- `dashboard.js`: the panel, header, update banner and tab bar. Modules add
  their tab with `WWP.addTab({ id, label, init })`.
- `modules/minutes.js`: the IRF minutes tab.
- `modules/gg/tab.js`: the GG review tab's list and filters.
- `modules/gg/engine.js`, `modules/gg/navigator.js`: the GG data pull and note
  navigation. They run in the page's own world because they use WellSky's
  `Ext`/`HCS` objects; `modules/gg/bridge.js` passes messages between them and
  the tab.
- `background.js`: session cookies, the update check and the toolbar button.
- `page-bridge.js`: reads the signed-in WellSky user ID for the minutes tab.

To add a tab, write `modules/<name>.js` that calls `WWP.addTab`, and list it in
`manifest.json` after `dashboard.js`.
