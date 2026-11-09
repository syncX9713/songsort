import type { WorkerRequest, WorkerResponse } from './scan.worker';

type Pending = {
  resolve: (r: WorkerResponse) => void;
  onProgress?: (bytes: number) => void;
};

type Job = { req: WorkerRequest; pending: Pending };

/** A small pool of Web Workers so scanning never freezes the page. */
export class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Job[] = [];
  private running = new Map<Worker, Job>();
  private nextJob = 1;
  private closed = false;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./scan.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(w, e.data);
      w.onerror = (e) => {
        const job = this.running.get(w);
        if (job) {
          this.running.delete(w);
          job.pending.resolve({ kind: 'error', job: job.req.job, error: e.message || 'Scanner crashed on this file.', unreadable: false });
        }
        e.preventDefault();
        // Replace the broken worker.
        this.workers = this.workers.filter((x) => x !== w);
        w.terminate();
        if (!this.closed) {
          const fresh = new Worker(new URL('./scan.worker.ts', import.meta.url), { type: 'module' });
          fresh.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(fresh, ev.data);
          this.workers.push(fresh);
          this.idle.push(fresh);
          this.pump();
        }
      };
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  static defaultSize(): number {
    const cores = navigator.hardwareConcurrency || 2;
    return Math.max(1, Math.min(4, cores - 1));
  }

  run(kind: WorkerRequest['kind'], file: File, onProgress?: (bytes: number) => void): Promise<WorkerResponse> {
    return new Promise((resolve) => {
      const req = { kind, job: this.nextJob++, file } as WorkerRequest;
      this.queue.push({ req, pending: { resolve, onProgress } });
      this.pump();
    });
  }

  private pump() {
    while (!this.closed && this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.pop()!;
      const job = this.queue.shift()!;
      this.running.set(w, job);
      w.postMessage(job.req);
    }
  }

  private onMessage(w: Worker, msg: WorkerResponse) {
    const job = this.running.get(w);
    if (!job || job.req.job !== msg.job) return;
    if (msg.kind === 'progress') {
      job.pending.onProgress?.(msg.bytes);
      return;
    }
    this.running.delete(w);
    this.idle.push(w);
    job.pending.resolve(msg);
    this.pump();
  }

  terminate() {
    this.closed = true;
    for (const w of this.workers) w.terminate();
    // Settle everything still waiting so callers never hang.
    const waiting = [...this.running.values(), ...this.queue];
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.running.clear();
    for (const job of waiting) {
      job.pending.resolve({ kind: 'error', job: job.req.job, error: 'Cancelled', unreadable: false });
    }
  }
}
