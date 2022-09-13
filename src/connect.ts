import toobusy from 'toobusy-js';
import { Metrics, MetricsOptions, ActorStatus, BadActorType } from './metrics';
import { IncomingMessage } from 'http';
import { Http2ServerRequest } from 'http2';
import { isLocalAddress } from './util';

export type ConnectQOSMiddleware = (req: IncomingMessage|Http2ServerRequest, res: object, next: Function) => boolean;
export type BeforeThrottleFn = (qos: ConnectQOS, req: IncomingMessage|Http2ServerRequest, reason: string) => boolean|undefined;
export type GetMiddlewareOptions = {
  beforeThrottle?: BeforeThrottleFn,
  destroySocket?: boolean
}

export interface ConnectQOSOptions extends MetricsOptions {
  minLag?: number;
  maxLag?: number;
  userLag?: number;
  minBadHostThreshold?: number;
  maxBadHostThreshold?: number;
  minBadIpThreshold?: number;
  maxBadIpThreshold?: number;
  maxHostRate?: number;
  maxIpRate?: number;
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
      maxHostRate = 0, // disabled by default
      maxIpRate = 0, // disabled by default
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
    this.#maxHostRate = maxHostRate;
    this.#maxIpRate = maxIpRate;
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
  #maxHostRate: number;
  #maxIpRate: number;
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

  get maxHostRate(): number {
    return this.#maxHostRate;
  }

  get maxIpRate(): number {
    return this.#maxIpRate;
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

  getMiddleware({ beforeThrottle, destroySocket = true }: GetMiddlewareOptions = {}) {
    const self = this;
    return function QOSMiddleware(req, res, next) {
      const reason = self.shouldThrottleRequest(req);
      if (reason) {
        if (!beforeThrottle || beforeThrottle(self, req, reason as string) !== false) {
          // if no throttle handler OR the throttle handler does not explicitly reject, do it
          res.writeHead(self.#errorStatusCode);
          res.end();
          if (destroySocket && !res.socket.destroyed) {
            res.socket.destroy(); // if bad actor throw away connection!
          }
          return;
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

    const hostStatus = this.getHostStatus(req, false);
    const ipStatus = this.getIpStatus(req, false);

    // never throttle whitelisted actor
    if (hostStatus === ActorStatus.Whitelisted || ipStatus === ActorStatus.Whitelisted) return false;

    if (hostStatus === ActorStatus.Bad) return BadActorType.badHost;
    else if (ipStatus === ActorStatus.Bad) return BadActorType.badIp;
    else if (this.lag >= this.#userLag) return BadActorType.userLag;

    // do not throttle user
    return false;  
  }

  get tooBusy(): boolean {
    return toobusy();
  }

  get lag(): number {
    return toobusy.lag();
  }

  get lagRatio(): number {
    // lagRatio = 0-1
    return Math.min(1, (this.lag - this.minLag) / this.#lagRange);
  }

  getHostStatus(source: string|IncomingMessage|Http2ServerRequest, track: boolean = true): ActorStatus {
    // invoke even if not tooBusy as it tracks stats
    const sourceInfo = this.#metrics.getHostInfo(source, track);

    if (sourceInfo === ActorStatus.Whitelisted) return ActorStatus.Whitelisted;

    if (!sourceInfo) return ActorStatus.Good;
    else if (!this.tooBusy) { // if NOT busy we rely on rate limiting, if enabled
      if (!this.#maxHostRate) return ActorStatus.Good; // rate limiting disabled

      return sourceInfo.rate > this.#maxHostRate ? ActorStatus.Bad : ActorStatus.Good;
    }
    // otherwise we block by ratios

    // requiredThreshold = this.#minBadThreshold - this.#maxBadThreshold
    const requiredThreshold = (this.lagRatio * this.#badHostRange) + this.#minBadHostThreshold;

    // if source meets or exceeds required threshold then it should be blocked
    return sourceInfo.ratio >= requiredThreshold ? ActorStatus.Bad : ActorStatus.Good;
  }

  isBadHost(host: string|IncomingMessage|Http2ServerRequest, track: boolean = true): boolean {
    return this.getHostStatus(host, track) === ActorStatus.Bad;
  }

  getIpStatus(source: string|IncomingMessage|Http2ServerRequest, track: boolean = true): ActorStatus {
    // invoke even if not tooBusy as it tracks stats
    const sourceInfo = this.#metrics.getIpInfo(source, track);

    if (sourceInfo === ActorStatus.Whitelisted) return ActorStatus.Whitelisted;

    if (!sourceInfo) return ActorStatus.Good;
    else if (!this.tooBusy) { // if NOT busy we rely on rate limiting, if enabled
      if (!this.#maxIpRate) return ActorStatus.Good; // rate limiting disabled

      return sourceInfo.rate > this.#maxIpRate ? ActorStatus.Bad : ActorStatus.Good;
    }
    // otherwise we block by ratios

    // requiredThreshold = this.#minBadThreshold - this.#maxBadThreshold
    const requiredThreshold = (this.lagRatio * this.#badIpRange) + this.#minBadIpThreshold;

    // if source meets or exceeds required threshold then it should be blocked
    return sourceInfo.ratio >= requiredThreshold ? ActorStatus.Bad : ActorStatus.Good;
  }

  isBadIp(ip: string|IncomingMessage|Http2ServerRequest, track: boolean = true): boolean {
    return this.getIpStatus(ip, track) === ActorStatus.Bad;
  }
}
