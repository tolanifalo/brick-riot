/**
 * Estimates the server clock from ping/pong samples. The offset comes from the
 * sample with the lowest round trip (least queueing noise); the reported RTT
 * is the median of recent samples.
 */
export class ServerClock {
  private samples: { rtt: number; offset: number }[] = [];
  offset = 0;
  rtt = 120;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Rough initial estimate from a server timestamp (no RTT correction). */
  seed(serverTime: number): void {
    if (this.samples.length === 0) this.offset = serverTime - this.now();
  }

  onPong(sentAt: number, serverTime: number): void {
    const receivedAt = this.now();
    const rtt = Math.max(0, receivedAt - sentAt);
    this.samples.push({ rtt, offset: serverTime - (sentAt + rtt / 2) });
    if (this.samples.length > 10) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.offset;
    const sorted = this.samples.map((s) => s.rtt).sort((a, b) => a - b);
    this.rtt = sorted[Math.floor(sorted.length / 2)] ?? rtt;
  }

  serverNow(): number {
    return this.now() + this.offset;
  }

  get sampleCount(): number {
    return this.samples.length;
  }
}
