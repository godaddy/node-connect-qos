export interface ClusterRedisOptions {
  client: any; // ioredis Redis or Cluster instance
  keyPrefix?: string;
}

export interface ClusterSyncStats {
  syncDurationMs: number;
  blockedIps: number;
  blockedSubnets: number;
  hostViolations: number;
  publishedDeltas: { ip: number; subnet: number; host: number };
}

export interface ClusterSyncOptions {
  redis: ClusterRedisOptions;
  windowMs: number;
  syncIntervalMs?: number;
  maxTrackedActors?: number;
  clusterMaxIpRate?: number;
  clusterMaxSubnetRate?: number;
  clusterMaxHostRatio?: number;
  clusterMaxIpRateHostViolation?: number;
  clusterMaxSubnetRateHostViolation?: number;
  onSync?: (stats: ClusterSyncStats) => void;
  onError?: (err: Error) => void;
}

export type ActorType = 'ip' | 'subnet' | 'host';

const DEFAULT_SYNC_INTERVAL_MS = 2000;
const DEFAULT_MAX_TRACKED_ACTORS = 50_000;
const DEFAULT_KEY_PREFIX = 'qos:';

export class ClusterSync {
  #redis: any;
  #keyPrefix: string;
  #windowMs: number;
  #syncIntervalMs: number;
  #maxTrackedActors: number;
  #clusterMaxIpRate: number;
  #clusterMaxSubnetRate: number;
  #clusterMaxHostRatio: number;
  #clusterMaxIpRateHostViolation: number;
  #clusterMaxSubnetRateHostViolation: number;
  #onSync?: (stats: ClusterSyncStats) => void;
  #onError?: (err: Error) => void;

  #ipDeltas = new Map<string, number>();
  #subnetDeltas = new Map<string, number>();
  #hostDeltas = new Map<string, number>();
  #totalDelta = 0;

  #blockedIps = new Set<string>();
  #blockedSubnets = new Set<string>();
  #hostViolations = new Set<string>();

  #intervalHandle: ReturnType<typeof setInterval> | null = null;
  #running = false;
  #syncing = false; // guard against overlapping sync cycles

  constructor(opts: ClusterSyncOptions) {
    this.#redis = opts.redis.client;
    this.#keyPrefix = opts.redis.keyPrefix ?? DEFAULT_KEY_PREFIX;
    // Guard against 0/negative/NaN values that would break window math (division by zero, NaN keys).
    this.#windowMs = opts.windowMs > 0 ? opts.windowMs : 10000;
    this.#syncIntervalMs = (opts.syncIntervalMs ?? 0) > 0 ? opts.syncIntervalMs! : DEFAULT_SYNC_INTERVAL_MS;
    this.#maxTrackedActors = (opts.maxTrackedActors ?? 0) > 0 ? opts.maxTrackedActors! : DEFAULT_MAX_TRACKED_ACTORS;
    this.#clusterMaxIpRate = Math.max(0, opts.clusterMaxIpRate || 0);
    this.#clusterMaxSubnetRate = Math.max(0, opts.clusterMaxSubnetRate || 0);
    this.#clusterMaxHostRatio = Math.max(0, opts.clusterMaxHostRatio || 0);
    this.#clusterMaxIpRateHostViolation = Math.max(0, opts.clusterMaxIpRateHostViolation || 0);
    this.#clusterMaxSubnetRateHostViolation = Math.max(0, opts.clusterMaxSubnetRateHostViolation || 0);
    this.#onSync = opts.onSync;
    this.#onError = opts.onError;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#intervalHandle = setInterval(() => {
      if (this.#syncing) return; // skip tick if previous sync is still in-flight
      this.#sync();
    }, this.#syncIntervalMs);
    this.#intervalHandle.unref();
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    if (this.#intervalHandle) {
      clearInterval(this.#intervalHandle);
      this.#intervalHandle = null;
    }
  }

  recordHit(type: ActorType, key: string): void {
    // Always count total traffic regardless of per-host cardinality cap so the
    // denominator used for host ratio calculation stays accurate.
    if (type === 'host') this.#totalDelta++;
    const deltas = this.#getDeltaMap(type);
    if (deltas.size >= this.#maxTrackedActors && !deltas.has(key)) return;
    deltas.set(key, (deltas.get(key) || 0) + 1);
  }

  getAndResetDeltas(type: ActorType): Map<string, number> {
    const deltas = this.#getDeltaMap(type);
    const snapshot = new Map(deltas);
    deltas.clear();
    return snapshot;
  }

  isBlocked(type: 'ip' | 'subnet', key: string): boolean {
    return type === 'ip'
      ? this.#blockedIps.has(key)
      : this.#blockedSubnets.has(key);
  }

  isHostViolation(host: string): boolean {
    return this.#hostViolations.has(host);
  }

  get blockedIps(): Set<string> {
    return this.#blockedIps;
  }

  get blockedSubnets(): Set<string> {
    return this.#blockedSubnets;
  }

  get hostViolations(): Set<string> {
    return this.#hostViolations;
  }

  get clusterMaxIpRateHostViolation(): number {
    return this.#clusterMaxIpRateHostViolation;
  }

  get clusterMaxSubnetRateHostViolation(): number {
    return this.#clusterMaxSubnetRateHostViolation;
  }

  #getDeltaMap(type: ActorType): Map<string, number> {
    switch (type) {
      case 'ip': return this.#ipDeltas;
      case 'subnet': return this.#subnetDeltas;
      case 'host': return this.#hostDeltas;
    }
  }

  #currentWindow(): number {
    return Math.floor(Date.now() / this.#windowMs);
  }

  // Fraction of the current window that has elapsed (0 at window start, 1 at window end).
  // Used to weight the previous window's contribution in the sliding window rate estimate.
  #currentWindowOffset(): number {
    return (Date.now() % this.#windowMs) / this.#windowMs;
  }

  #windowKey(type: ActorType, window: number): string {
    return `${this.#keyPrefix}${type}:w${window}`;
  }

