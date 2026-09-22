"use client";

import { useEffect, useState } from "react";

/**
 * Debounced value — updates `delayMs` after the input stops changing.
 * No dependency: a few lines around setTimeout. Used by Inbox search
 * so typing fires one server request per settled query, not one per
 * keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);

  return debounced;
}
