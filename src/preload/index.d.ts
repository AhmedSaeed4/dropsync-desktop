import type { DropsyncBridge } from './apiTypes';

declare global {
  interface Window {
    dropsync: DropsyncBridge;
  }
}

export {};
