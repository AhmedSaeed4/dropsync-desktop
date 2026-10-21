// Round 123 — launch at login (owner decisions 2026-10-21: default ON, Settings switch,
// the app window opens normally). All Windows registration lives HERE in the main process
// via Electron's built-in login-item API — no new dependencies, no admin rights, and the
// entry surfaces in Windows' own Startup list (Settings → Apps → Startup).
// Mechanism (Electron 43, node_modules/electron/electron.d.ts): app.setLoginItemSettings
// writes the packaged exe's value under HKCU\...\CurrentVersion\Run; getLoginItemSettings
// reads it back. `executableWillLaunchAtLogin` (d.ts:22202 — "set to open at login AND its
// run key is not deactivated") is the Windows TRUTH for display; `openAtLogin` (the Run
// value's presence) is the right check for "entry is absent → re-create".
// The user's in-app choice rides a tiny JSON pref in userData (NOT the vault — vault
// settings are assertUnlocked-guarded [vault.ts:626] and would travel with vault moves;
// startup is a per-Windows-user machine concern). Shape: { launchAtLogin?: boolean } where
// undefined = "never chosen" → the DEFAULT-ON decision applies once, then persists.
import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface LaunchAtLoginStateDTO {
  /** false = the switch cannot work here (dev tree without the seam); the UI hides it. */
  available: boolean;
  /** The Windows truth: will the app actually launch at the next sign-in? */
  enabled: boolean;
}

/** DEV battery seam — arms the manager + the Settings section in the dev tree ONLY.
 * A packaged build is always available regardless of any env var. */
const DEV_SEAM = !app.isPackaged && process.env.DROPSYNC_STARTUP_DEV === '1';

export function isLaunchAtLoginAvailable(): boolean {
  return app.isPackaged || DEV_SEAM;
}

function prefPath(): string {
  return path.join(app.getPath('userData'), 'launch-at-login.json');
}

function readPref(): { launchAtLogin?: boolean } {
  try {
    const parsed = JSON.parse(readFileSync(prefPath(), 'utf8')) as { launchAtLogin?: boolean };
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {}; // absent or unreadable = never chosen; the default-ON rule applies
  }
}

function writePref(value: { launchAtLogin?: boolean }): void {
  writeFileSync(prefPath(), JSON.stringify(value), 'utf8');
}

/** The Windows truth for display: run key present AND not deactivated (d.ts :22195).
 * Electron 43.4.1 upstream bug #53911 (fixed only in later Electron — PR #54364): when the
 * exe path contains spaces, the default read compares the UNQUOTED path against the Run
 * value's QUOTED command, so executableWillLaunchAtLogin reads false on a LIVE entry
 * (probe-proven on this machine: evidence\f123\run2\probe-spaced-path.json — quoted read
 * true, default read false, openAtLogin true in both). The packaged exe is
 * "DropSync Desktop.exe" — ALWAYS spaced. Read BOTH forms; either match proves our exe is
 * the registered command, and the StartupApproved deactivation check applies to both. */
function registeredEnabled(): boolean {
  const quoted = app.getLoginItemSettings({ path: `"${process.execPath}"` }).executableWillLaunchAtLogin;
  return quoted || app.getLoginItemSettings().executableWillLaunchAtLogin;
}

export function getLaunchAtLoginState(): LaunchAtLoginStateDTO {
  if (!isLaunchAtLoginAvailable()) return { available: false, enabled: false };
  return { available: true, enabled: registeredEnabled() };
}

/** Settings switch: write the registry entry, remember the choice, report the fresh
 * Windows truth (never an optimistic guess — a deactivated run key would read back false). */
export function setLaunchAtLogin(enabled: boolean): LaunchAtLoginStateDTO {
  if (!isLaunchAtLoginAvailable()) {
    throw new Error('Launch at login is only available in the installed app.');
  }
  app.setLoginItemSettings({ openAtLogin: enabled });
  writePref({ launchAtLogin: enabled });
  console.log(`[launch-at-login] user set: ${enabled ? 'on' : 'off'}`);
  return getLaunchAtLoginState();
}

/** Boot sync — best-effort, once per launch, inside whenReady:
 * - never chosen  → record the DEFAULT-ON choice, then make sure the entry exists;
 * - chosen ON     → re-create the entry only when it is ABSENT (a cleaner tool removed it).
 *   A Windows-side disable (Settings → Apps → Startup) DEACTIVATES the run key without
 *   removing it, so `openAtLogin` stays true there and this sync deliberately leaves it
 *   alone — Windows' answer wins over our re-assert (owner decision D1's off must be
 *   respected wherever the user expressed it);
 * - chosen OFF    → never touch.
 * Dev tree without the seam: silent no-op (dev boots must never touch the registry). */
export function syncLaunchAtLoginAtBoot(): void {
  if (!isLaunchAtLoginAvailable()) return;
  try {
    const pref = readPref();
    const chosen = pref.launchAtLogin !== false;
    if (pref.launchAtLogin === undefined) {
      writePref({ launchAtLogin: true }); // the default-ON decision, recorded once
    }
    if (!chosen) {
      console.log('[launch-at-login] boot: off by user choice');
      return;
    }
    if (app.getLoginItemSettings().openAtLogin) {
      console.log('[launch-at-login] boot: already registered');
      return;
    }
    app.setLoginItemSettings({ openAtLogin: true });
    console.log(
      `[launch-at-login] boot: ${pref.launchAtLogin === undefined ? 'default-on applied' : 're-registered (entry was missing)'}`,
    );
  } catch (error) {
    console.error(
      '[launch-at-login] boot sync failed:',
      error instanceof Error ? error.message : String(error),
    );
  }
}
