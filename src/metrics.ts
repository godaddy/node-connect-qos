import { IncomingMessage } from 'http';
import { Http2ServerRequest } from 'http2';
import { normalizeHost, resolveHostFromRequest, resolveIpFromRequest } from './util';
import LRU from 'lru-cache';

export type MetricsOptions = {
  historySize?: number;
  maxAge?: number;
  minHostRequests?: number|boolean;
  minIpRequests?: number|boolean;
  maxHostRate?: number;
  maxIpRate?: number;
  hostWhitelist?: Set<string>;
  ipWhitelist?: Set<string>;
  behindProxy?: boolean;
}

export enum ActorStatus {
  Good,
  Bad,
  Whitelisted
}

export enum BadActorType {
  badHost = 'badHost',
  badIp = 'badIp',
  userLag = 'userLag'
}

export type CacheItem = {
  id: string;
  history: Array<number>; // time
  hits: number;
  ratio: number;
  rate: number;
}

export const PURGE_DELAY: number = 1000 * 5; // 5s

export const DEFAULT_HISTORY_SIZE: number = 300;
export const DEFAULT_MAX_AGE: number = 1000 * 10; // 10s
export const DEFAULT_MIN_HOST_REQUESTS: number = 30;
export const DEFAULT_MIN_IP_REQUESTS: number = 100;
export const DEFAULT_HOST_WHITELIST = ['localhost', 'localhost:8080'];
export const DEFAULT_IP_WHITELIST = [];

export class Metrics {
  constructor(opts?: MetricsOptions) {
    const {
      historySize = DEFAULT_HISTORY_SIZE,
      maxAge = DEFAULT_MAX_AGE,
      minHostRequests = DEFAULT_MIN_HOST_REQUESTS,
      minIpRequests = DEFAULT_MIN_IP_REQUESTS,
      maxHostRate = 0, // disabled by default
      maxIpRate = 0, // disabled by default
      hostWhitelist = new Set(DEFAULT_HOST_WHITELIST),
      ipWhitelist = new Set(DEFAULT_IP_WHITELIST),
      behindProxy = false
    } = (opts || {} as MetricsOptions);

    if (minHostRequests > historySize) throw new Error(`${minHostRequests} minHostRequests cannot exceed ${historySize} historySize`)
    if (minIpRequests > historySize) throw new Error(`${minIpRequests} minIpRequests cannot exceed ${historySize} historySize`)

    const defaultLRUOptions: LRU.Options<string, CacheItem> = {
      max: historySize,
      //ttl: maxAge, // do NOT use ttl due to performance and we handle stale purges
      allowStale: false,
      updateAgeOnGet: true,
      updateAgeOnHas: false
    };
    this.#hosts = new LRU({
      ...defaultLRUOptions,
      dispose: (value: CacheItem/*, key: string*/) => {
        this.#hostRequests -= value.hits;
      }
    });
    this.#ips = new LRU({
      ...defaultLRUOptions,
      dispose: (value: CacheItem/*, key: string*/) => {
        this.#ipRequests -= value.hits;
      }
    });
    this.#hostRequests = this.#ipRequests = 0;
    this.#hostPurgeTime = this.#ipPurgeTime = Date.now();
    this.#historySize = historySize;
    this.#maxAge = maxAge;
    this.#minHostRequests = minHostRequests;
    this.#minIpRequests = minIpRequests;
    this.#maxHostRate = maxHostRate;
    this.#maxIpRate = maxIpRate;
    this.#hostWhitelist = hostWhitelist;
    this.#ipWhitelist = ipWhitelist;
    this.#behindProxy = behindProxy;
  }

  #hosts: LRU<string, CacheItem>;
  #ips: LRU<string, CacheItem>;
  #hostRequests: number;
  #ipRequests: number;
  #hostPurgeTime: number;
  #ipPurgeTime: number;
  #historySize: number;
  #maxAge: number;
  #minHostRequests: number|boolean;
  #minIpRequests: number|boolean;
  #maxHostRate: number;
  #maxIpRate: number;
  #hostWhitelist: Set<string>;
  #ipWhitelist: Set<string>;
  #behindProxy: boolean;

  get hosts(): LRU<string, CacheItem> {
    return this.#hosts;
  }

  get ips(): LRU<string, CacheItem> {
    return this.#ips;
  }

  get hostRequests(): number {
    return this.#hostRequests;
  }

  get ipRequests(): number {
    return this.#ipRequests;
  }

  get maxHostRate(): number {
    return this.#maxHostRate;
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

  get minHostRequests(): number|boolean {
    return this.#minHostRequests;
  }

  get minIpRequests(): number|boolean {
    return this.#minIpRequests;
  }

  get hostWhitelist(): Set<string> {
    return this.#hostWhitelist;
  }

  get ipWhitelist(): Set<string> {
    return this.#ipWhitelist;
  }

  get behindProxy(): boolean {
    return this.#behindProxy;
  }

  trackRequest(req: IncomingMessage|Http2ServerRequest): void {
    this.trackHost(req);
    this.trackIp(req);
  }

  getHostInfo(source: string|IncomingMessage|Http2ServerRequest): ActorStatus|CacheItem|undefined {
    if (typeof source === 'object') {
      source = resolveHostFromRequest(source);
    } else {
      source = normalizeHost(source);
    }

    return getInfo(source, {
      lru: this.#hosts,
      requestCount: this.#hostRequests,
      minRequests: this.#minHostRequests,
      whitelist: this.#hostWhitelist,
      maxRate: this.#maxHostRate
    });
  }

  trackHost(source: string|IncomingMessage|Http2ServerRequest, cache?: CacheItem): CacheItem|undefined {
    if (typeof source === 'object') {
      source = resolveHostFromRequest(source);
    } else {
      source = normalizeHost(source);
    }

    const result = track(source, {
      lru: this.#hosts,
      cache,
      maxAge: this.#maxAge,
      purgeTime: this.#hostPurgeTime
    });
    this.#hostRequests -= result.stale;
    this.#hostPurgeTime = result.purgeTime;
    this.#hostRequests++;

    return result.cache;
  }

  getIpInfo(source: string|IncomingMessage|Http2ServerRequest): ActorStatus|CacheItem|undefined {
    if (typeof source === 'object') {
      source = resolveIpFromRequest(source, this.behindProxy);
    }

    return getInfo(source, {
      lru: this.#ips,
      requestCount: this.#ipRequests,
      minRequests: this.#minIpRequests,
      whitelist: this.#ipWhitelist,
      maxRate: this.#maxIpRate
    });
  }

  trackIp(source: string|IncomingMessage|Http2ServerRequest, cache?: CacheItem): CacheItem|undefined {
    if (typeof source === 'object') {
      source = resolveIpFromRequest(source, this.behindProxy);
    }

    const result = track(source, {
      lru: this.#ips,
      cache,
      maxAge: this.#maxAge,
      purgeTime: this.#ipPurgeTime
    });
    this.#ipRequests -= result.stale;
    this.#ipPurgeTime = result.purgeTime;
    this.#ipRequests++;

    return result.cache;
  }
}

