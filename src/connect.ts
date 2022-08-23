import toobusy from 'toobusy-js';
import { Metrics, MetricsOptions, BadActorType } from './metrics';
import { IncomingMessage } from 'http';
import { Http2ServerRequest } from 'http2';
import { isLocalAddress } from './util';

export type ConnectQOSMiddleware = (req: IncomingMessage|Http2ServerRequest, res: object, next: Function) => boolean;
export type BeforeThrottleFn = (qos: ConnectQOS, req: IncomingMessage|Http2ServerRequest, reason: string) => boolean|undefined;
export type GetMiddlewareOptions = {
  beforeThrottle?: BeforeThrottleFn
}

export interface ConnectQOSOptions extends MetricsOptions {
  minLag?: number;
  maxLag?: number;
  userLag?: number;
  minBadHostThreshold?: number;
  maxBadHostThreshold?: number;
  minBadIpThreshold?: number;
  maxBadIpThreshold?: number;
  errorStatusCode?: number;
  exemptLocalAddress?: boolean;
}

export class ConnectQOS {
  constructor(opts?: ConnectQOSOptions) {
    const {
      minLag = 70,
      maxLag = 300,
      userLag = 500,
      minBadHostThreshold = 0.50, // requires 50% of traffic @ minLag
      maxBadHostThreshold = 0.01, // requires 1% of traffic @ maxLag
      minBadIpThreshold = 0.50, // requires 50% of traffic @ minLag
      maxBadIpThreshold = 0.01, // requires 1% of traffic @ maxLag
      errorStatusCode = 503,
      exemptLocalAddress = true,
      ...metricOptions
    } = (opts || {} as ConnectQOSOptions);

    this.#minLag = minLag;
    this.#maxLag = maxLag;
    this.#lagRange = maxLag - minLag;
    this.#userLag = userLag;
    this.#minBadHostThreshold = minBadHostThreshold;
    this.#maxBadHostThreshold = maxBadHostThreshold;
    this.#badHostRange = maxBadHostThreshold - minBadHostThreshold;
    this.#minBadIpThreshold = minBadIpThreshold;
    this.#maxBadIpThreshold = maxBadIpThreshold;
    this.#badIpRange = maxBadIpThreshold - minBadIpThreshold;
    this.#errorStatusCode = errorStatusCode;
    this.#exemptLocalAddress = exemptLocalAddress;
  
    toobusy.maxLag(this.#minLag);
  
    this.#metrics = new Metrics(metricOptions);
  }

  #minLag: number;
  #maxLag: number;
  #lagRange: number;
  #userLag: number;
  #minBadHostThreshold: number;
  #maxBadHostThreshold: number;
  #badHostRange: number;
  #minBadIpThreshold: number;
  #maxBadIpThreshold: number;
  #badIpRange: number;
  #errorStatusCode: number;
  #metrics: Metrics;
  #exemptLocalAddress: boolean;

  get minLag(): number {
    return this.#minLag;
  }

  get maxLag(): number {
    return this.#maxLag;
  }

  get userLag(): number {
    return this.#userLag;
  }

  get minBadHostThreshold(): number {
    return this.#minBadHostThreshold;
  }

  get maxBadHostThreshold(): number {
    return this.#maxBadHostThreshold;
  }

  get minBadIpThreshold(): number {
    return this.#minBadIpThreshold;
  }

  get maxBadIpThreshold(): number {
    return this.#maxBadIpThreshold;
  }

  get errorStatusCode(): number {
    return this.#errorStatusCode;
  }

  get exemptLocalAddress(): boolean {
    return this.#exemptLocalAddress;
  }

  get metrics(): Metrics {
    return this.#metrics;
  }

  getMiddleware({ beforeThrottle }: GetMiddlewareOptions = {}) {
    const self = this;
    return function QOSMiddleware(req, res, next) {
      const reason = self.shouldThrottleRequest(req);
      if (reason) {
        if (!beforeThrottle || beforeThrottle(self, req, reason as string) !== false) {
          // if no throttle handler OR the throttle handler does not explicitly reject, do it
          res.writeHead(self.#errorStatusCode);
          return res.end();
        }
      }
  
      // continue
      next();
    };  
  }

  shouldThrottleRequest(req: IncomingMessage|Http2ServerRequest): BadActorType|boolean {
    // do not track much less block local addresses
    if (this.#exemptLocalAddress && isLocalAddress(req?.socket?.remoteAddress || '')) return false;

    this.#metrics.trackRequest(req);

    if (this.isBadHost(req, false) === true) return BadActorType.badHost;
    else if (this.isBadIp(req, false) === true) return BadActorType.badIp;
    else if (this.lag >= this.#userLag) return BadActorType.userLag;

    // do not throttle user
    return false;  
  }

  get tooBusy() {
    return toobusy();
  }

  get lag() {
    return toobusy.lag();
  }

  isBadHost(host: string|IncomingMessage|Http2ServerRequest, track: boolean = true): boolean {
    // invoke even if not tooBusy as it tracks stats
    const hostRatio = this.#metrics.getHostRatio(host, track);

    if (!hostRatio || !this.tooBusy) return false;

    // lagRatio = 0-1
    const lagRatio = Math.min(1, (this.lag - this.minLag) / this.#lagRange);

    // requiredThreshold = this.#minBadHostThreshold - this.#maxBadHostThreshold
    const requiredThreshold = (lagRatio * this.#badHostRange) + this.#minBadHostThreshold;

    // if source meets or exceeds required threshold then it should be blocked
    return hostRatio >= requiredThreshold;
  }

  isBadIp(ip: string|IncomingMessage|Http2ServerRequest, track: boolean = true): boolean {
    // invoke even if not tooBusy as it tracks stats
    const ipRatio = this.#metrics.getIpRatio(ip, track);

    if (!ipRatio || !this.tooBusy) return false;

    // lagRatio = 0-1
    const lagRatio = Math.min(1, (this.lag - this.minLag) / this.#lagRange);

    // requiredThreshold = this.#minBadIpThreshold - this.#maxBadHostThreshold
    const requiredThreshold = (lagRatio * this.#badIpRange) + this.#minBadIpThreshold;

    // if source meets or exceeds required threshold then it should be blocked
    return ipRatio >= requiredThreshold;
  }
}
