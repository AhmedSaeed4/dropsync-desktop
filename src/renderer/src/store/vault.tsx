/**
 * The store-adapter seam (spec §6: "store-adapter seam keeps diffs mechanical"). Wraps the
 * contextBridge API in the shapes the ported Editorial components expect: web-style
 * Drop/Category/Workspace objects with Date fields, currentWorkspace=null meaning Personal,
 * and the CRITICAL offline fix — a 30-second heartbeat tick that recreates the drops array so
 * countdowns keep moving and due reminders jump tiers without any Firestore churn to piggyback
 * on (the web got those re-renders for free from snapshot events).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { DropDTO, VaultCategoryDTO, VaultSettingsDTO } from '../../../preload/apiTypes';
import { dropDtoToDrop, LOCAL_USER_ID, type Category, type Drop, type Workspace } from '../lib/types';

type Status = 'none' | 'locked' | 'unlocked';

interface VaultStoreValue {
  status: Status;
  folder: string | null;
  checking: boolean;
  spaces: Workspace[];
  currentSpaceId: string | null; // null = Personal
  currentSpaceName: string;
  categories: Category[];
  drops: Drop[];
  loading: boolean;
  settings: VaultSettingsDTO | null;
  theme: 'light' | 'dark' | 'minimal';

  refreshAll: () => Promise<void>;
  /** FIX 23 — spaces list ONLY: status + listSpaces + setSpacesRaw. No drops reload, no
   * settings touch, loading never flips — used after import so the switcher lists a newly
   * created workspace in the same breath as setCurrentSpace, with zero visual event. */
  refreshSpaces: () => Promise<void>;
  /**
   * First-run CREATE folder pick: dialog → prepareFolder → remember the folder WITHOUT flipping
   * screens (status stays 'none'). Resolves picked:null on cancel; hasVault:true means the picked
   * folder already holds a vault and the screen intentionally moved to 'locked'.
   */
  pickCreateFolder: () => Promise<{ picked: string | null; hasVault: boolean }>;
  refreshDrops: () => void;
  /** FIX 9: replace one drop by id from a mutation's returned record — loading NEVER flips,
   * so the list never blinks to skeleton. Sort/pin/fired-tier memos recompute off the new array. */
  patchDropInPlace: (dto: DropDTO) => void;
  /** FIX 9 batch form (YouTube title refresh) — merges only the ids present. */
  patchDropsInPlace: (dtos: DropDTO[]) => void;
  /** FIX 9: append a created drop (idempotent by id), loading untouched. */
  appendDropInPlace: (dto: DropDTO) => void;
  /** FIX 13: remove one or many drops by id in place — the silent delete commit. Loading
   * NEVER flips; the tombstone already hid the card, so this is a zero-visual-event sync. */
  removeDropInPlace: (ids: string | string[]) => void;
  /** Category create without the full reload (same no-blink contract). */
  upsertCategoryInPlace: (cat: VaultCategoryDTO) => void;
  setCurrentSpace: (id: string | null) => void;
  setTheme: (theme: 'light' | 'dark' | 'minimal') => void;
  updateSettings: (patch: Partial<VaultSettingsDTO>) => Promise<void>;
  handleUnlocked: () => Promise<void>;
  handleLocked: () => void;
  /** Exit door: flip to the first-run Create flow keeping the recorded folder (M7). */
  startCreateFlow: () => void;
  /** C2i FIX B — bare status reconcile for CloudModeShell's homecoming whisper-check: sets the
   * status WITHOUT any data traffic (no loading flip, no list/category/settings fetches),
   * exactly mirroring what the 8 s watcher already does when it observes a changed world under
   * us (it merely setStatus-es). Not part of any user flow. */
  reconcileStatus: (s: Status) => void;
  fetchTextPayload: (dropId: string) => Promise<string>;
  getMediaUrl: (dropId: string, kind: 'file' | 'image') => Promise<string | null>;
  /** Size-capped payload bytes for in-page use (drawing scene extraction). */
  getMediaBytes: (dropId: string, kind: 'file' | 'image') => Promise<Uint8Array | null>;
}

const VaultStoreContext = createContext<VaultStoreValue | null>(null);

// Polish sweep #2 (M8): the LAST SELECTED THEME is mirrored in localStorage so the unlock /
// first-run screens render in it before any vault settings exist to read.
const THEME_CACHE_KEY = 'dropsync.theme';

function cachedTheme(): 'light' | 'dark' | 'minimal' {
  try {
    const value = localStorage.getItem(THEME_CACHE_KEY);
    return value === 'dark' || value === 'minimal' ? value : 'light';
  } catch {
    return 'light';
  }
}

export function useVaultStore(): VaultStoreValue {
  const value = useContext(VaultStoreContext);
  if (!value) throw new Error('useVaultStore outside provider');
  return value;
}

