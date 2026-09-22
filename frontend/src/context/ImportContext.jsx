import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { startTask, endTask } from '../utils/activeTaskTracker.js';

// Tracks the state of bulk Excel imports (Upload Salary Data, Users,
// Employee Master) above the router, alongside AuthProvider/ToastProvider —
// so navigating to a different page and back doesn't lose the "Importing..."
// progress bar or the ability to Cancel. Each import screen keeps running
// its own upload/streaming logic; it just reads and writes its slot of
// state here instead of local component state, so a fresh mount of the
// page (after navigating back to it) sees the import that's still going.
//
// Each import screen is identified by a fixed key: 'salaryData' | 'users' |
// 'employees'. A slot's shape is { importing, progress, result }.
const ImportContext = createContext(null);

const EMPTY_SLOT = { importing: false, progress: null, result: null };

export function ImportProvider({ children }) {
  const [imports, setImports] = useState({});
  // Abort controllers aren't serializable render state and don't need to
  // trigger a re-render on their own, so they live in a ref map instead.
  const controllers = useRef({});

  const startImport = useCallback((key, controller) => {
    controllers.current[key] = controller;
    startTask();
    setImports((prev) => ({ ...prev, [key]: { importing: true, progress: null, result: null } }));
  }, []);

  const updateProgress = useCallback((key, progress) => {
    setImports((prev) => ({ ...prev, [key]: { ...(prev[key] || EMPTY_SLOT), importing: true, progress } }));
  }, []);

  const finishImport = useCallback((key, result) => {
    delete controllers.current[key];
    endTask();
    setImports((prev) => ({ ...prev, [key]: { importing: false, progress: null, result } }));
  }, []);

  const cancelImport = useCallback((key) => {
    controllers.current[key]?.abort();
  }, []);

  const clearResult = useCallback((key) => {
    setImports((prev) => ({ ...prev, [key]: { ...(prev[key] || EMPTY_SLOT), result: null } }));
  }, []);

  return (
    <ImportContext.Provider value={{ imports, startImport, updateProgress, finishImport, cancelImport, clearResult }}>
      {children}
    </ImportContext.Provider>
  );
}

// Convenience hook: a page calls useImportSlot('salaryData') and gets back
// that import's current state plus actions scoped to that key, without
// having to pass the key to every action call itself.
export function useImportSlot(key) {
  const ctx = useContext(ImportContext);
  const slot = ctx.imports[key] || EMPTY_SLOT;
  return {
    importing: slot.importing,
    progress: slot.progress,
    result: slot.result,
    startImport: (controller) => ctx.startImport(key, controller),
    updateProgress: (progress) => ctx.updateProgress(key, progress),
    finishImport: (result) => ctx.finishImport(key, result),
    cancelImport: () => ctx.cancelImport(key),
    clearResult: () => ctx.clearResult(key)
  };
}
