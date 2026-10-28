/** Instance-owned notifications with generation checks to prevent lost wakeups. */
export class Wakeup {
  private revision = 0;
  private readonly waiting = new Set<() => void>();
  version(): number { return this.revision; }
  notify(): void {
    this.revision++;
    for (const resolve of this.waiting) resolve();
  }
  async wait(version: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (version !== this.revision) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { this.waiting.delete(done); signal.removeEventListener('abort', abort); };
      const done = (): void => { cleanup(); resolve(); };
      const abort = (): void => { cleanup(); reject(signal.reason); };
      this.waiting.add(done);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}
