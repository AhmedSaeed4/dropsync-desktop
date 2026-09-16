/**
 * Preload — contextBridge surface. Promise APIs only; every call resolves with the handler's
 * value or REJECTS with the main-process error message (unwrapped from __dropsyncError).
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DropsyncBridge, ImportProgressDTO } from './apiTypes';

function invoke<T = void>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).then((value) => {
    if (value && typeof value === 'object' && '__dropsyncError' in (value as Record<string, unknown>)) {
      throw new Error(String((value as Record<string, unknown>).__dropsyncError));
    }
    return value as T;
  });
}

const api: DropsyncBridge = {
  vault: {
    create: (folder: string, password: string) => invoke('vault:create', folder, password),
    unlock: (folder: string, password: string) => invoke('vault:unlock', folder, password),
    lock: () => invoke('vault:lock'),
    changePassword: (oldPassword: string, newPassword: string) => invoke('vault:changePassword', oldPassword, newPassword),
    status: () => invoke('vault:status'),
    probeFolder: (folder: string) => invoke('vault:probeFolder', folder),
    prepareFolder: (folder: string) => invoke('vault:prepareFolder', folder),
    move: (newParentFolder: string) => invoke('vault:move', newParentFolder),
    listSpaces: () => invoke('vault:listSpaces'),
    createSpace: (name: string) => invoke('vault:createSpace', name),
    renameSpace: (id: string, name: string) => invoke('vault:renameSpace', id, name),
    deleteSpace: (id: string) => invoke('vault:deleteSpace', id),
    listCategories: (spaceId: string) => invoke('vault:listCategories', spaceId),
    createCategory: (spaceId: string, name: string) => invoke('vault:createCategory', spaceId, name),
    deleteCategory: (id: string) => invoke('vault:deleteCategory', id),
    importInspect: (filePath: string, password: string) => invoke('vault:importInspect', filePath, password),
    importRun: (options: { filePath: string; password: string; destination: unknown }) => invoke('vault:importRun', options),
    hasArchiveOverlap: (spaceId: string, archiveId: string) => invoke('vault:hasArchiveOverlap', spaceId, archiveId),
    settingsGet: () => invoke('vault:settingsGet'),
    settingsSet: (patch: Record<string, unknown>) => invoke('vault:settingsSet', patch),
    saveAs: (dropId: string, kind: 'file' | 'image') => invoke('drop:saveAs', dropId, kind),
    export: (scope: 'personal' | { workspaceId: string }, password: string, outPath: string) =>
      invoke('vault:export', scope, password, outPath),
    exportCancel: () => invoke('vault:exportCancel'),
  },
  drop: {
    list: (spaceId: string) => invoke('drop:list', spaceId),
    getMeta: (dropId: string) => invoke('drop:getMeta', dropId),
    getPayload: (dropId: string) => invoke('drop:getPayload', dropId),
    patch: (dropId: string, patch: Record<string, unknown>) => invoke('drop:patch', dropId, patch),
    delete: (dropId: string) => invoke('drop:delete', dropId),
    createText: (args: unknown) => invoke('drop:createText', args),
    createFileFromPath: (absolutePath: string, meta: unknown) => invoke('drop:createFileFromPath', absolutePath, meta),
    createFileFromBytes: (bytes: Uint8Array, displayName: string, mimeType: string | undefined, meta: unknown) =>
      invoke('drop:createFileFromBytes', bytes, displayName, mimeType, meta),
    updateContent: (dropId: string, updates: unknown) => invoke('drop:updateContent', dropId, updates),
    updateMeta: (dropId: string, patch: unknown) => invoke('drop:updateMeta', dropId, patch),
    // Round 107 (repair-order-107 §4 FIX B) — same unknown-args convention as createText/updateMeta;
    // the typed surface lives in apiTypes (DropTransferArgs/DropTransferResult).
    transfer: (args: unknown) => invoke('drop:transfer', args),
  },
  youtube: {
    refreshTitles: (spaceId: string) => invoke('youtube:refreshTitles', spaceId),
    // Round 114 — fetch-once-then-cache thumbnail; null offline/dead (placeholder stays).
    getThumbnail: (videoId: string) => invoke('youtube:getThumbnail', videoId),
  },
  mode: {
    get: () => invoke<'cloud' | 'local'>('mode:get'),
    set: (next: 'cloud' | 'local') => invoke<'cloud' | 'local'>('mode:set', next),
    devProbe: () => invoke<unknown>('mode:devProbe'),
  },
  onPillFlipRequested: (listener: (next: 'cloud' | 'local') => void): (() => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, next: 'cloud' | 'local'): void => {
      if (next === 'cloud' || next === 'local') listener(next);
    };
    ipcRenderer.on('pill:flipRequested', wrapped);
    return () => {
      ipcRenderer.removeListener('pill:flipRequested', wrapped);
    };
  },
  shell: {
    openExternal: (url: string) => invoke('shell:openExternal', url),
  },
  dialog: {
    pickOpen: (options?: { title?: string; extensions?: string[] }) => invoke('dialog:pickOpen', options ?? {}),
    pickOpenMultiple: (options?: { title?: string; extensions?: string[] }) => invoke('dialog:pickOpenMultiple', options ?? {}),
    pickSave: (options?: { suggestedName?: string }) => invoke('dialog:pickSave', options ?? {}),
    pickFolder: (options?: { title?: string }) => invoke('dialog:pickFolder', options ?? {}),
  },
  settings: {
    get: () => invoke('vault:settingsGet'),
    set: (patch: Record<string, unknown>) => invoke('vault:settingsSet', patch),
  },
  notify: (title: string, body: string) => invoke('notify', title, body),
  media: {
    getUrl: (dropId: string, kind: 'file' | 'image') => invoke('media:getUrl', dropId, kind),
    getBytes: (dropId: string, kind: 'file' | 'image') => invoke('media:getBytes', dropId, kind),
  },
  // Electron ≥32 removed File.path — webUtils.getPathForFile is the sanctioned replacement.
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file) ?? '';
    } catch {
      return '';
    }
  },
  onImportProgress: (listener: (progress: ImportProgressDTO) => void): (() => void) => {
    const wrapped = (_event: unknown, progress: ImportProgressDTO): void => listener(progress);
    ipcRenderer.on('vault:importProgress', wrapped as never);
    return () => ipcRenderer.removeListener('vault:importProgress', wrapped as never);
  },
  onNotifyFallback: (listener: (payload: { title: string; body: string }) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: { title: string; body: string }): void => listener(payload);
    ipcRenderer.on('vault:notifyFallback', wrapped as never);
    return () => ipcRenderer.removeListener('vault:notifyFallback', wrapped as never);
  },
  // DEV-ONLY harness seam (DROPSYNC_E2E_SIT3). Main registers the handler exclusively under that
  // env flag — in any other build this invoke rejects ("No handler registered for" the channel).
  dev: {
    testOnly: (action: string, dropId: string, value?: number) =>
      invoke('dev:testOnly', action, dropId, value),
  },
};

contextBridge.exposeInMainWorld('dropsync', api);

export type DropsyncApi = typeof api;
