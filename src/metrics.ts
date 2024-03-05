import LRU from 'lru-cache';

export type MetricsOptions = {
  historySize?: number;
  maxAge?: number;
  minHostRate?: number;
  maxHostRate?: number;
  maxHostRatio?: number;
  minIpRate?: number;
  maxIpRate?: number;
  maxIpRateHostViolation?: number;
  hostWhitelist?: Set<string>;
  ipWhitelist?: Set<string>;
}

export enum ActorStatus {
  Good = 200,
  Whitelisted = 300,
  Bad = 400
}

export enum BadActorType {
  badHost = 'badHost',
  hostViolation = 'hostViolation',
  badIp = 'badIp',
  userLag = 'userLag'
}

export type CacheItem = {
  id: string;
  history: Array<number>; // time
  rate: number;
}

export const DEFAULT_HISTORY_SIZE: number = 200; // 0.5% hit rate enough to reside in LRU
export const DEFAULT_MAX_AGE: number = 1000 * 10; // 10s is generally more than sufficient history
export const DEFAULT_MIN_HOST_RATE: number = 20;
export const DEFAULT_MAX_HOST_RATE: number = 40;
export const DEFAULT_MAX_HOST_RATIO: number = 0; // disabled
export const DEFAULT_MIN_IP_RATE: number = 0; // disabled
export const DEFAULT_MAX_IP_RATE: number = 0; // disabled
export const DEFAULT_MAX_IP_RATE_BUSY_HOST: number = 0; // disabled
export const DEFAULT_HOST_WHITELIST = ['localhost'];
export const DEFAULT_IP_WHITELIST = [];

export class Metrics {
  constructor(opts?: MetricsOptions) {
    const {
      historySize = DEFAULT_HISTORY_SIZE,
      maxAge = DEFAULT_MAX_AGE,
      minHostRate = DEFAULT_MIN_HOST_RATE,
      maxHostRate = DEFAULT_MAX_HOST_RATE,
      maxHostRatio = DEFAULT_MAX_HOST_RATIO,
      minIpRate = DEFAULT_MIN_IP_RATE,
      maxIpRate = DEFAULT_MAX_IP_RATE,
      maxIpRateHostViolation = DEFAULT_MAX_IP_RATE_BUSY_HOST,
      hostWhitelist = new Set(DEFAULT_HOST_WHITELIST),
      ipWhitelist = new Set(DEFAULT_IP_WHITELIST)
    } = (opts || {} as MetricsOptions);

    if (minHostRate > maxHostRate) throw new Error(`${minHostRate} minHostRate cannot exceed ${maxHostRate} maxHostRate`)
    if (minIpRate > maxIpRate) throw new Error(`${minIpRate} minIpRate cannot exceed ${maxIpRate} maxIpRate`)

    const lruOptions: LRU.Options<string, CacheItem> = {
      max: historySize,
      //ttl: maxAge, // do NOT use ttl due to performance and we handle stale purges
      allowStale: false,
      updateAgeOnGet: true,
      updateAgeOnHas: false
    };
    this.#hosts = new LRU(lruOptions);
    this.#ips = new LRU(lruOptions);
    this.#historySize = historySize;
    this.#maxAge = maxAge;
    this.#minHostRate = minHostRate;
    this.#maxHostRate = maxHostRate;
    this.#minHostRequests = Math.round(minHostRate * (maxAge/1000));
    this.#maxHostRatio = Math.max(Math.min(maxHostRatio, 0.9), 0); // 90% is very high, but this cap is just to prevent invalid ratios
    this.#hostRatioMaxCount = Math.ceil(this.#maxHostRatio * 100 * 10); // 10x requests compared to host ratio (10% * 10 = 100)
    this.#minIpRate = minIpRate;
    this.#maxIpRate = maxIpRate;
    this.#maxIpRateHostViolation = maxIpRateHostViolation;
    this.#minIpRequests = Math.round(minIpRate * (maxAge/1000));
    this.#hostWhitelist = hostWhitelist;
    this.#ipWhitelist = ipWhitelist;
  }

  #hosts: LRU<string, CacheItem>;
  #ips: LRU<string, CacheItem>;
  #historySize: number;
  #maxAge: number;
  #minHostRate: number;
  #maxHostRate: number;
  #minHostRequests: number;
  #maxHostRatio: number;
  #hostRatioMaxCount: number;
  #hostRatioCount: number = 0;
  #hostRatioViolations = new Set<string>();
  #hostRatioCounts = new Map<string, number>();
  #minIpRate: number;
  #maxIpRate: number;
  #maxIpRateHostViolation: number;
  #minIpRequests: number;
  #hostWhitelist: Set<string>;
  #ipWhitelist: Set<string>;

