interface Waiting {
  host: string;
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  cancel: () => void;
}
/** 单个集中采集服务共享配额；不用于多个出口副本之间的分布式协调。 */
export class RequestQuota {
  private active = 0;
  private readonly readyAt: number;
  private readonly hosts = new Map<string, { busy: boolean; next: number }>();
  private readonly waiting: Waiting[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly capacity = 2, private readonly interval = 2000, private readonly queueLimit = 64) {
    if (!Number.isInteger(capacity) || capacity < 1 || !Number.isFinite(interval) || interval < 0 || !Number.isInteger(queueLimit) || queueLimit < 1) throw Error('采集配额无效');
    // 单实例停止后再启动时先冷却一轮，避免内存计时丢失造成连续突发。
    this.readyAt = performance.now() + interval;
  }
  acquire(host: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.waiting.length >= this.queueLimit) return Promise.reject(Error('采集等待队列已满，请稍后重试'));
    return new Promise((resolve, reject) => {
      const item: Waiting = { host, signal, resolve, reject, cancel: () => {
        const index = this.waiting.indexOf(item);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        signal.removeEventListener('abort', item.cancel);
        reject(Error('采集等待已取消或超时'));
        this.drain();
      } };
      this.waiting.push(item);
      signal.addEventListener('abort', item.cancel, { once: true });
      this.drain();
    });
  }
  defer(host:string,milliseconds:number){
    if(!Number.isFinite(milliseconds)||milliseconds<0)throw Error('站点冷却时间无效');
    const state=this.hosts.get(host)??{busy:false,next:0};
    state.next=Math.max(state.next,performance.now()+milliseconds);this.hosts.set(host,state);this.drain();
  }
  private drain() {
    clearTimeout(this.timer); this.timer = undefined;
    const now = performance.now();
    if (now < this.readyAt) {
      if (this.waiting.length) this.timer = setTimeout(() => this.drain(), Math.ceil(this.readyAt - now));
      return;
    }
    for (const [host, state] of this.hosts) if (!state.busy && state.next <= now) this.hosts.delete(host);
    // 跳过仍在冷却的站点，避免它占住其他站点的空闲槽；同站点保持先来先执行。
    for (let index = 0; index < this.waiting.length && this.active < this.capacity;) {
      const item = this.waiting[index]!;
      const old = this.hosts.get(item.host);
      if (old && (old.busy || old.next > now)) { index++; continue; }
      this.waiting.splice(index, 1); item.signal.removeEventListener('abort', item.cancel);
      const state = { busy: true, next: now + this.interval };
      this.hosts.set(item.host, state); this.active++;
      let released = false;
      item.resolve(() => {
        if (released) return;
        released = true; state.busy = false; this.active--; this.drain();
      });
    }
    const deadlines = [...this.hosts.values()].filter(state => !state.busy).map(state => state.next);
    if (deadlines.length && this.waiting.length) this.timer = setTimeout(() => this.drain(), Math.min(2147483647,Math.max(1, Math.ceil(Math.min(...deadlines) - performance.now()))));
  }
}
export const requestQuota = new RequestQuota();
