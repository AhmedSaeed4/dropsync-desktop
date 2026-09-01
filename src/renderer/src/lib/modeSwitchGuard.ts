/**
 * C2 unsaved-work guard for mode switches (§2): when a mode switch is requested while a
 * text/drawing editor has unsaved changes, the SAME inline discard confirmation the editor
 * already uses must run before proceeding — no silent loss, no duplicate dialog.
 *
 * Mechanism: `requestModeSwitch` dispatches 'dropsync:mode-switch-request' carrying the
 * proceed continuation. Any mounted editor with unsaved edits calls preventDefault() (the
 * window.dispatchEvent return value tells us) and stashes the continuation; it fires it right
 * after its existing "Discard" confirm closes the modal. With nothing unsaved, nobody
 * prevents default and the switch proceeds immediately.
 */

export const MODE_SWITCH_EVENT = 'dropsync:mode-switch-request';

export interface ModeSwitchDetail {
  /** Runs the actual switch; fired by the editor after its discard-confirm, or immediately. */
  proceed: () => void;
}

/** Returns true when the switch was INTERCEPTED by an editor's discard guard. */
export function requestModeSwitch(proceed: () => void): boolean {
  // `cancelable` is load-bearing (C2f-hotfix-1): without it preventDefault() is a spec-level
  // no-op and dispatchEvent ALWAYS returns true, so `intercepted` was always false and every
  // guarded switch proceeded instantly, discarding unsaved edits. MDN Event.preventDefault:
  // "does nothing if the event is not cancelable".
  const ev = new CustomEvent<ModeSwitchDetail>(MODE_SWITCH_EVENT, { cancelable: true, detail: { proceed } });
  const intercepted = !window.dispatchEvent(ev);
  if (!intercepted) proceed();
  return intercepted;
}