  get hosts(): LRU<string, CacheItem> {
    return this.#hosts;
  }

  get ips(): LRU<string, CacheItem> {
    return this.#ips;
  }

  get minHostRate(): number {
    return this.#minHostRate;
  }

  get maxHostRate(): number {
    return this.#maxHostRate;
  }

  get maxHostRatio(): number {
    return this.#maxHostRatio;
  }

  get hostRatioViolations(): Set<string> {
    return this.#hostRatioViolations;
  }

  get minIpRate(): number {
    return this.#minIpRate;
  }

  get maxIpRate(): number {
    return this.#maxIpRate;
  }

  get maxIpRateHostViolation(): number {
    return this.#maxIpRateHostViolation;
  }

  get historySize(): number {
    return this.#historySize;
  }

  get maxAge(): number {
    return this.#maxAge;
  }

  get hostWhitelist(): Set<string> {
    return this.#hostWhitelist;
  }

  get ipWhitelist(): Set<string> {
    return this.#ipWhitelist;
  }

  getHostInfo(source: string): ActorStatus|CacheItem|undefined {
    return getInfo(source, {
      lru: this.#hosts,
      whitelist: this.#hostWhitelist,
      minRequests: this.#minHostRequests,
      maxAge: this.#maxAge
    });
  }

  trackHost(source: string, cache?: CacheItem): CacheItem|undefined {
    if (this.#maxHostRatio) {
      // only track if ratio limits enabled
      this.#hostRatioCounts.set(source, (this.#hostRatioCounts.get(source) || 0) + 1);
      this.#hostRatioCount++;

      if (this.#hostRatioCount >= this.#hostRatioMaxCount) {
        // check for violations once we have sufficient history
        const maxCount = Math.round(this.#hostRatioCount * this.#maxHostRatio);
        this.#hostRatioViolations = [...this.#hostRatioCounts.entries()]
          .reduce((violations, [source, count]) => {
            if (count > maxCount) violations.add(source);
            return violations;
          }, new Set<string>());
        this.#hostRatioCounts.clear();
        this.#hostRatioCount = 0;
      }
    }

    return track(source, {
      lru: this.#hosts,
      cache,
      minRate: this.#minHostRate
    });
  }

  getIpInfo(source: string): ActorStatus|CacheItem|undefined {
    return getInfo(source, {
      lru: this.#ips,
      whitelist: this.#ipWhitelist,
      minRequests: this.#minIpRequests,
      maxAge: this.#maxAge
    });
  }

  trackIp(source: string, cache?: CacheItem): CacheItem|undefined {
    return track(source, {
      lru: this.#ips,
      cache,
      minRate: this.#minIpRate
    });
  }
}

export type GetInfoOptions = {
  lru: LRU<string, CacheItem>,
  whitelist: Set<string>,
  minRequests: number,
  maxAge: number
}

function getInfo(source: string, {
  lru,
  whitelist,
  minRequests,
  maxAge
}: GetInfoOptions): ActorStatus|CacheItem|undefined {
  if (!minRequests) return ActorStatus.Good; // if monitoring is disabled treat as Good

  // reserved to indicate will never be a bad actor
  if (whitelist.has(source)) return ActorStatus.Whitelisted;

  let cache: CacheItem|undefined = lru.get(source);

  if (cache) { // always precompute `rate` & `ratio` based on NOW
    // update rate
    const now = Date.now();
    const expiredAt = now - maxAge;

    // always remove stale history before calculating rate
    let expiredCount;
    // slightly faster than shifting
    for (expiredCount = 0; expiredCount < cache.history.length; expiredCount++) {
      if (cache.history[expiredCount] >= expiredAt) break;
    }
    if (expiredCount) {
      cache.history = cache.history.slice(expiredCount);
    }

    if (cache.history.length < minRequests) {
      cache.rate = 0; // insufficient history to measure
    } else {
      const eldest = cache.history[0];
      // default to 1ms to avoid divide by zero errors since we do have adequate history
      const age = (now - eldest) || 1;

      cache.rate = ((cache.history.length / age) * 1000);
    }
  }

  return cache;
}

export type TrackOptions = {
  lru: LRU<string, CacheItem>,
  cache?: CacheItem,
  minRate: number
}

function track(source: string, options: TrackOptions): CacheItem|undefined {
  const { lru, minRate } = options;
  let { cache } = options;

  if (!minRate) return void 0; // tracking disabled

  if (!cache) cache = lru.get(source); // if not supplied grab from lru

  if (!cache) { // if not in LRU create it
    cache = { id: source, history: new Array(), rate: 0 };
    lru.set(source, cache);
  }
  cache.history.push(Date.now()); // head=eldest, tail=newest

  return cache;
}
