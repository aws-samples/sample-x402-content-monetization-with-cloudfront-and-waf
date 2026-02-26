import { useState, useCallback, useRef } from 'react';
import type { EditorState } from './types';

export interface HistoryControls {
  state: EditorState;
  setState: (next: EditorState) => void;
  undo: () => void;
  canUndo: boolean;
  reset: () => void;
  canReset: boolean;
  clear: () => void;
  /** Call when loading/saving to mark current state as the "clean" checkpoint */
  markCheckpoint: () => void;
}

const emptyState: EditorState = { routes: [] };

export function useHistory(initial: EditorState): HistoryControls {
  const [state, setStateRaw] = useState<EditorState>(initial);
  const prevRef = useRef<EditorState | null>(null);
  const checkpointRef = useRef<EditorState>(initial);

  const setState = useCallback((next: EditorState) => {
    setStateRaw(prev => {
      prevRef.current = prev;
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    if (prevRef.current) {
      setStateRaw(prevRef.current);
      prevRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    setStateRaw(prev => {
      prevRef.current = prev;
      return checkpointRef.current;
    });
  }, []);

  const clear = useCallback(() => {
    setStateRaw(prev => {
      prevRef.current = prev;
      return emptyState;
    });
  }, []);

  const markCheckpoint = useCallback(() => {
    setStateRaw(current => {
      checkpointRef.current = current;
      return current;
    });
  }, []);

  return {
    state,
    setState,
    undo,
    canUndo: prevRef.current !== null,
    reset,
    canReset: true,
    clear,
    markCheckpoint,
  };
}
