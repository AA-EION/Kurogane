import { useState } from 'react';
import type { Saved } from '../api/types';
import { errorText, useStore } from '../store';

/** Submit helper shared by all entity forms. */
export function useSubmit() {
  const { applyTopology, closeModal, toast } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (fn: () => Promise<Saved>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await fn();
      applyTopology(saved.topology, saved.id);
      closeModal();
      toast(message, 'ok');
      return saved;
    } catch (e) {
      setError(errorText(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, submit };
}

export const blank = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
