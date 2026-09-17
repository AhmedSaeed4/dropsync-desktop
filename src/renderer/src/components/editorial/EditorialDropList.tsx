import { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef, memo, type ComponentProps } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Category, Drop } from '../../lib/types';
import { EditorialDropItem } from './EditorialDropItem';
import { EditorialMoveDropModal } from './EditorialMoveDropModal';
import HoldToDeleteButton from './HoldToDeleteButton';
import { UndoToast } from '../shared/UndoToast';
import { Toast } from '../shared/Toast';
import { isReminderFiredShared, isReminderGlowingForViewer, sortUnpinned, type DropSortMode } from '../../lib/dropsHelpers';
import { dropMatchesSearchQuery } from '../../lib/youtubeLabels';
import { useNow } from '../../hooks/useNow';
import { usePendingDeletions, requestDelete, undo, dismiss, performBatchDelete } from '../../lib/pendingDeletions';
import { invalidatePreviewPayload } from '../../lib/previewPayloadCache';
import { getEditorialThemeColors } from '../../lib/editorialTheme';
import { useVaultStore } from '../../store/vault';

interface EditorialDropListProps {
  drops: Drop[];
  loading: boolean;
  onDelete: () => void;
  onPreview: (drop: Drop) => void;
  /** Right-click → Edit (routed to the EditorialTextModal by the app shell). */
  onEdit?: (drop: Drop) => void;
  categories?: Category[];
  theme?: 'light' | 'dark' | 'minimal';
  currentUserId?: string;
  currentSpaceKey: string; // workspace id or 'personal'
}

const BUILT_IN_CATEGORIES = [
  { value: 'all', label: 'All' },
  { value: 'files', label: 'Files' },
  { value: 'password', label: 'Password' },
  { value: 'link', label: 'Link' },
];

type PillItem =
  | { kind: 'builtin'; key: string; value: string; label: string; count: number | undefined }
  | { kind: 'uncategorized'; key: string; value: string; label: string; count: number }
  | { kind: 'custom'; key: string; value: string; label: string; count: number; cat: Category };

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const SORT_OPTIONS: { value: DropSortMode; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'manual', label: 'Manual' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'size', label: 'Size' },
  { value: 'expiry', label: 'Expiry' },
];

function useFinePointer(): boolean {
  const [fine, setFine] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(pointer: fine)');
    const update = () => setFine(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return fine;
}

const SortableEditorialDropItem = memo(function SortableEditorialDropItem(props: ComponentProps<typeof EditorialDropItem>) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.drop.id });
  const dragHandleProps = useMemo(() => ({ ...attributes, ...listeners }), [attributes, listeners]);
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition: transition ?? undefined,
        zIndex: isDragging ? 50 : undefined,
        opacity: isDragging ? 0.85 : undefined,
      }}
    >
      <EditorialDropItem {...props} showDragHandle dragHandleProps={dragHandleProps} />
    </div>
  );
});