  #totalKey(window: number): string {
    return `${this.#keyPrefix}total:w${window}`;
  }

  async #sync(): Promise<void> {
    this.#syncing = true;
    const start = Date.now();
    // Snapshot all deltas synchronously before the first await.
    // JS is single-threaded so no recordHit can interleave during these assignments.
    const ipDeltas = this.getAndResetDeltas('ip');
    const subnetDeltas = this.getAndResetDeltas('subnet');
    const totalDelta = this.#totalDelta;
    this.#totalDelta = 0;
    const hostDeltas = this.getAndResetDeltas('host');

    let publishSucceeded = false;
    try {
      await this.#publishDeltas(ipDeltas, subnetDeltas, hostDeltas, totalDelta);
      publishSucceeded = true;

      if (!this.#running) return; // stop() was called during publish — skip remaining work

      await this.#readThresholds();
      this.#cleanupOldWindows();
      this.#onSync?.({
        syncDurationMs: Date.now() - start,
        blockedIps: this.#blockedIps.size,
        blockedSubnets: this.#blockedSubnets.size,
        hostViolations: this.#hostViolations.size,
        publishedDeltas: { ip: ipDeltas.size, subnet: subnetDeltas.size, host: hostDeltas.size },
      });
    } catch (err) {
      if (!publishSucceeded) {
        // Only re-queue deltas when publish failed. If publish succeeded but a later step
        // (readThresholds, onSync) threw, re-queuing would double-count on the next cycle.
        this.#mergeDeltasBack(ipDeltas, subnetDeltas, hostDeltas, totalDelta);
      }
      this.#onError?.(err as Error);
    } finally {
      this.#syncing = false;
    }
  }

  #mergeDeltasBack(
    ipDeltas: Map<string, number>,
    subnetDeltas: Map<string, number>,
    hostDeltas: Map<string, number>,
    totalDelta: number
  ): void {
    for (const [key, count] of ipDeltas) {
      this.#ipDeltas.set(key, (this.#ipDeltas.get(key) || 0) + count);
    }
    for (const [key, count] of subnetDeltas) {
      this.#subnetDeltas.set(key, (this.#subnetDeltas.get(key) || 0) + count);
    }
    for (const [key, count] of hostDeltas) {
      this.#hostDeltas.set(key, (this.#hostDeltas.get(key) || 0) + count);
    }
    this.#totalDelta += totalDelta;
  }

  async #publishDeltas(
    ipDeltas: Map<string, number>,
    subnetDeltas: Map<string, number>,
    hostDeltas: Map<string, number>,
    totalDelta: number
  ): Promise<void> {
    if (ipDeltas.size === 0 && subnetDeltas.size === 0 && hostDeltas.size === 0 && totalDelta === 0) return;
    const pipe = this.#redis.pipeline();

    for (const [key, count] of ipDeltas) {
      pipe.zincrby(this.#windowKey('ip', window), count, key);
    }
    for (const [key, count] of subnetDeltas) {
      pipe.zincrby(this.#windowKey('subnet', window), count, key);
    }
    for (const [key, count] of hostDeltas) {
      pipe.zincrby(this.#windowKey('host', window), count, key);
    }
    if (totalDelta > 0) {
      pipe.incrby(this.#totalKey(window), totalDelta);
    }

    // Trim sorted sets to maxTrackedActors (keep highest scores = top offenders).
    // Only trim types with active deltas — no unnecessary pipeline commands for idle types.
    // When the set has fewer than maxTrackedActors entries, ZREMRANGEBYRANK resolves
    // stop to a negative index that underflows past the start and is a no-op per Redis spec.
    const trimIndex = -(this.#maxTrackedActors + 1);
    if (ipDeltas.size > 0) pipe.zremrangebyrank(this.#windowKey('ip', window), 0, trimIndex);
    if (subnetDeltas.size > 0) pipe.zremrangebyrank(this.#windowKey('subnet', window), 0, trimIndex);
    if (hostDeltas.size > 0) pipe.zremrangebyrank(this.#windowKey('host', window), 0, trimIndex);

    const results = await pipe.exec();
    const firstError = results?.find(([err]: [Error | null, any]) => err)?.[0];
    if (firstError) throw firstError;
  }

  async #readThresholds(): Promise<void> {
    if (this.#clusterMaxIpRate === 0 && this.#clusterMaxSubnetRate === 0 && this.#clusterMaxHostRatio === 0) return;
    const window = this.#currentWindow();
    const prevWindow = window - 1;
    // Sliding window weight: how much of the previous window still counts.
    // At offset=0 (window just started) the full previous window is included;
    // at offset=1 (window about to end) the previous window contributes nothing.
    const prevWeight = 1 - this.#currentWindowOffset();
    const pipe = this.#redis.pipeline();

    const ipThreshold = this.#clusterMaxIpRate > 0
      ? Math.ceil(this.#clusterMaxIpRate * (this.#windowMs / 1000))
      : 0;
    const subnetThreshold = this.#clusterMaxSubnetRate > 0
      ? Math.ceil(this.#clusterMaxSubnetRate * (this.#windowMs / 1000))
      : 0;

    // Fetch all actors with at least one hit in each window so the sliding window
    // computation can correctly handle actors that straddle a window boundary.
    if (ipThreshold > 0) {
      pipe.zrangebyscore(this.#windowKey('ip', window), 1, '+inf', 'WITHSCORES');
      pipe.zrangebyscore(this.#windowKey('ip', prevWindow), 1, '+inf', 'WITHSCORES');
    }
    if (subnetThreshold > 0) {
      pipe.zrangebyscore(this.#windowKey('subnet', window), 1, '+inf', 'WITHSCORES');
      pipe.zrangebyscore(this.#windowKey('subnet', prevWindow), 1, '+inf', 'WITHSCORES');
    }
    if (this.#clusterMaxHostRatio > 0) {
      pipe.get(this.#totalKey(window));
      pipe.get(this.#totalKey(prevWindow));
      const minHostCount = Math.max(1, Math.ceil(this.#clusterMaxHostRatio * 0.5 * (this.#windowMs / 1000)));
      pipe.zrangebyscore(this.#windowKey('host', window), minHostCount, '+inf', 'WITHSCORES');
      pipe.zrangebyscore(this.#windowKey('host', prevWindow), minHostCount, '+inf', 'WITHSCORES');
    }

    const results = await pipe.exec();
    if (!results || results.length === 0) return;

    const firstError = results.find(([err]: [Error | null, any]) => err)?.[0];
    if (firstError) throw firstError;

    let idx = 0;

    // Process IP blocks using sliding window: current + prev * prevWeight >= threshold
    if (ipThreshold > 0) {
      const currentScores: string[] = results[idx]?.[1] || [];
      const prevScores: string[] = results[idx + 1]?.[1] || [];
      idx += 2;

      const currentCounts = new Map<string, number>();
      for (let i = 0; i < currentScores.length; i += 2) {
        currentCounts.set(currentScores[i], parseFloat(currentScores[i + 1]));
      }
      const prevCounts = new Map<string, number>();
      for (let i = 0; i < prevScores.length; i += 2) {
        prevCounts.set(prevScores[i], parseFloat(prevScores[i + 1]));
      }

      const newBlockedIps = new Set<string>();
      const candidates = new Set([...currentCounts.keys(), ...prevCounts.keys()]);
      for (const ip of candidates) {
        const sliding = (currentCounts.get(ip) || 0) + (prevCounts.get(ip) || 0) * prevWeight;
        if (sliding >= ipThreshold) newBlockedIps.add(ip);
      }
      this.#blockedIps = newBlockedIps;
    }

    // Process subnet blocks using sliding window
    if (subnetThreshold > 0) {
      const currentScores: string[] = results[idx]?.[1] || [];
      const prevScores: string[] = results[idx + 1]?.[1] || [];
      idx += 2;

      const currentCounts = new Map<string, number>();
      for (let i = 0; i < currentScores.length; i += 2) {
        currentCounts.set(currentScores[i], parseFloat(currentScores[i + 1]));
      }
      const prevCounts = new Map<string, number>();
      for (let i = 0; i < prevScores.length; i += 2) {
        prevCounts.set(prevScores[i], parseFloat(prevScores[i + 1]));
      }

      const newBlockedSubnets = new Set<string>();
      const candidates = new Set([...currentCounts.keys(), ...prevCounts.keys()]);
      for (const subnet of candidates) {
        const sliding = (currentCounts.get(subnet) || 0) + (prevCounts.get(subnet) || 0) * prevWeight;
        if (sliding >= subnetThreshold) newBlockedSubnets.add(subnet);
      }
      this.#blockedSubnets = newBlockedSubnets;
    }

    // Process host ratio violations
    if (this.#clusterMaxHostRatio > 0) {
      const currentTotal = parseInt(results[idx]?.[1] || '0', 10);
      const prevTotal = parseInt(results[idx + 1]?.[1] || '0', 10);
      const currentHostScores: string[] = results[idx + 2]?.[1] || [];
      const prevHostScores: string[] = results[idx + 3]?.[1] || [];
      idx += 4;

      const newHostViolations = new Set<string>();
      // Apply the same sliding window weighting to both host counts and total traffic.
      const slidingTotal = currentTotal + prevTotal * prevWeight;

      if (slidingTotal > 0) {
        // WITHSCORES returns alternating [member, score, member, score, ...]
        const currentHostCounts = new Map<string, number>();
        for (let i = 0; i < currentHostScores.length; i += 2) {
          currentHostCounts.set(currentHostScores[i], parseInt(currentHostScores[i + 1], 10));
        }
        const prevHostCounts = new Map<string, number>();
        for (let i = 0; i < prevHostScores.length; i += 2) {
          prevHostCounts.set(prevHostScores[i], parseInt(prevHostScores[i + 1], 10));
        }

        const candidates = new Set([...currentHostCounts.keys(), ...prevHostCounts.keys()]);
        for (const host of candidates) {
          const sliding = (currentHostCounts.get(host) || 0) + (prevHostCounts.get(host) || 0) * prevWeight;
          if (sliding / slidingTotal > this.#clusterMaxHostRatio) {
            newHostViolations.add(host);
          }
        }
      }
      this.#hostViolations = newHostViolations;
    }
  }

  #cleanupOldWindows(): void {
    const currentWindow = this.#currentWindow();
    const staleWindow = currentWindow - 3; // clean windows older than 3× windowMs
    const pipe = this.#redis.pipeline();
    for (const type of ['ip', 'subnet', 'host'] as ActorType[]) {
      pipe.unlink(this.#windowKey(type, staleWindow));
    }
    pipe.unlink(this.#totalKey(staleWindow));
    pipe.exec().catch((err: Error) => this.#onError?.(err));
  }
}
