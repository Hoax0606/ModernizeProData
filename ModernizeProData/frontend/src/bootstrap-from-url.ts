/**
 * URL-based auth bootstrap.
 *
 * Worker mode signs in via a native JavaFX form (Java HttpClient → JWT).
 * Then it hands off to a WebView pointed at the Coordinator URL. The
 * WebView starts with an empty localStorage (we mount a fresh user-data
 * directory every launch), so without help the React app would land on
 * /login and force the user to type the same credentials a second time.
 *
 * To avoid that, WorkerApp.swapToWebView() appends bootstrap_* query
 * parameters with the auth response it just got. This module — imported
 * first in main.tsx so it runs before any zustand store hydrates — reads
 * those params, writes a zustand-persist-shaped record into localStorage
 * under the `modernize-auth` key, then strips the params from the URL.
 *
 * Side effect on import (no exported API). Module-evaluation order in
 * main.tsx is what matters here, not a function call.
 */

const u = new URL(window.location.href);
const token = u.searchParams.get('bootstrap_token');
const userJson = u.searchParams.get('bootstrap_user');

if (token && userJson) {
  try {
    const user = JSON.parse(userJson) as { username: string; role: string };
    const payload = {
      state: {
        token,
        user: { username: user.username, role: user.role },
        expiresAt: u.searchParams.get('bootstrap_exp'),
        lastSignInAt: u.searchParams.get('bootstrap_last'),
        loginAt: new Date().toISOString(),
      },
      version: 0,
    };
    localStorage.setItem('modernize-auth', JSON.stringify(payload));
  } catch {
    // malformed bootstrap_user — fall through to /login normally.
  }
  // Strip params so a refresh / SPA nav doesn't re-bootstrap (the token
  // is already committed to localStorage at this point) and so they
  // don't leak into the address bar / referer.
  u.searchParams.delete('bootstrap_token');
  u.searchParams.delete('bootstrap_user');
  u.searchParams.delete('bootstrap_exp');
  u.searchParams.delete('bootstrap_last');
  window.history.replaceState({}, '', u.toString());
}
