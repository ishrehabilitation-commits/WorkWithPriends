/**
 * Runs in the WellSky tab's page world (world: 'MAIN') so it can read the HCS globals.
 * The user ID and session token are added here and never leave the page.
 * Self-contained: Chrome serializes this function on its own.
 *
 * url: '/Interactant/get/HXHFRPT' etc. request: { name, timeout, data } with USERID/PASSWD
 * (and REQUSER, if present) left null.
 */
export async function callInteractant(url, request) {
  const hcs = window.HCS;
  if (!hcs?.userId || !hcs?.sessionToken) return { error: 'WellSky is not signed in on this tab (HCS session not found).' };
  const data = { ...request.data, USERID: hcs.userId, PASSWD: hcs.sessionToken };
  if ('REQUSER' in data) data.REQUSER = hcs.userId;
  try {
    const res = await fetch(`${url}?t=${Date.now()}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: '*/*' },
      body: JSON.stringify({ ...request, data }),
    });
    if (!res.ok) return { error: `WellSky returned HTTP ${res.status}` };
    const json = await res.json();
    for (const k of ['USERID', 'PASSWD', 'REQUSER']) delete json[k];
    return json;
  } catch (e) {
    return { error: `WellSky request failed: ${e.message}` };
  }
}
