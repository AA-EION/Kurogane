/** The Swift shell carries navigation metadata only; Rust IPC keeps its existing
 * security boundary. Actions enter the same React workflows as Windows/Linux. */
export function publishNativeState(state: { unlocked: boolean; title: string; companies: boolean; hosts: boolean; sync: string; syncing: boolean }) {
  const handler = (window as Window & { webkit?: { messageHandlers?: { kuroganeState?: { postMessage: (state: unknown) => void } } } }).webkit?.messageHandlers?.kuroganeState;
  handler?.postMessage(state);
}
