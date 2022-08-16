import { IncomingMessage } from 'http';
import { Http2ServerRequest } from 'http2';
import { resolveHostFromRequest, resolveIpFromRequest } from './util';

export type MetricsOptions = {
  historySize?: number;
  waitForHistory?: boolean;
  hostBadActorSplit?: number;
  ipBadActorSplit?: number;
  hostWhitelist?: Set<string>;
  ipWhitelist?: Set<string>;
}

export class Metrics {
  constructor(opts?: MetricsOptions) {
    const {
      historySize = 1000,
      hostBadActorSplit = 0.5,
      ipBadActorSplit = 0.5,
      hostWhitelist = new Set(),
      ipWhitelist = new Set(),
      waitForHistory = true
    } = (opts || {} as MetricsOptions);
    this.#hosts = new Map();
    this.#ips = new Map();
    this.#badHosts = this.#badIps = new Map();
    this.#history = 0;
    this.#historySize = historySize;
    this.#hostBadActorSplit = hostBadActorSplit;
    this.#ipBadActorSplit = ipBadActorSplit;
    this.#hostWhitelist = hostWhitelist;
    this.#ipWhitelist = ipWhitelist;
    this.#isReady = waitForHistory === false;
  }

  #hosts: Map<string, number>;
  #ips: Map<string, number>;
  #badHosts: Map<string, number>;
  #badIps: Map<string, number>;
  #history: number;
  #historySize: number;
  #hostBadActorSplit: number;
  #ipBadActorSplit: number;
  #hostWhitelist: Set<string>;
  #ipWhitelist: Set<string>;
  #isReady: boolean;

  get hosts(): Map<string, number> {
    return this.#hosts;
  }

  get ips(): Map<string, number> {
    return this.#ips;
  }

  get badHosts(): Map<string, number> {
    return this.#badHosts;
  }

  get badIps(): Map<string, number> {
    return this.#badIps;
  }

  get history(): number {
    return this.#history;
  }

  get historySize(): number {
    return this.#historySize;
  }

  get hostBadActorSplit(): number {
    return this.#hostBadActorSplit;
  }

  get ipBadActorSplit(): number {
    return this.#ipBadActorSplit;
  }

  get hostWhitelist(): Set<string> {
    return this.#hostWhitelist;
  }

  get ipWhitelist(): Set<string> {
    return this.#ipWhitelist;
  }

  get isReady(): boolean {
    return this.#isReady;
  }

  trackRequest(req: IncomingMessage|Http2ServerRequest): void {
    this.isBadIp(req);
    this.isBadHost(req); // order matters since only host triggers history aggregation
  }

  isBadActor(req:IncomingMessage|Http2ServerRequest): boolean|string {
    // determine if bad actor but do not track as hits
    if (this.isBadHost(resolveHostFromRequest(req), false)) {
      return 'badHost';
    } else if (this.isBadIp(resolveIpFromRequest(req), false)) {
      return 'badIp';
    }

    return false;
  }

  isBadHost(host: string|IncomingMessage|Http2ServerRequest, track: boolean = true): boolean {
    if (typeof host === 'object') {
      host = resolveHostFromRequest(host);
    }

    if (track) {
      const count = (this.#hosts.get(host) || 0) + 1;
      this.#hosts.set(host, count);
  
      // periodically aggregate data and identify bad actors
      if (++this.#history >= this.#historySize) {
        this.identifyBadActors();
        this.#isReady = true;
      }  
    }

    return this.#hostWhitelist.has(host) === false && this.#badHosts.has(host);
  }

  isBadIp(ip: string|IncomingMessage|Http2ServerRequest, track: boolean = true): boolean {
    if (typeof ip === 'object') {
      ip = resolveIpFromRequest(ip);
    }

    if (track) {
      const count = (this.#ips.get(ip) || 0) + 1;
      this.#ips.set(ip, count);
    }

    return this.#ipWhitelist.has(ip) === false && this.#badIps.has(ip);
  }

  identifyBadActors(): void {
    /* Philosophy
      The basic idea is that for a given tracking window that we identify
      the TOP OFFENDERS, regardless of ratios. During nominal windows
      bad actors are irrelevant as they won't be looked at until the system
      becomes too busy. But during an attack window, we want to be on the
      lookout for as many possible actors as the amount of throughput
      reduction desired is substantial. The default `BadActorSplit` of 0.5
      simply means that we consider the most active 50% of traffic to
      be susceptible to throttling.

      Future:
      There is an opportunity to support tiered throttling so the
      aggressiveness of the throttling is porportional to how busy the system
      becomes. For example, instead of a flat 50% split @ 70ms lag, it could
      look something like:
      * 10% split @ 70ms
      * 20% split @ 80ms
      * ...
      * 90% split @ 160ms
      
      If this pattern ends up being necessary, it can/should replace the
      need for `userLag` as well.
    */

    // hosts
    const sortedHosts = Array.from(this.#hosts).sort((a, b) => b[1] - a[1]);
    const topHostCount = Math.floor(sortedHosts.length * this.hostBadActorSplit);
    const topHosts = sortedHosts.slice(0, topHostCount);
    this.#badHosts = new Map(topHosts);

    // ips
    const sortedIps = Array.from(this.#ips).sort((a, b) => b[1] - a[1]);
    const topIpCount = Math.floor(sortedIps.length * this.ipBadActorSplit);
    const topIps = sortedIps.slice(0, topIpCount);
    this.#badIps = new Map(topIps);
  
    // reset
    this.#history = 0;
    this.#ips.clear();
    this.#hosts.clear();
  }
}
