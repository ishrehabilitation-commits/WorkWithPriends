// WorkWithPriends for WellSky — content script that builds the dashboard.
// Runs inside the WellSky tab. It draws the docked panel, its header and
// update banner, and one tab per module. Each module (modules/*.js, loaded
// after this file) adds its tab with WWP.addTab().

(() => {
  if (window.__wwpLoaded) return;
  window.__wwpLoaded = true;

  const FACILITIES = [
    ["204", "IRF Shreveport"],
    ["203", "IRF Bossier"],
  ];
  const DEFAULT_FACILITY = "204";

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ------------------------------------------------------------------ //
  //  Panel (Shadow DOM keeps ExtJS styles and ours from colliding)      //
  // ------------------------------------------------------------------ //

  const host = document.createElement("div");
  host.id = "wwp-dashboard-host";
  host.style.cssText =
    "all:initial;position:fixed;top:0;right:0;height:100vh;z-index:2147483000;display:none;";
  // ExtJS listens for keys at the document level; keep our typing to ourselves.
  for (const type of ["keydown", "keyup", "keypress"]) host.addEventListener(type, (e) => e.stopPropagation());

  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <link rel="stylesheet" href="${chrome.runtime.getURL("panel.css")}">
    <aside class="panel" aria-label="WorkWithPriends dashboard">
      <header class="bar">
        <h1>WorkWithPriends
          <span class="version">v${esc(chrome.runtime.getManifest().version)}<span class="vstate"></span></span></h1>
        <label class="facility">Facility <select name="facility">
          ${FACILITIES.map(([id, label]) => `<option value="${id}">${label} (${id})</option>`).join("")}
        </select></label>
        <button type="button" class="close" data-act="close" aria-label="Close dashboard">&times;</button>
      </header>
      <div class="update" role="status" hidden></div>
      <nav class="apptabs" role="tablist" aria-label="Dashboard sections"></nav>
      <div class="modules"></div>
    </aside>`;
  document.documentElement.appendChild(host);

  // A small note in the corner for messages that arrive while the panel is
  // hidden, such as a module stepping through a note in WellSky.
  const toastHost = document.createElement("div");
  toastHost.style.cssText = "all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483001;";
  const toastRoot = toastHost.attachShadow({ mode: "open" });
  toastRoot.innerHTML = `
    <style>
      p { margin: 0; max-width: 360px; padding: 8px 12px; border-radius: 6px; background: #22476e; color: #fff;
          font: 12px/1.4 "Segoe UI", system-ui, sans-serif; box-shadow: 0 3px 10px rgba(0,0,0,.3); }
      p.error { background: #b2412f; }
      p[hidden] { display: none; }
    </style>
    <p role="status" hidden></p>`;
  document.documentElement.appendChild(toastHost);

  const $ = (sel) => root.querySelector(sel);
  const facilitySelect = $("select[name=facility]");
  const tabBar = $(".apptabs");
  const modulesEl = $(".modules");
  const tabs = [];
  const facilityListeners = [];
  const state = { settingsLoaded: false, activeTab: null };

  const isOpen = () => host.style.display !== "none";

  let toastTimer;
  function toast(text, isError = false) {
    const el = toastRoot.querySelector("p");
    clearTimeout(toastTimer);
    el.textContent = text || "";
    el.classList.toggle("error", isError);
    el.hidden = !text || isOpen();
    if (text) toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 12000 : 6000);
  }

  async function togglePanel(force) {
    const show = force ?? !isOpen();
    host.style.display = show ? "block" : "none";
    if (show) {
      toastRoot.querySelector("p").hidden = true;
      await loadSettings();
      checkForUpdate();
      tabs.find((t) => t.id === state.activeTab)?.onShow?.();
    }
  }

  // What modules get to work with.
  const ctx = {
    esc,
    facility: () => facilitySelect.value,
    onFacilityChange: (fn) => facilityListeners.push(fn),
    show: () => togglePanel(true),
    hide: () => togglePanel(false),
    toast,
  };

  function selectTab(id) {
    if (!tabs.some((t) => t.id === id)) id = tabs[0]?.id;
    state.activeTab = id;
    for (const btn of tabBar.children) btn.setAttribute("aria-selected", btn.dataset.app === id);
    for (const view of modulesEl.children) view.hidden = view.dataset.module !== id;
    if (isOpen()) tabs.find((t) => t.id === id)?.onShow?.();
  }

  // A module calls this once, when its script loads.
  //   id, label   names the tab
  //   init(view, ctx)   draws into its own <section>; may return { onShow }
  function addTab({ id, label, init }) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.dataset.app = id;
    btn.innerHTML = `${esc(label)} <span class="count"></span>`;
    tabBar.appendChild(btn);

    const view = document.createElement("section");
    view.className = "module";
    view.dataset.module = id;
    modulesEl.appendChild(view);

    const tab = { id, label, view, ...(init(view, { ...ctx, setCount: (n) => setCount(id, n) }) || {}) };
    tabs.push(tab);
    selectTab(state.activeTab ?? id);
  }

  function setCount(id, n) {
    const el = tabBar.querySelector(`[data-app="${id}"] .count`);
    if (el) el.textContent = n ? `(${n})` : "";
  }

  async function loadSettings() {
    if (state.settingsLoaded) return;
    const { facility, activeTab } = await chrome.storage.sync.get(["facility", "activeTab"]);
    facilitySelect.value = FACILITIES.some(([id]) => id === facility) ? facility : DEFAULT_FACILITY;
    state.settingsLoaded = true;
    if (activeTab) selectTab(activeTab);
  }

  // ------------------------------------------------------------------ //
  //  Updates (same flow as IRF Minutes: compare with GitHub, then ask   //
  //  the updater/ helper to git pull)                                  //
  // ------------------------------------------------------------------ //

  let updateChecked = false;
  async function checkForUpdate() {
    if (updateChecked) return;
    updateChecked = true;
    const update = await chrome.runtime.sendMessage({ type: "wwp:checkUpdate" }).catch(() => null);
    const vstate = $(".vstate");
    if (!update?.latest) {
      vstate.textContent = " · couldn't check for updates";
      return;
    }
    vstate.textContent = update.outdated ? " · update available" : " · up to date";
    vstate.classList.toggle("outdated", update.outdated);
    if (!update.outdated) return;
    const el = $(".update");
    el.innerHTML = `<p><strong>Update available:</strong> version ${esc(update.latest)} is out (you have ${esc(update.current)}).</p>
      <p class="updateact">
        <button type="button" class="primary" data-act="update">Update now</button>
        <button type="button" data-act="extensions">Open extensions page</button>
        <span class="updatemsg">Update now needs the one-time setup in <code>updater/</code>.</span>
      </p>`;
    el.hidden = false;
  }

  async function applyUpdate(btn) {
    const msg = $(".updatemsg");
    btn.disabled = true;
    msg.textContent = "Updating…";
    const result = await chrome.runtime.sendMessage({ type: "wwp:applyUpdate" }).catch(() => null);
    if (result?.ok) {
      // The extension restarts itself a moment from now, which leaves this
      // panel disconnected until the page is reloaded.
      msg.textContent = `Updated to version ${result.after ?? "the latest"}. Refresh this page to use it.`;
    } else {
      btn.disabled = false;
      msg.textContent = result?.error
        ? `Couldn't update: ${result.error}`
        : "Couldn't update. Run git pull in the extension folder instead.";
    }
  }

  // ------------------------------------------------------------------ //
  //  Events                                                             //
  // ------------------------------------------------------------------ //

  facilitySelect.addEventListener("change", () => {
    chrome.storage.sync.set({ facility: facilitySelect.value });
    facilityListeners.forEach((fn) => fn(facilitySelect.value));
  });

  tabBar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-app]");
    if (!btn) return;
    selectTab(btn.dataset.app);
    chrome.storage.sync.set({ activeTab: btn.dataset.app });
  });

  // Only the header's own buttons; modules handle clicks in their views.
  for (const el of [$(".bar"), $(".update")]) {
    el.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "close") togglePanel(false);
      if (btn.dataset.act === "extensions") chrome.runtime.sendMessage({ type: "wwp:openExtensions" });
      if (btn.dataset.act === "update") applyUpdate(btn);
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "wwp:toggle") togglePanel();
  });

  window.WWP = { addTab };
})();