export function EditorialDropList({
  drops,
  loading,
  onDelete,
  onPreview,
  onEdit,
  categories = [],
  theme = 'light',
  currentUserId,
  currentSpaceKey,
}: EditorialDropListProps) {
  const { settings, updateSettings, removeDropInPlace } = useVaultStore();
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // FIX 5 (web #225) superseded 2026-09-17 (#33): the web replaced the two-tap confirm with
  // the press-and-hold HoldToDeleteButton — this file now carries the same component and the
  // web's deleting/holdDone sequence (D10). The undo-toast pipeline for SINGLE deletes sits
  // downstream of its own path and is untouched.
  const [deleting, setDeleting] = useState(false);
  const [holdDone, setHoldDone] = useState(false);
  // Round 107 (order §4 FIX G) — bulk move/copy: the modal's drops, the in-modal error banner
  // (web's alert() has no desktop counterpart, D16) and the busy flag the modal's close paths veto on.
  const [bulkMoveDrops, setBulkMoveDrops] = useState<Drop[] | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [bulkMoving, setBulkMoving] = useState(false);
  const { pending: pendingDeletions, tombstone: deletedDropIds } = usePendingDeletions();
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [pinLimitToast, setPinLimitToast] = useState(false);

  useEffect(() => { setSelectedCategory('all'); }, [categories]);
  const [confirmDeleteCategory, setConfirmDeleteCategory] = useState<string | null>(null);

  const tc = getEditorialThemeColors(theme);
  const font = tc.fontClass;

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = () => {
    if (selectedIds.size === filteredDrops.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredDrops.map(d => d.id)));
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setDeleting(true);
    const selectedDrops = filteredDrops.filter(d => selectedIds.has(d.id));
    // FIX 17: ONE deletion pipeline. performBatchDelete tombstones every selected id
    // SYNCHRONOUSLY inside THIS hold's commit — the same hide mechanism, start timing,
    // exit tween and neighbor glide as the single-delete undo flow (requestDelete), for a
    // batch of 1 or N. The IPC deletes commit behind the curtain through removeDropInPlace
    // (zero visual event). No undo toast is created — web parity (requestDelete stays
    // single-only; the web's bulk path likewise bypasses the undo store).
    await performBatchDelete(selectedDrops, handleCommittedDelete);
    selectedDrops.forEach(d => invalidatePreviewPayload(d.id));
    setDeleting(false);
    setHoldDone(true);
    // D10 sequence (web parity): the green "Deleted ✓" beat plays, THEN the toolbar closes
    // out — clear the selection, exit selection mode, drop the done beat.
    window.setTimeout(() => {
      setSelectedIds(new Set());
      setSelectionMode(false);
      setHoldDone(false);
    }, 650);
  };

  const cancelSelection = () => {
    setSelectedIds(new Set());
    setSelectionMode(false);
  };

  // Round 107 (order §4 FIX G) — bulk move/copy. THIN by design: main owns category
  // pre-resolution and per-drop isolation (transferDrops); this mirrors web W4's post-op
  // contract (EditorialDropList.tsx:1356-1360/:1385-1389) — failures keep the modal open with
  // web's exact alert wording (banner instead, D16); full success closes the modal, clears the
  // selection, exits selection mode; moved ids leave the list silently (removeDropInPlace, D9).
  const runBulkTransfer = async (mode: 'move' | 'copy', targetSpaceId: string) => {
    if (!bulkMoveDrops?.length) return;
    setBulkMoving(true);
    try {
      const out = await window.dropsync.drop.transfer({
        mode, targetSpaceId, dropIds: bulkMoveDrops.map((d) => d.id),
      });
      if (!out.ok || !out.results) {
        setMoveError(out.error ?? 'Failed to prepare categories. Please try again.');
        return; // modal stays open (web parity, W4)
      }
      const failures = out.results.filter((r) => !r.success);
      if (failures.length > 0) {
        setMoveError(`${failures.length}/${out.results.length} drops failed to ${mode}: ${failures[0].error}`);
        return;
      }
      // full success — web :1356-1360
      const movedIds = mode === 'move' ? out.results.map((r) => r.id) : [];
      setBulkMoveDrops(null);
      setMoveError(null);
      setSelectedIds(new Set());
      setSelectionMode(false);
      if (movedIds.length > 0) removeDropInPlace(movedIds); // silent in-place removal (D9)
      onDelete();
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : String(error));
    } finally {
      setBulkMoving(false);
    }
  };

  // FIX 13: the behind-the-curtain commit of the undo flow — tombstone already hid the card,
  // so this must produce ZERO visual event: in-place removal + per-id preview-cache drop.
  const handleCommittedDelete = useCallback((dropId: string) => {
    removeDropInPlace(dropId);
    invalidatePreviewPayload(dropId);
  }, [removeDropInPlace]);

  const handleDeleteWithUndo = useCallback((drop: Drop) => requestDelete(drop, handleCommittedDelete), [handleCommittedDelete]);
  const handleUndoDeletion = useCallback((dropId: string) => undo(dropId), []);
  const handleDismissToast = useCallback((dropId: string) => dismiss(dropId, handleCommittedDelete), [handleCommittedDelete]);

  const visibleDrops = drops.filter(d => !pendingDeletions.has(d.id) && !deletedDropIds.has(d.id));

  // FIX 15: web-parity gate. The DOM battery can force the reduced-motion path through a
  // window flag (nothing sets __dropsyncForceReducedMotion in production) so BOTH branches
  // of the removal choreography are assertable end-to-end.
  const forcedReducedMotion =
    typeof window !== 'undefined' &&
    (window as unknown as { __dropsyncForceReducedMotion?: boolean }).__dropsyncForceReducedMotion === true;
  const prefersReducedMotion = useReducedMotion() || forcedReducedMotion;
  const isFiltered = searchQuery.trim() !== '' || selectedCategory !== 'all';
  // FIX 15: every drop card renders inside a motion wrapper — removals shrink-fade exactly
  // like the web ({opacity:0, scale:0.9} under AnimatePresence mode="popLayout", layout on the
  // item so survivors glide closed). Reduced motion degrades to an opacity-only quick fade.
  const cardExit = prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 };
  const wrapperTransition = prefersReducedMotion
    ? { duration: 0.12, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] }
    : { duration: 0.2, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };
  const wrapperInitial = prefersReducedMotion
    ? false
    : ({ opacity: 0, scale: 0.97 } as const);

  const finePointer = useFinePointer();
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handlePinDrop = useCallback(async (drop: Drop) => {
    if (drop.pinned) {
      await window.dropsync.drop.patch(drop.id, { pinned: false });
    } else {
      const pinnedCount = visibleDrops.filter(d => d.pinned).length;
      if (pinnedCount >= 2) {
        setPinLimitToast(true);
        return;
      }
      await window.dropsync.drop.patch(drop.id, { pinned: true });
    }
    onDelete(); // parent refresh
  }, [visibleDrops, onDelete]);

  const hasCategory = (drop: Drop, cat: string) =>
    (drop.categories && drop.categories.includes(cat)) || drop.category === cat;

  const getCategories = (drop: Drop) =>
    drop.categories && drop.categories.length > 0 ? drop.categories : (drop.category ? [drop.category] : []);

  const dropCounts = useMemo(() => {
    const counts: { [key: string]: number } = {
      all: visibleDrops.length,
      files: visibleDrops.filter(d => d.type === 'file').length,
      password: visibleDrops.filter(d => hasCategory(d, 'password')).length,
      link: visibleDrops.filter(d => hasCategory(d, 'link')).length,
      uncategorized: visibleDrops.filter(d => d.type === 'text' && getCategories(d).length === 0).length,
    };
    categories.forEach(cat => {
      counts[cat.name] = visibleDrops.filter(d => hasCategory(d, cat.name)).length;
    });
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleDrops, categories]);

  // --- Collapsible category strip (per-space pref persisted in vault settings) ---
  const spaceKeyRef = useRef(currentSpaceKey);
  spaceRef_key(spaceKeyRef, currentSpaceKey);

  const measureRef = useRef<HTMLDivElement>(null);
  const prefsRef = useRef<Record<string, boolean>>({});
  const [overflows, setOverflows] = useState(false);
  const [collapsedHeight, setCollapsedHeight] = useState(0);
  const [expandedHeight, setExpandedHeight] = useState(0);
  const [firstRowCount, setFirstRowCount] = useState(Infinity);
  const [catCollapsed, setCatCollapsed] = useState(true);
  const [animateCollapse, setAnimateCollapse] = useState(false);
  const [animating, setAnimating] = useState(false);

  // Seed prefs from the store once loaded (localStorage mirror = polish sweep #2 fallback so the
  // collapse state survives even before settings load).
  useEffect(() => {
    prefsRef.current = settings?.collapsed ?? {};
    const cachedCollapsed = localStorageMirror(`dropsync.collapsed.${currentSpaceKey}`);
    setAnimateCollapse(false);
    setCatCollapsed(prefsRef.current[currentSpaceKey] ?? cachedCollapsed ?? true);
  }, [settings, currentSpaceKey]);

  const measurePillsOverflow = useCallback(() => {
    const el = measureRef.current;
    if (!el) return;
    const children = Array.from(el.children) as HTMLElement[];
    if (children.length === 0) {
      setOverflows(false);
      setCollapsedHeight(0);
      setExpandedHeight(0);
      setFirstRowCount(Infinity);
      return;
    }
    const pillCount = children.length - 1;
    const firstTop = children[0].offsetTop;
    let firstRowBottom = 0;
    let contentBottom = 0;
    let wrapIndex = pillCount;
    let sentinelTop = firstTop;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const top = child.offsetTop;
      const bottom = top + child.offsetHeight;
      if (i === pillCount) {
        sentinelTop = top;
      } else if (top > firstTop + 2 && wrapIndex === pillCount) {
        wrapIndex = i;
      }
      if (top <= firstTop + 2 && bottom > firstRowBottom) firstRowBottom = bottom;
      if (bottom > contentBottom) contentBottom = bottom;
    }
    const overflowPills = wrapIndex < pillCount;
    const count = !overflowPills
      ? Infinity
      : sentinelTop <= firstTop + 2
        ? wrapIndex
        : Math.max(1, wrapIndex - 1);
    setOverflows(overflowPills);
    setCollapsedHeight(firstRowBottom - firstTop);
    setExpandedHeight(contentBottom - firstTop);
    setFirstRowCount(count);
  }, []);

  useIsomorphicLayoutEffect(() => {
    measurePillsOverflow();
    const el = measureRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measurePillsOverflow());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measurePillsOverflow]);

  useIsomorphicLayoutEffect(() => {
    measurePillsOverflow();
  }, [categories, loading, dropCounts, measurePillsOverflow]);

  const toggleCollapse = useCallback(() => {
    const next = !catCollapsed;
    prefsRef.current = { ...prefsRef.current, [currentSpaceKey]: next };
    localStorageMirrorWrite(`dropsync.collapsed.${currentSpaceKey}`, next);
    setAnimateCollapse(true);
    setAnimating(true);
    setCatCollapsed(next);
    void updateSettings({ collapsed: { ...prefsRef.current } });
  }, [catCollapsed, currentSpaceKey, updateSettings]);

  // --- Drop sort + manual reorder (per-space, persisted in vault settings) ---
  const [sortMode, setSortModeState] = useState<DropSortMode>('newest');
  const [manualOrder, setManualOrder] = useState<string[]>([]);
  const sortPrefsRef = useRef<{ mode: Record<string, string>; order: Record<string, string[]> }>({ mode: {}, order: {} });

  useEffect(() => {
    sortPrefsRef.current = settings?.listPrefs?.[currentSpaceKey] ?? { mode: {}, order: {} };
    const cachedMode = localStorageMirror(`dropsync.sort.${currentSpaceKey}`);
    setSortModeState((sortPrefsRef.current.mode[currentSpaceKey] as DropSortMode) ?? cachedMode ?? 'newest');
    setManualOrder(sortPrefsRef.current.order[currentSpaceKey] ?? []);
  }, [settings, currentSpaceKey]);

  const handleSortChange = useCallback((mode: DropSortMode) => {
    setSortModeState(mode);
    localStorageMirrorWrite(`dropsync.sort.${currentSpaceKey}`, mode);
    const perSpace = settings?.listPrefs ?? {};
    const entry = perSpace[currentSpaceKey] ?? { mode: {}, order: {} };
    void updateSettings({
      listPrefs: {
        ...perSpace,
        [currentSpaceKey]: { ...entry, mode: { ...entry.mode, [currentSpaceKey]: mode } },
      },
    });
  }, [currentSpaceKey, settings, updateSettings]);

  const commitManualOrder = useCallback((ids: string[]) => {
    setManualOrder(ids);
    const perSpace = settings?.listPrefs ?? {};
    const entry = perSpace[currentSpaceKey] ?? { mode: {}, order: {} };
    void updateSettings({
      listPrefs: {
        ...perSpace,
        [currentSpaceKey]: { ...entry, order: { ...entry.order, [currentSpaceKey]: ids } },
      },
    });
  }, [currentSpaceKey, settings, updateSettings]);

  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [sortMenuPos, setSortMenuPos] = useState<{ top: number; left: number } | null>(null);
  const sortTriggerRef = useRef<HTMLButtonElement>(null);
  const currentSortLabel = SORT_OPTIONS.find((o) => o.value === sortMode)?.label ?? 'Newest';
  const openSortMenu = () => {
    const rect = sortTriggerRef.current?.getBoundingClientRect();
    if (rect) {
      const MENU_WIDTH = 176;
      setSortMenuPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - MENU_WIDTH) });
    }
    setSortMenuOpen(true);
  };

  const currentManualIds = useCallback(
    () => sortUnpinned(visibleDrops.filter((d) => !d.pinned), 'manual', manualOrder).map((d) => d.id),
    [visibleDrops, manualOrder]
  );

  const moveDropSlot = useCallback((dropId: string, direction: 'up' | 'down') => {
    const ids = currentManualIds();
    const i = ids.indexOf(dropId);
    if (i < 0) return;
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return;
    commitManualOrder(arrayMove(ids, i, j));
  }, [currentManualIds, commitManualOrder]);

  const moveUp = useCallback((id: string) => moveDropSlot(id, 'up'), [moveDropSlot]);
  const moveDown = useCallback((id: string) => moveDropSlot(id, 'down'), [moveDropSlot]);
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = currentManualIds();
    const oldIndex = ids.indexOf(active.id as string);
    const newIndex = ids.indexOf(over.id as string);
    if (oldIndex < 0 || newIndex < 0) return;
    commitManualOrder(arrayMove(ids, oldIndex, newIndex));
  }, [currentManualIds, commitManualOrder]);

  // One ticking "now" (30 s, web parity) drives fired-tier promotion, card glow AND
  // demotion-on-dismiss — all within a single tick, no unrelated activity required.
  const now = useNow(30_000);

  // Filter → 3 tiers: fired reminders > pinned (newest-first) > unpinned (selected sort).
  const filteredDrops = useMemo(() => {
    const filtered = visibleDrops.filter(drop => {
      if (searchQuery && !dropMatchesSearchQuery(
        { name: drop.name, content: drop.content ?? '', categories: getCategories(drop), youtubeVideoLabels: drop.youtubeVideoLabels },
        searchQuery
      )) {
        return false;
      }
      if (selectedCategory === 'all') return true;
      if (selectedCategory === 'files') return drop.type === 'file';
      if (selectedCategory === 'uncategorized') return drop.type === 'text' && getCategories(drop).length === 0;
      return hasCategory(drop, selectedCategory);
    });
    const fired = filtered
      .filter((d) => isReminderFiredShared(d, now))
      .sort((a, b) => a.reminderAt!.getTime() - b.reminderAt!.getTime());
    const pinned = filtered
      .filter((d) => d.pinned && !isReminderFiredShared(d, now))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const unpinned = sortUnpinned(
      filtered.filter((d) => !d.pinned && !isReminderFiredShared(d, now)),
      sortMode,
      manualOrder
    );
    return [...fired, ...pinned, ...unpinned];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleDrops, selectedCategory, searchQuery, sortMode, manualOrder, now]);

  const showMoveControls = sortMode === 'manual' && !isFiltered && !selectionMode;
  const enableDrag = showMoveControls && finePointer;
  const manualIndexById = useMemo(() => {
    const m = new Map<string, number>();
    if (showMoveControls) {
      let i = 0;
      for (const d of filteredDrops) {
        if (!d.pinned) m.set(d.id, i++);
      }
    }
    return m;
  }, [showMoveControls, filteredDrops]);
  const manualCount = manualIndexById.size;

  const handleCategoryDeleteClick = (categoryId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteCategory(categoryId);
  };
  const handleCategoryConfirmDelete = (categoryId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    void window.dropsync.vault.deleteCategory(categoryId).then(onDelete);
    setConfirmDeleteCategory(null);
  };
  const handleCategoryCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteCategory(null);
  };

  const shimmerClass = theme === 'dark' ? 'skeleton-shimmer-dark' : theme === 'minimal' ? 'skeleton-shimmer-minimal' : 'skeleton-shimmer-light';

  const pillItems = useMemo<PillItem[]>(() => {
    const items: PillItem[] = BUILT_IN_CATEGORIES.map((cat) => ({
      kind: 'builtin' as const,
      key: cat.value,
      value: cat.value,
      label: cat.label,
      count: dropCounts[cat.value],
    }));
    if (!loading && (dropCounts['uncategorized'] ?? 0) > 0) {
      items.push({ kind: 'uncategorized', key: 'uncategorized', value: 'uncategorized', label: 'Uncategorized', count: dropCounts['uncategorized'] });
    }
    if (!loading) {
      categories.forEach((cat) => {
        items.push({ kind: 'custom', key: cat.id, value: cat.name, label: cat.name, count: dropCounts[cat.name] || 0, cat });
      });
    }
    return items;
  }, [categories, dropCounts, loading]);

  const togglePillClasses = `flex items-center gap-1 px-2.5 py-1 text-xs ${font} ${tc.roundedClass} transition-colors ${tc.inactivePillBg} ${tc.inactivePillText} ${tc.inactivePillHoverBg}`;

  const showTrimmed = catCollapsed && !animating && overflows;
  const showToggle = overflows && (!catCollapsed || !animating);
  const visibleItems = showTrimmed ? pillItems.slice(0, firstRowCount) : pillItems;

  const renderPill = (item: PillItem) => {
    const isActive = selectedCategory === item.value;
    const stateCls = isActive
      ? `${tc.activePillBg} ${tc.activePillText}`
      : `${tc.inactivePillBg} ${tc.inactivePillText} ${tc.inactivePillHoverBg}`;

    if (item.kind === 'builtin') {
      return (
        <button
          key={item.key}
          onClick={() => setSelectedCategory(item.value)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs ${font} ${tc.roundedClass} transition-colors ${stateCls}`}
        >
          <span>{item.label}</span>
          {!loading && item.count !== undefined && (
            <span className={`text-[10px] ${isActive ? tc.activePillCountText : tc.muted}`}>{item.count}</span>
          )}
        </button>
      );
    }

    if (item.kind === 'uncategorized') {
      return (
        <button
          key={item.key}
          onClick={() => setSelectedCategory(item.value)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs ${font} ${tc.roundedClass} transition-colors ${stateCls}`}
        >
          <span>Uncategorized</span>
          <span className={`text-[10px] ${isActive ? tc.activePillCountText : tc.muted}`}>{item.count}</span>
        </button>
      );
    }

    const showDelete = item.count === 0 && confirmDeleteCategory !== item.cat.id;
    return (
      <div key={item.key} className="relative flex items-center">
        <button
          onClick={() => setSelectedCategory(item.value)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs ${font} ${tc.roundedClass} transition-colors ${stateCls} ${showDelete ? 'pr-1' : ''}`}
        >
          <span>{item.cat.name}</span>
          <span className={`text-[10px] ${isActive ? tc.activePillCountText : tc.muted}`}>{item.count}</span>
        </button>

        {item.count === 0 && confirmDeleteCategory !== item.cat.id && (
          <button
            onClick={(e) => handleCategoryDeleteClick(item.cat.id, e)}
            className={`ml-1 w-4 h-4 flex items-center justify-center ${tc.muted} hover:text-red-500 transition-colors`}
            title="Delete category"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}

        {confirmDeleteCategory === item.cat.id && (
          <div className="flex items-center ml-1 gap-1">
            <button
              onClick={(e) => handleCategoryConfirmDelete(item.cat.id, e)}
              className="px-2 py-1 text-xs bg-red-500 text-white hover:bg-red-600 transition-colors rounded"
              title="Confirm delete"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </button>
            <button
              onClick={handleCategoryCancelDelete}
              className="px-2 py-1 text-xs border border-[#1A1A1A]/20 hover:bg-[#1A1A1A]/10 transition-colors rounded"
              title="Cancel"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {/* Section title */}
      <div className="flex items-center gap-2 px-1">
        <span className={`text-xs ${tc.muted}`}>&#9670;</span>
        <h2 className={`${font} ${tc.text} font-medium tracking-tight text-sm`}>Your Drops</h2>
        {!loading && (
          <span className={`${font} ${tc.muted} text-xs`}>
            {filteredDrops.length}/{visibleDrops.length}
          </span>
        )}
      </div>

      <div className={`${tc.bg} border ${tc.border} ${tc.roundedClass} overflow-hidden`}>
        {/* Category filter pills */}
        <div className={`border-b ${tc.border} px-4 py-3`}>
          <div
            ref={measureRef}
            aria-hidden="true"
            className="flex flex-wrap gap-2"
            style={{ height: 0, overflow: 'hidden' }}
          >
            {pillItems.map(renderPill)}
            <span className={togglePillClasses} aria-hidden="true">{'>>'}</span>
          </div>

          <motion.div
            className="relative flex flex-wrap gap-2"
            initial={false}
            animate={{ height: catCollapsed ? collapsedHeight : expandedHeight }}
            transition={{ duration: animateCollapse ? 0.25 : 0, ease: [0.4, 0, 0.2, 1] }}
            style={{ overflow: 'hidden' }}
            onAnimationComplete={() => setAnimating(false)}
          >
            {visibleItems.map(renderPill)}
            {showToggle && (
              <button
                type="button"
                onClick={toggleCollapse}
                className={togglePillClasses}
                aria-label={catCollapsed ? 'Show all categories' : 'Show fewer categories'}
                title={catCollapsed ? 'Show all' : 'Show less'}
              >
                <span>{catCollapsed ? '>>' : '<<'}</span>
              </button>
            )}
          </motion.div>
        </div>

        {/* Search bar */}
        <div className={`border-b ${tc.border} px-4 py-3`}>
          <div className="relative">
            <svg className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            <div className={`flex items-center w-full ${tc.cardBg} border ${tc.border} ${tc.text} pl-10 pr-4 py-2 text-sm ${font} focus-within:outline-none focus-within:ring-1 focus-within:ring-[#1A1A1A]/20 transition-colors ${tc.roundedClass} ${loading ? 'opacity-50' : ''}`}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search drops... (# searches video titles)"
                disabled={loading}
                className={`w-full bg-transparent border-none outline-none text-sm ${theme === 'dark' ? 'placeholder:text-white/30' : 'placeholder:text-[#1A1A1A]/30'}`}
              />
            </div>
            {!searchQuery ? null : (
              <button
                onClick={() => setSearchQuery('')}
                className={`absolute right-3 top-1/2 -translate-y-1/2 ${tc.muted} hover:${tc.text} transition-colors`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Selection / sort controls */}
        {!loading && (
          <div className={`border-b ${tc.border} px-4 py-2 flex items-center justify-between`}>
            {!selectionMode ? (
              <>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setSelectionMode(true)}
                    className={`text-xs ${font} ${tc.muted} ${tc.inactivePillHoverBg} px-3 py-1.5 ${tc.roundedClass} border ${tc.border} transition-colors flex items-center gap-1.5`}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                      <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    Select
                  </button>
                  <AnimatePresence initial={false}>
                    {false && (
                      <motion.button type="button">{/* export slot — Sitting 3 */}</motion.button>
                    )}
                  </AnimatePresence>
                </div>
                <button
                  ref={sortTriggerRef}
                  type="button"
                  onClick={openSortMenu}
                  onKeyDown={(e) => { if (e.key === 'Escape') setSortMenuOpen(false); }}
                  aria-haspopup="menu"
                  aria-expanded={sortMenuOpen}
                  className={`text-xs ${font} ${tc.muted} ${tc.inactivePillHoverBg} px-3 py-1.5 ${tc.roundedClass} border ${tc.border} transition-colors flex items-center gap-1.5`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5h18M6 12h12M9 16.5h6" />
                  </svg>
                  <span>{currentSortLabel}</span>
                  <svg className={`w-3 h-3 transition-transform ${sortMenuOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              </>
            ) : (
              <div className="flex items-center gap-2 w-full">
                <button
                  onClick={selectAll}
                  className={`text-xs ${font} ${tc.muted} ${tc.inactivePillHoverBg} px-3 py-1.5 ${tc.roundedClass} border ${tc.border} transition-colors`}
                >
                  {selectedIds.size === filteredDrops.length ? 'Deselect' : 'Select all'}
                </button>
                <button
                  onClick={cancelSelection}
                  className={`text-xs ${font} ${tc.muted} ${tc.inactivePillHoverBg} px-3 py-1.5 ${tc.roundedClass} border ${tc.border} transition-colors`}
                >
                  Cancel
                </button>
                {selectedIds.size > 0 && (
                  <>
                    {/* Round 107 — bulk Move pill (web EditorialDropList.tsx:1032-1042 placement:
                        ml-auto on Move, Delete follows plain) */}
                    <button
                      onClick={() => {
                        const selectedDrops = filteredDrops.filter(d => selectedIds.has(d.id));
                        setBulkMoveDrops(selectedDrops);
                      }}
                      className={`text-xs ${font} px-3 py-1.5 ml-auto ${tc.roundedClass} ${tc.activePillBg} ${tc.activePillText} hover:opacity-90 transition-opacity flex items-center gap-1`}
                    >
                      Move {selectedIds.size}
                    </button>
                    <HoldToDeleteButton
                      variant="full"
                      count={selectedIds.size}
                      deleting={deleting}
                      done={holdDone}
                      onHoldComplete={handleBulkDelete}
                      className={`h-7 px-3 ${tc.roundedClass} hover:bg-red-600 transition-colors ${font}`}
                    />
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Sort dropdown menu */}
        {sortMenuOpen && sortMenuPos && (
          <>
            <div
              className={`border shadow-lg z-[100] py-1 ${tc.cardBg} ${tc.border} ${tc.roundedClass}`}
              style={{ position: 'fixed', top: `${sortMenuPos.top}px`, left: `${sortMenuPos.left}px`, width: '176px' }}
            >
              {SORT_OPTIONS.map((o) => {
                const active = o.value === sortMode;
                return (
                  <button
                    key={o.value}
                    onClick={() => { handleSortChange(o.value); setSortMenuOpen(false); }}
                    className={`w-full px-3 py-1.5 text-left text-xs ${font} flex items-center justify-between gap-2 transition-colors ${
                      active ? `${tc.activePillBg} ${tc.activePillText}` : `${tc.text} ${tc.inactivePillHoverBg}`
                    }`}
                  >
                    <span>{o.label}</span>
                    {active && (
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="fixed inset-0 z-[99]" onClick={() => setSortMenuOpen(false)} />
          </>
        )}

        {/* Drop list */}
        <div className="max-h-[500px] overflow-y-auto overflow-x-hidden thin-scrollbar">
          {loading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className={`border ${tc.border} ${tc.roundedClass} p-3 flex flex-col sm:flex-row sm:items-center gap-3`}>
                  <div className={`w-10 h-10 ${tc.roundedClass} ${shimmerClass} shrink-0`} />
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className={`h-4 ${tc.roundedClass} ${shimmerClass} w-3/5`} />
                    <div className={`h-3 ${tc.roundedClass} ${shimmerClass} w-2/5`} />
                  </div>
                  <div className="flex items-center gap-1 pt-2 sm:pt-0 border-t sm:border-t-0 w-full sm:w-auto justify-end">
                    <div className={`w-8 h-7 ${tc.roundedClass} ${shimmerClass}`} />
                    <div className={`w-8 h-7 ${tc.roundedClass} ${shimmerClass}`} />
                    <div className={`w-8 h-7 ${tc.roundedClass} ${shimmerClass}`} />
                  </div>
                </div>
              ))}
            </div>
          ) : visibleDrops.length === 0 && pendingDeletions.size === 0 ? (
            <div className="p-12 text-center">
              <div className={`w-16 h-16 mx-auto border ${tc.border} ${tc.roundedClass} flex items-center justify-center mb-4`}>
                <svg className={`w-7 h-7 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1">
                  <path d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                </svg>
              </div>
              <p className={`text-sm ${font} ${tc.text} font-medium`}>No drops yet</p>
              <p className={`text-xs ${font} ${tc.muted} mt-1`}>Import a .dropsync backup to get started</p>
            </div>
          ) : filteredDrops.length === 0 ? (
            <div className="p-8 text-center">
              <p className={`text-xs ${font} ${tc.muted}`}>
                {searchQuery ? 'No drops match your search' : 'No drops in this category'}
              </p>
            </div>
          ) : (
            // FIX 15: ONE stable tree for every mode (drag / animated / filtered / reduced).
            // The old per-mode ternary swapped whole subtree families, so ANY toggle around the
            // list (e.g. exiting selection mode flips enableDrag in manual sort) unmounted
            // AnimatePresence mid-flight and silently skipped the web-parity removal choreography.
            // Now only the INNER item component toggles; the motion wrappers that AnimatePresence
            // tracks persist through every mode change, so exits {opacity:0, scale:0.9} always
            // play while neighbors glide closed (layout). DndContext is inert while drag is
            // disabled (sensors stay idle); SortableContext receives items only when draggable.
            // Reduced motion: no entrance, opacity-only quick fade — never a snap.
            <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              {/* FIX 17 rider: `relative` anchors popLayout's absolutely-positioned exiting cards
                  to THIS container exactly like the web's list (<div className="relative p-3
                  space-y-2">) — without it exits anchored to the document root and flew. */}
              <div className="relative p-3 space-y-2">
                <SortableContext
                  items={enableDrag ? filteredDrops.filter((d) => !d.pinned && !isReminderFiredShared(d, now)).map((d) => d.id) : []}
                  strategy={verticalListSortingStrategy}
                >
                  <AnimatePresence initial={false} mode="popLayout">
                    {filteredDrops.map((drop) => {
                      const moveIdx = manualIndexById.get(drop.id);
                      const draggable = enableDrag && !drop.pinned && !isReminderFiredShared(drop, now);
                      return (
                        <motion.div
                          key={drop.id}
                          layout
                          initial={wrapperInitial}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={cardExit}
                          transition={wrapperTransition}
                        >
                          {draggable ? (
                            <SortableEditorialDropItem
                              drop={drop}
                              onDelete={handleDeleteWithUndo}
                              onPreview={onPreview}
                              selected={selectedIds.has(drop.id)}
                              onSelect={toggleSelect}
                              selectionMode={selectionMode}
                              theme={theme}
                              currentUserId={currentUserId}
                              reminderGlow={isReminderGlowingForViewer(drop, currentUserId ?? null, now)}
                              onPin={handlePinDrop}
                              onUnpin={handlePinDrop}
                              onEdit={onEdit}
                              allDrops={drops}
                            />
                          ) : (
                            <EditorialDropItem
                              drop={drop}
                              onDelete={handleDeleteWithUndo}
                              onPreview={onPreview}
                              selected={selectedIds.has(drop.id)}
                              onSelect={toggleSelect}
                              selectionMode={selectionMode}
                              theme={theme}
                              currentUserId={currentUserId}
                              reminderGlow={isReminderGlowingForViewer(drop, currentUserId ?? null, now)}
                              onPin={handlePinDrop}
                              onUnpin={handlePinDrop}
                              onEdit={onEdit}
                              allDrops={drops}
                              showMoveControls={moveIdx !== undefined}
                              canMoveUp={moveIdx !== undefined && moveIdx > 0}
                              canMoveDown={moveIdx !== undefined && moveIdx < manualCount - 1}
                              onMoveUp={moveUp}
                              onMoveDown={moveDown}
                            />
                          )}
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </SortableContext>
              </div>
            </DndContext>
          )}
        </div>
      </div>

      {/* Undo toasts */}
      {Array.from(pendingDeletions.values()).map((pending, index) => (
        <UndoToast
          key={pending.drop.id}
          message="Drop deleted"
          dropName={pending.drop.name}
          onUndo={() => handleUndoDeletion(pending.drop.id)}
          onDismiss={() => handleDismissToast(pending.drop.id)}
          duration={30}
          expiresAt={pending.expiresAt}
          theme={theme}
          index={index}
          editorial
        />
      ))}

      {/* Pin limit toast */}
      {pinLimitToast && (
        <Toast
          message="Max 2 pinned drops per space. Unpin another drop first."
          duration={3}
          theme={theme}
          editorial
          onDone={() => setPinLimitToast(false)}
        />
      )}

      {/* Bulk move/copy modal (round 107) — hosted at the component tail, mirroring the web's
          placement (EditorialDropList.tsx:1330-1397). Close paths veto while a transfer runs. */}
      {bulkMoveDrops && bulkMoveDrops.length > 0 && (
        <EditorialMoveDropModal
          drops={bulkMoveDrops}
          onMove={(t) => runBulkTransfer('move', t)}
          onCopy={(t) => runBulkTransfer('copy', t)}
          onClose={() => { if (!bulkMoving) setBulkMoveDrops(null); }}
          error={moveError}
          theme={theme}
        />
      )}
    </div>
  );
}

// Keep a ref synced to the latest space key without re-triggering effects.
function spaceRef_key(ref: React.MutableRefObject<string>, value: string) {
  ref.current = value;
}

// ---- localStorage mirrors (polish sweep #2) — safe in every storage mode ----
function localStorageMirror(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function localStorageMirrorWrite(key: string, value: string | boolean): void {
  try { localStorage.setItem(key, String(value)); } catch { /* private mode */ }
}