export type GetInfoOptions = {
  lru: LRU<string, CacheItem>,
  requestCount: number,
  minRequests: number|boolean,
  whitelist: Set<string>,
  maxRate: number
}

function getInfo(source: string, {
  lru,
  requestCount,
  minRequests,
  whitelist,
  maxRate
}: GetInfoOptions): ActorStatus|CacheItem|undefined {
  if (!minRequests) return ActorStatus.Good; // if monitoring is disabled treat as Good

  // reserved to indicate will never be a bad actor
  if (whitelist.has(source)) return ActorStatus.Whitelisted;

  let cache: CacheItem|undefined = lru.get(source);

  if (cache) { // always precompute `rate` & `ratio` based on NOW
    // update rate
    const now = Date.now();
    const eldest = cache.history[0] ?? now;
    const age = now - eldest;
    cache.rate = (!age || cache.hits < maxRate) ? 0 : ((cache.hits / age) * 1000);

    // update ratio
    cache.ratio = requestCount >= minRequests ? cache.hits / requestCount : 0;
  }

  return cache;
}

export type TrackOptions = {
  lru: LRU<string, CacheItem>,
  cache?: CacheItem,
  maxAge: number,
  purgeTime: number
}

export type TrackResult = {
  cache?: CacheItem,
  stale: number,
  purgeTime: number
}

function track(source: string, options: TrackOptions): TrackResult {
  const { lru, maxAge } = options;
  let { cache, purgeTime } = options;

  let stale = 0;

  const now = Date.now();
  if ((now - purgeTime) >= PURGE_DELAY) { // purge before adding
    // NON-OBVIOUS BUG. We MUST track the return value
    // and subtract AFTER, otherwise doing "this.#ipRequests -= purgeStale"
    // will result in invalid tracking due to LRU dispose handler
    stale = purgeStale(lru, maxAge);
    purgeTime = now;
  }

  if (!cache) { // if cache not provided attempt to fetch
    cache = lru.get(source);
  }

  if (!cache) {
    cache = { id: source, history: new Array(), hits: 0, ratio: 0, rate: 0 };
    lru.set(source, cache);
  }
  cache.hits++;
  cache.history.push(now);

  return { cache, stale, purgeTime };
}

// remove stale history and delete from LRU if history all stale,
// and return the number of requests that were stale
function purgeStale(cache: LRU<string, CacheItem>, maxAge: number): number {
  let delta = 0;
  const expiredAt = Date.now() - maxAge - 1;
  const deleteFromCache = [];

  for (let [key, value] of cache.entries()) {
    let expiredCount = 0;
    for (let time of value.history.values()) {
      let expired = time <= expiredAt;
      if (!expired) break;
      expiredCount++;
    }
    if (expiredCount) {
      if (expiredCount === value.history.length) {
        // if everything is expired, delete from cache
        deleteFromCache.push(key);
      } else {
        value.history = value.history.slice(expiredCount);
        // only update hits/delta if we're not deleting!
        // Otherwise the LRU dispose will update counts
        // again and result in incorrect tracking
        value.hits -= expiredCount;
        delta += expiredCount;
      }
    }
  }

  // empty cache entries should be removed entirely
  for (let key of deleteFromCache) {
    cache.delete(key);
  }

  return delta;
}
