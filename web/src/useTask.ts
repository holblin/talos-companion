import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

export function useTask() {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mutation = useMutation({
    mutationFn: (action: () => Promise<void>) => action(),
    onMutate: () => {
      setError("");
      setNotice("");
    },
    onError: (error: Error) => {
      setError(error.message);
    },
  });
  async function work(action: () => Promise<void>) {
    try {
      await mutation.mutateAsync(action);
    } catch {
      /* Reported by onError. */
    }
  }
  return { busy: mutation.isPending, error, notice, setError, setNotice, work };
}
