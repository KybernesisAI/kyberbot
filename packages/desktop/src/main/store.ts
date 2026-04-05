/**
 * Typed electron-store wrapper for persisting app state.
 */

import Store from 'electron-store';

interface StoreSchema {
  agentRoot: string | null;
  windowBounds: Record<string, { x: number; y: number; width: number; height: number }>;
  autoStart: boolean;
}

export class AppStore {
  private store: Store<StoreSchema>;

  constructor() {
    this.store = new Store<StoreSchema>({
      name: 'kyberbot-desktop',
      defaults: {
        agentRoot: null,
        windowBounds: {},
        autoStart: true,
      },
    });
  }

  getAgentRoot(): string | null {
    return this.store.get('agentRoot');
  }

  setAgentRoot(path: string): void {
    this.store.set('agentRoot', path);
  }

  getWindowBounds(name: string): { x: number; y: number; width: number; height: number } | undefined {
    const bounds = this.store.get('windowBounds');
    return bounds[name];
  }

  setWindowBounds(name: string, rect: { x: number; y: number; width: number; height: number }): void {
    const bounds = this.store.get('windowBounds');
    bounds[name] = rect;
    this.store.set('windowBounds', bounds);
  }

  getAutoStart(): boolean {
    return this.store.get('autoStart');
  }

  setAutoStart(value: boolean): void {
    this.store.set('autoStart', value);
  }
}