export function VaultStoreProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('none');
  const [folder, setFolder] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [spacesRaw, setSpacesRaw] = useState<Array<{ id: string; name: string; createdAt: string }>>([]);
  const [currentSpaceId, setCurrentSpaceId] = useState<string | null>(null);
  const [categoriesRaw, setCategoriesRaw] = useState<Array<{ id: string; spaceId: string; name: string; createdAt: string }>>([]);
  const [dropsRaw, setDropsRaw] = useState<Parameters<typeof dropDtoToDrop>[0][]>([]);
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<VaultSettingsDTO | null>(null);
  const bootTheme = useMemo(cachedTheme, []);
  const spaceRef = useRef<string | null>(null);
  spaceRef.current = currentSpaceId;

  // Initial status probe. A dev-harness boot can come up ALREADY unlocked (pre-unlocked vault);
  // hydrate the full store in that case too.
  useEffect(() => {
    let cancelled = false;
    window.dropsync.vault.status().then((s) => {
      if (cancelled) return;
      setStatus(s.state);
      setFolder(s.folder);
      setChecking(false);
      if (s.state === 'unlocked') void refreshAll();
    }).catch(() => setChecking(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Watch for main-process auto-lock flipping the vault state under us.
  useEffect(() => {
    if (status !== 'unlocked') return;
    const id = setInterval(() => {
      window.dropsync.vault.status().then((s) => {
        if (s.state !== 'unlocked') {
          setStatus(s.state);
          if (s.folder) setFolder(s.folder);
        }
      }).catch(() => {});
    }, 8000);
    return () => clearInterval(id);
  }, [status]);

  const refreshDropsInternal = useCallback(async (spaceId: string) => {
    setLoading(true);
    try {
      const dtos = await window.dropsync.drop.list(spaceId);
      setDropsRaw(dtos);
      const cats = await window.dropsync.vault.listCategories(spaceId);
      setCategoriesRaw(cats);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    const s = await window.dropsync.vault.status();
    setStatus(s.state);
    setFolder(s.folder);
    if (s.state !== 'unlocked') return;
    const [spaces, cfg] = await Promise.all([
      window.dropsync.vault.listSpaces(),
      window.dropsync.vault.settingsGet(),
    ]);
    setSpacesRaw(spaces);
    setSettings(cfg);
    const active = spaceRef.current && spaces.some((sp) => sp.id === spaceRef.current)
      ? spaceRef.current
      : null;
    setCurrentSpaceId(active);
    await refreshDropsInternal(active ?? 'personal');
  }, [refreshDropsInternal]);

  // FIX 23 — see interface doc. Deliberately NOT refreshAll: import completion must not
  // refetch drops or flip loading (no-blink contract); only the switcher list changes.
  const refreshSpaces = useCallback(async () => {
    const s = await window.dropsync.vault.status();
    setStatus(s.state);
    setFolder(s.folder);
    if (s.state !== 'unlocked') return;
    setSpacesRaw(await window.dropsync.vault.listSpaces());
  }, []);

  /**
   * First-run CREATE flow: picking a folder must NOT decide which screen you're on. The old path
   * (prepareFolder → refreshAll) dead-ended creation: preparing ANY folder makes the manager
   * report 'locked', so refreshAll bounced first-run users onto UnlockScreen before a vault
   * even existed, with no way back to 'none'. Here we only record the folder — the Create button
   * does the real flip. One exception: a folder that ALREADY holds a valid vault intentionally
   * moves to 'locked' so the caller can offer unlocking it instead of stacking a second vault
   * over it.
   */
  const pickCreateFolder = useCallback(async (): Promise<{ picked: string | null; hasVault: boolean }> => {
    const picked = await window.dropsync.dialog.pickFolder({ title: 'Choose a folder for your DropSync vault' });
    if (!picked) return { picked: null, hasVault: false }; // cancel = nothing changes
    const prepared = await window.dropsync.vault.prepareFolder(picked);
    if (prepared.hasVault) {
      setStatus('locked');
    }
    setFolder(picked);
    return { picked, hasVault: prepared.hasVault };
  }, []);

  const handleUnlocked = useCallback(async () => {
    spaceRef.current = null;
    setCurrentSpaceId(null);
    await refreshAll();
  }, [refreshAll]);

  const handleLocked = useCallback(() => {
    setStatus('locked');
    setDropsRaw([]);
    setCategoriesRaw([]);
    setSpacesRaw([]);
  }, []);

  /** Exit door (M7): after "create one here?" is accepted on the UnlockScreen, drop back to the
   * first-run Create flow with the ALREADY-RECORDED folder prefilled and empty password boxes. */
  const startCreateFlow = useCallback(() => {
    setStatus('none');
  }, []);

  // C2i FIX B — see interface doc: the whisper-check's neutral branch (a non-unlocked world
  // observed on homecoming that the watcher would otherwise settle within ≤8 s). Bare setState,
  // nothing else — counterpart of handleLocked/handleUnlocked for the 'none' case.
  const reconcileStatus = useCallback((s: Status) => {
    setStatus(s);
  }, []);

  // THE 30-SECOND HEARTBEAT — recreates the drops array ref so the whole list re-renders and
  // countdown/expiry/reminder-tier logic recomputes against fresh wall-clock time.
  useEffect(() => {
    if (status !== 'unlocked') return;
    const id = setInterval(() => {
      setDropsRaw((prev) => (prev.length > 0 ? [...prev] : prev));
    }, 30_000);
    return () => clearInterval(id);
  }, [status]);

  const refreshDrops = useCallback(() => {
    void refreshDropsInternal(spaceRef.current ?? 'personal');
  }, [refreshDropsInternal]);

  // ---- FIX 9: in-place list surgery (see interface docs) ----
  const patchDropInPlace = useCallback((dto: DropDTO) => {
    setDropsRaw((prev) => (prev.some((d) => d.id === dto.id) ? prev.map((d) => (d.id === dto.id ? dto : d)) : [...prev, dto]));
  }, []);

  const patchDropsInPlace = useCallback((dtos: DropDTO[]) => {
    if (dtos.length === 0) return;
    const byId = new Map(dtos.map((d) => [d.id, d]));
    setDropsRaw((prev) => prev.map((d) => byId.get(d.id) ?? d));
  }, []);

  const appendDropInPlace = useCallback((dto: DropDTO) => {
    setDropsRaw((prev) => (prev.some((d) => d.id === dto.id) ? prev : [...prev, dto]));
  }, []);

  // FIX 13: silent delete commit — filter the id(s) out in place. The tombstone already hid
  // these cards from the visible list, so this state update produces ZERO visual event; it
  // just keeps dropsRaw truthful without the full-list skeleton flash of a refetch.
  const removeDropInPlace = useCallback((ids: string | string[]) => {
    const kill = Array.isArray(ids) ? new Set(ids) : new Set([ids]);
    setDropsRaw((prev) => prev.filter((d) => !kill.has(d.id)));
  }, []);

  const upsertCategoryInPlace = useCallback((cat: VaultCategoryDTO) => {
    setCategoriesRaw((prev) => (prev.some((c) => c.id === cat.id) ? prev.map((c) => (c.id === cat.id ? cat : c)) : [...prev, cat]));
  }, []);

  const theme = settings?.theme ?? bootTheme;

  const setTheme = useCallback((next: 'light' | 'dark' | 'minimal') => {
    setSettings((prev) => (prev ? { ...prev, theme: next } : prev));
    try { localStorage.setItem(THEME_CACHE_KEY, next); } catch { /* private mode */ }
    void window.dropsync.vault.settingsSet({ theme: next });
  }, []);

  const updateSettings = useCallback(async (patch: Partial<VaultSettingsDTO>) => {
    const next = await window.dropsync.vault.settingsSet(patch);
    setSettings(next);
  }, []);

  const spaces = useMemo<Workspace[]>(() => spacesRaw.map((s) => ({
    id: s.id,
    name: s.name,
    ownerId: LOCAL_USER_ID,
    members: [LOCAL_USER_ID],
    inviteCode: '',
    createdAt: new Date(s.createdAt),
  })), [spacesRaw]);

  const currentSpaceName = useMemo(
    () => (currentSpaceId ? spaces.find((s) => s.id === currentSpaceId)?.name ?? '' : 'Personal'),
    [currentSpaceId, spaces]
  );

  const categories = useMemo<Category[]>(() => categoriesRaw
    .filter((c) => c.spaceId === (currentSpaceId ?? 'personal'))
    .map((c) => ({
      id: c.id,
      name: c.name,
      workspaceId: c.spaceId === 'personal' ? null : c.spaceId,
      createdBy: LOCAL_USER_ID,
      createdAt: new Date(c.createdAt),
    })), [categoriesRaw, currentSpaceId]);

  const drops = useMemo(() => dropsRaw.map(dropDtoToDrop), [dropsRaw]);

  const setCurrentSpace = useCallback((id: string | null) => {
    spaceRef.current = id;
    setCurrentSpaceId(id);
    void refreshDropsInternal(id ?? 'personal');
  }, [refreshDropsInternal]);

  const fetchTextPayload = useCallback(async (dropId: string) => {
    const payload = await window.dropsync.drop.getPayload(dropId);
    return payload?.text ?? '';
  }, []);

  const getMediaUrl = useCallback((dropId: string, kind: 'file' | 'image') =>
    window.dropsync.media.getUrl(dropId, kind), []);

  const getMediaBytes = useCallback((dropId: string, kind: 'file' | 'image') =>
    window.dropsync.media.getBytes(dropId, kind), []);

  const value: VaultStoreValue = {
    status,
    folder,
    checking,
    spaces,
    currentSpaceId,
    currentSpaceName,
    categories,
    drops,
    loading,
    settings,
    theme,
    refreshAll,
    refreshSpaces,
    pickCreateFolder,
    refreshDrops,
    patchDropInPlace,
    patchDropsInPlace,
    appendDropInPlace,
    removeDropInPlace,
    upsertCategoryInPlace,
    setCurrentSpace,
    setTheme,
    updateSettings,
    handleUnlocked,
    handleLocked,
    startCreateFlow,
    reconcileStatus,
    fetchTextPayload,
    getMediaUrl,
    getMediaBytes,
  };

  return <VaultStoreContext.Provider value={value}>{children}</VaultStoreContext.Provider>;
}
