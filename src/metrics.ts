import { IncomingMessage } from 'http';
import { Http2ServerRequest } from 'http2';
import { resolveHostFromRequest, resolveIpFromRequest } from './util';
import LRU from 'lru-cache';

export type MetricsOptions = {
  historySize?: number;
  maxAge?: number;
  minHostRequests?: number|boolean;
  minIpRequests?: number|boolean;
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
  history: Array<number>; // time
  hits: number;
  ratio: number;
  rate: number;
}

export const REQUESTS_PER_PURGE: number = 1000;
export const RATE_MIN_HITS: number = 3;

export const DEFAULT_HISTORY_SIZE: number = 300;
export const DEFAULT_MAX_AGE: number = 1000 * 60 * 2; // 2 mins
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
      dispose: (value: CacheItem, key: string) => {
        this.#hostRequests -= value.hits;
      }
    });
    this.#ips = new LRU({
      ...defaultLRUOptions,
      dispose: (value: CacheItem, key: string) => {
        this.#ipRequests -= value.hits;
      }
    });
    this.#hostRequests = this.#ipRequests = 0;
    this.#historySize = historySize;
    this.#maxAge = maxAge;
    this.#minHostRequests = minHostRequests;
    this.#minIpRequests = minIpRequests;
    this.#hostWhitelist = hostWhitelist;
    this.#ipWhitelist = ipWhitelist;
    this.#behindProxy = behindProxy;
  }

  #hosts: LRU<string, CacheItem>;
  #ips: LRU<string, CacheItem>;
  #hostRequests: number;
  #ipRequests: number;
  #historySize: number;
  #maxAge: number;
  #minHostRequests: number|boolean;
  #minIpRequests: number|boolean;
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
    this.getHostInfo(req);
    this.getIpInfo(req);
  }

  getHostInfo(host: string|IncomingMessage|Http2ServerRequest, track: boolean = true): ActorStatus|CacheItem|undefined {
    if (!this.#minHostRequests) return ActorStatus.Whitelisted; // if monitoring is disabled treat as whitelisted

    if (typeof host === 'object') {
      host = resolveHostFromRequest(host);
    }

    // reserved to indicate will never be a bad actor
    if (this.#hostWhitelist.has(host)) return ActorStatus.Whitelisted;

    let cache: CacheItem|undefined = this.#hosts.get(host);

    const now = Date.now();
    if (track) {
      if (!cache) {
        cache = { history: new Array(), hits: 0, ratio: 0, rate: 0 };
        this.#hosts.set(host, cache);
      }
      cache.hits++;
      cache.history.push(now);
      this.#hostRequests++;

      if (this.#hostRequests >= REQUESTS_PER_PURGE) {
        this.#hostRequests -= purgeStale(this.#hosts, this.#maxAge);
      }
    }

    if (cache) { // always precompute `rate` & `ratio` based on NOW
      // update rate
      const eldest = cache.history[0] ?? now;
      const age = now - eldest;
      cache.rate = (!age || cache.hits < RATE_MIN_HITS) ? 0 : ((cache.hits / age) * 1000);

      // update ratio
      cache.ratio = this.#hostRequests >= this.#minHostRequests ? cache.hits / this.#hostRequests : 0;
    }

    return cache;
  }

  getIpInfo(ip: string|IncomingMessage|Http2ServerRequest, track: boolean = true): ActorStatus|CacheItem|undefined {
    if (!this.#minIpRequests) return ActorStatus.Whitelisted; // if monitoring is disabled treat as whitelisted

    if (typeof ip === 'object') {
      ip = resolveIpFromRequest(ip, this.behindProxy);
    }

    // reserved to indicate will never be a bad actor
    if (this.#ipWhitelist.has(ip)) return ActorStatus.Whitelisted;

    let cache: CacheItem|undefined = this.#ips.get(ip);

    const now = Date.now();
    if (track) {
      if (!cache) {
        cache = { history: new Array(), hits: 0, ratio: 0, rate: 0 };
        this.#ips.set(ip, cache);
      }
      cache.hits++;
      cache.history.push(now);
      this.#ipRequests++;

      if (this.#ipRequests >= REQUESTS_PER_PURGE) {
        this.#ipRequests -= purgeStale(this.#ips, this.#maxAge);
      }
    }

    if (cache) { // always precompute `rate` based on NOW
      // update rate
      const eldest = cache.history[0] ?? now;
      const age = now - eldest;
      cache.rate = (!age || cache.hits < RATE_MIN_HITS) ? 0 : ((cache.hits / age) * 1000);

      // update ratio
      cache.ratio = this.#ipRequests >= this.#minIpRequests ? cache.hits / this.#ipRequests : 0;
    }

    return cache;
  }
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
        value.hits -= expiredCount;
      }
      delta += expiredCount;
    }
  }

  // empty cache entries should be removed entirely
  for (let key of deleteFromCache) {
    cache.delete(key);
  }

  return delta;
}
