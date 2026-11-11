import { useRef, useState } from "react";

export function useDelivery() {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Delivery failed. Try again.");
    }
    lock.current = false;
    setBusy(false);
  }
  return { busy, error, submit };
}
