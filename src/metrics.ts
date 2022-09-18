import LRU from 'lru-cache';

export type MetricsOptions = {
  historySize?: number;
  maxAge?: number;
  minHostRate?: number;
  maxHostRate?: number;
  minIpRate?: number;
  maxIpRate?: number;
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
export const DEFAULT_MIN_IP_RATE: number = 0; // disabled
export const DEFAULT_MAX_IP_RATE: number = 0; // disabled
export const DEFAULT_HOST_WHITELIST = ['localhost'];
export const DEFAULT_IP_WHITELIST = [];

export class Metrics {
  constructor(opts?: MetricsOptions) {
    const {
      historySize = DEFAULT_HISTORY_SIZE,
      maxAge = DEFAULT_MAX_AGE,
      minHostRate = DEFAULT_MIN_HOST_RATE,
      maxHostRate = DEFAULT_MAX_HOST_RATE,
      minIpRate = DEFAULT_MIN_IP_RATE,
      maxIpRate = DEFAULT_MAX_IP_RATE,
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
    this.#minIpRate = minIpRate;
    this.#maxIpRate = maxIpRate;
    this.#hostWhitelist = hostWhitelist;
    this.#ipWhitelist = ipWhitelist;
  }

  #hosts: LRU<string, CacheItem>;
  #ips: LRU<string, CacheItem>;
  #historySize: number;
  #maxAge: number;
  #minHostRate: number;
  #maxHostRate: number;
  #minIpRate: number;
  #maxIpRate: number;
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

  get minIpRate(): number {
    return this.#minIpRate;
  }

  get maxIpRate(): number {
    return this.#maxIpRate;
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
      minRate: this.#minHostRate,
      maxAge: this.#maxAge
    });
  }

  trackHost(source: string, cache?: CacheItem): CacheItem|undefined {
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
      minRate: this.#minIpRate,
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
  minRate: number,
  maxAge: number
}

function getInfo(source: string, {
  lru,
  whitelist,
  minRate,
  maxAge
}: GetInfoOptions): ActorStatus|CacheItem|undefined {
  if (!minRate) return ActorStatus.Good; // if monitoring is disabled treat as Good

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

    if (cache.history.length < minRate) {
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
