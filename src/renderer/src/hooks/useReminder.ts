/**
 * useReminder — desktop port of the web hook (identical math; imports from dropsHelpers).
 * Centralizes preset↔offset computation + live validation (offset > 0, capped at the drop's
 * own expiry) so the modal can't drift from the web behavior.
 */

import { useMemo, useState } from 'react';
import type { ExpirationOption } from '../lib/types';
import {
  getExpirationDate,
  reminderOffsetMs,
  type ReminderPreset,
  type ReminderUnit,
} from '../lib/dropsHelpers';

/** The four fixed presets shared by every consumer ('custom' is a picker state, not an offset). */
export const REMINDER_PRESETS: ReminderPreset[] = ['15m', '30m', '1h', '2h'];

export interface ReminderApi {
  reminderEnabled: boolean;
  reminderPreset: ReminderPreset;
  reminderCustomValue: string;
  reminderCustomUnit: ReminderUnit;
  setReminderEnabled: (v: boolean) => void;
  setReminderPreset: (v: ReminderPreset) => void;
  setReminderCustomValue: (v: string) => void;
  setReminderCustomUnit: (v: ReminderUnit) => void;
  reminderAt: Date | null;
  reminderInvalid: boolean;
  warning: string | null;
  pickerActive: boolean;
  reminderDirty: boolean;
}

export function useReminder(
  expirationOption: ExpirationOption,
  maxDate?: Date | null,
  initialReminderAt?: Date | null
): ReminderApi {
  const [reminderEnabled, setReminderEnabled] = useState<boolean>(!!initialReminderAt);
  const [reminderPreset, setReminderPresetRaw] = useState<ReminderPreset>('15m');
  const [reminderCustomValue, setReminderCustomValueRaw] = useState('');
  const [reminderCustomUnit, setReminderCustomUnitRaw] = useState<ReminderUnit>('minutes');
  const [reminderSelected, setReminderSelected] = useState(false);
  // The instant of the last pick — pins the fire time to the pick moment and lets re-clicking
  // the active preset re-arm (React would bail on an unchanged value otherwise).
  const [reminderArmedAt, setReminderArmedAt] = useState<Date | null>(null);

  const setReminderPreset = (v: ReminderPreset) => { setReminderPresetRaw(v); setReminderSelected(true); setReminderArmedAt(new Date()); };
  const setReminderCustomValue = (v: string) => { setReminderCustomValueRaw(v); setReminderSelected(true); setReminderArmedAt(new Date()); };
  const setReminderCustomUnit = (v: ReminderUnit) => { setReminderCustomUnitRaw(v); setReminderSelected(true); setReminderArmedAt(new Date()); };

  const pickerActive = reminderSelected || !initialReminderAt;

  const { reminderAt, reminderInvalid, warning } = useMemo(() => {
    if (!reminderEnabled) return { reminderAt: null, reminderInvalid: false, warning: null };
    // Truth-on-open: until a NEW pick, the preview holds the saved reminder (revalidated).
    if (!reminderSelected && initialReminderAt) {
      const now = new Date();
      if (initialReminderAt.getTime() <= now.getTime()) {
        return { reminderAt: initialReminderAt, reminderInvalid: false, warning: null };
      }
      if (maxDate !== undefined && maxDate && initialReminderAt.getTime() > maxDate.getTime()) {
        return { reminderAt: initialReminderAt, reminderInvalid: false, warning: 'This reminder is past the expiry — pick a new time or turn it off.' };
      }
      return { reminderAt: initialReminderAt, reminderInvalid: false, warning: null };
    }
    const offset = reminderOffsetMs(reminderPreset, reminderCustomValue, reminderCustomUnit);
    const baseNow = reminderArmedAt ?? new Date();
    const at = new Date(baseNow.getTime() + offset);
    if (offset <= 0) {
      return { reminderAt: null, reminderInvalid: true, warning: 'Enter a reminder time in the future.' };
    }
    const cap: Date | null = maxDate !== undefined
      ? maxDate
      : (expirationOption !== 'forever' ? getExpirationDate(expirationOption) : null);
    if (cap && at.getTime() > cap.getTime()) {
      return { reminderAt: null, reminderInvalid: true, warning: 'Reminder must be before the drop expires.' };
    }
    return { reminderAt: at, reminderInvalid: false, warning: null };
  }, [reminderEnabled, reminderSelected, initialReminderAt, reminderPreset, reminderCustomValue, reminderCustomUnit, maxDate, expirationOption, reminderArmedAt]);

  const reminderDirty =
    initialReminderAt !== undefined &&
    ((reminderEnabled && !reminderInvalid ? reminderAt?.getTime() ?? null : null) !==
      (initialReminderAt?.getTime() ?? null));

  return {
    reminderEnabled,
    reminderPreset,
    reminderCustomValue,
    reminderCustomUnit,
    setReminderEnabled,
    setReminderPreset,
    setReminderCustomValue,
    setReminderCustomUnit,
    reminderAt,
    reminderInvalid,
    warning,
    pickerActive,
    reminderDirty,
  };
}
