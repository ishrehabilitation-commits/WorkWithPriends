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
- **LTRAX sync**: fills the LTRAX **Funct** tab from WellSky. **Find patients**
  reads the LTRAX launch screen (open LTRAX in another tab, signed in, on the
  launch screen), keeps Admission and Discharge rows with a blank status at the
  header's facility, and matches each one to the WellSky patient grid on name
  plus admit date. It then pulls their PT/OT forms and works out the GG codes.
  Nothing in LTRAX changes until you click **Fill selected in LTRAX**, which
  opens each patient in turn, fills only blank Funct fields (tick **Overwrite**
  to replace values that differ), saves with **Next: Pain/Falls**, checks the
  tab turned green and clicks **HOME** to release the lock. Ported from
  SectionGGCompliance.
- **Census**: the current patients at the header's facility with room, type,
  physicians, case manager, PT/OT/ST orders and evals (**Needs eval** = active
  order with no eval; ended orders are crossed out), caseload pickup, FMP,
  Mobility Team, Group and Team, plus recent discharges. Respite and Hospice
  are always hidden. **Census CSV** and **Discharges CSV** export what's on
  screen. **Copy for Schedule** (or **Schedule file**) feeds the Excel macro in
  `modules/census/excel/` that fills the therapy schedule workbook. Ported from
  the WellSky Rehab Census extension v0.3.0.

Nothing is stored outside the browser. All tabs call WellSky with the session
you are already signed in with.

## Install

**Windows:** double-click `setup\WWP-Setup.cmd`. It installs Git if needed,
downloads this repository and sets up the **Update now** button. Then it opens
`chrome://extensions` or `edge://extensions` with a small guide window beside
it: turn on Developer mode, click **Load unpacked** and paste the folder
(already copied, so Ctrl+V), check the extension is on, and pin it. The guide
ticks each step off by reading the browser's settings files, since browsers
don't let anything highlight or click on their extensions page. Edge doesn't
save pins where setup can read them, so tick that step yourself there. When
you close the guide it opens WellSky. The file works on its own, so you can
send it to a coworker or put it on a network share.

**By hand:** clone this repository, open `chrome://extensions`, turn on
Developer mode, click **Load unpacked** and pick the folder. Then run the
one-time updater setup in [`updater/`](updater/README.md).

## Updates

The dashboard checks GitHub for a newer `version` in `manifest.json` every six
hours. When one is out, it shows **Update now**, which runs `git pull` through
the helper in `updater/` and reloads the extension. To ship an update, bump
`version` in `manifest.json` and merge to `main`.

## Files

- `icons/`: the toolbar and extensions-page icon (a navy clipboard with a
  green check).
- `dashboard.js`: the panel, header, update banner and tab bar. Modules add
  their tab with `WWP.addTab({ id, label, init })`.
- `modules/minutes.js`: the IRF minutes tab.
- `modules/gg/tab.js`: the GG review tab's list and filters.
- `modules/gg/engine.js`, `modules/gg/navigator.js`: the GG data pull and note
  navigation. They run in the page's own world because they use WellSky's
  `Ext`/`HCS` objects; `modules/gg/bridge.js` passes messages between them and
  the tab.
- `modules/ltrax/`: the LTRAX sync tab. `tab.js` is the tab; `sync.js` runs in
  the service worker and drives the LTRAX tab; `wellsky.js` holds the WellSky
  form request and GG merge rules, `grid.js` the patient grid and name + admit
  date matching, `ltrax-template.js` the LTRAX Funct field names.
  Tests: `cd modules/ltrax && npm install && npm test` (made-up
  data only).
- `modules/census/`: the Census tab. `census-data.js` holds the WellSky
  queries, the merge and the CSV/schedule exports; `tab.js` is the tab.
  `excel/WellSky_Import_.bas` is the `UpdateFromWellSky` macro: import it once
  into the schedule .xlsm (Alt+F11, File > Import File), then after **Copy for
  Schedule** run it with Alt+F8. It writes only columns A, C, F-K, M, N and P on
  1st Med, 2nd Med and AMU-Psych, matched by room in column B. When a room has a
  new patient it clears the old one's row first; at the end it clears A and C:P
  (keeping B and formulas) for rooms nobody on the WellSky census is in. Team is
  written only for FMP patients (3) or when the PT/OT eval states it, and Group
  only when stated; otherwise those cells are left alone. A new eval order shows
  as Y. Tests: `node --test modules/census/test/*.test.js`
  (made-up data only).
- `background.js`: session cookies, the update check, the toolbar button and
  the LTRAX sync.
- `page-bridge.js`: reads the signed-in WellSky user ID for the minutes tab.

To add a tab, write `modules/<name>.js` that calls `WWP.addTab`, and list it in
`manifest.json` after `dashboard.js`.
