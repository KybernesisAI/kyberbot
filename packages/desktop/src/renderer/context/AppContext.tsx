/**
 * App-wide context: API token, server URL, health state, agent root.
 */

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { HealthData } from '../../types/ipc';

interface AppContextValue {
  agentRoot: string | null;
  apiToken: string | null;
  serverUrl: string;
  health: HealthData | null;
  cliStatus: string;
  isReady: boolean; // true once config is loaded
}

const AppContext = createContext<AppContextValue>({
  agentRoot: null,
  apiToken: null,
  serverUrl: 'http://localhost:3456',
  health: null,
  cliStatus: 'stopped',
  isReady: false,
});

export function useApp(): AppContextValue {
  return useContext(AppContext);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [agentRoot, setAgentRoot] = useState<string | null>(null);
  const [apiToken, setApiToken] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState('http://localhost:3456');
  const [health, setHealth] = useState<HealthData | null>(null);
  const [cliStatus, setCliStatus] = useState('stopped');
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    // Load config on mount
    const init = async () => {
      const kb = (window as any).kyberbot;
      if (!kb) return;

      const root = await kb.config.getAgentRoot();
      setAgentRoot(root);

      if (root) {
        const [token, url] = await Promise.all([
          kb.config.getApiToken(),
          kb.config.getServerUrl(),
        ]);
        setApiToken(token);
        setServerUrl(url);
      }

      // Get initial status
      const { status, health: h } = await kb.services.getStatus();
      setCliStatus(status);
      if (h) setHealth(h);

      setIsReady(true);
    };

    init();

    // Subscribe to health updates
    const kb = (window as any).kyberbot;
    if (!kb) return;

    const unsubscribe = kb.services.onHealthUpdate((h: HealthData) => {
      setHealth(h);
      if (h.status !== 'offline') setCliStatus('running');
    });

    return unsubscribe;
  }, []);

  return (
    <AppContext.Provider value={{ agentRoot, apiToken, serverUrl, health, cliStatus, isReady }}>
      {children}
    </AppContext.Provider>
  );
}
