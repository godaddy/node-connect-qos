import toobusy from 'toobusy-js';
import { Metrics, MetricsOptions, ActorStatus, BadActorType, CacheItem } from './metrics';
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

  getMiddleware({ beforeThrottle, destroySocket = true }: GetMiddlewareOptions = {}) {
    const self = this;
    return function QOSMiddleware(req, res, next) {
      const reason = self.shouldThrottleRequest(req);
      if (reason) {
        if (!beforeThrottle || beforeThrottle(self, req, reason as string) !== false) {
          // if no throttle handler OR the throttle handler does not explicitly reject, do it
          res.writeHead(self.#errorStatusCode);
          res.end();
          if (destroySocket && res.socket?.destroyed === false) { // explicit destroyed check
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

    const hostStatus = this.getHostStatus(req, false);
    const ipStatus = this.getIpStatus(req, false);

    // never throttle whitelisted actor
    if (hostStatus === ActorStatus.Whitelisted || ipStatus === ActorStatus.Whitelisted) return false;

    if (hostStatus === ActorStatus.Bad) return BadActorType.badHost;
    else if (ipStatus === ActorStatus.Bad) return BadActorType.badIp;
    else if (this.lag >= this.#userLag) return BadActorType.userLag;

    // only track if NOT throttling
    this.#metrics.trackRequest(req);

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
    const sourceInfo = this.#metrics.getHostInfo(source);

    const status = getStatus(sourceInfo, {
      tooBusy: this.tooBusy,
      maxRate: this.#metrics.maxHostRate,
      lagRatio: this.lagRatio,
      badRange: this.#badHostRange,
      minBadThreshold: this.#minBadHostThreshold
    });
    if (sourceInfo === ActorStatus.Whitelisted) return ActorStatus.Whitelisted;
    
    if (track && status === ActorStatus.Good) {
      // only track if we're NOT throttling
      this.#metrics.trackHost(source, sourceInfo as CacheItem);
    }

    return status;
  }

  isBadHost(host: string|IncomingMessage|Http2ServerRequest, track: boolean = true): boolean {
    return this.getHostStatus(host, track) === ActorStatus.Bad;
  }

  getIpStatus(source: string|IncomingMessage|Http2ServerRequest, track: boolean = true): ActorStatus {
    const sourceInfo = this.#metrics.getIpInfo(source);

    const status = getStatus(sourceInfo, {
      tooBusy: this.tooBusy,
      maxRate: this.#metrics.maxIpRate,
      lagRatio: this.lagRatio,
      badRange: this.#badIpRange,
      minBadThreshold: this.#minBadIpThreshold
    });
    
    if (track && status === ActorStatus.Good) {
      // only track if we're NOT throttling
      this.#metrics.trackIp(source, sourceInfo as CacheItem);
    }

    return status;
  }

  isBadIp(ip: string|IncomingMessage|Http2ServerRequest, track: boolean = true): boolean {
    return this.getIpStatus(ip, track) === ActorStatus.Bad;
  }
}

export type GetStatusOptions = {
  tooBusy: boolean,
  maxRate: number,
  lagRatio: number,
  badRange: number,
  minBadThreshold: number
}

function getStatus(sourceInfo: ActorStatus|CacheItem|undefined, {
  tooBusy,
  maxRate,
  lagRatio,
  badRange,
  minBadThreshold
}: GetStatusOptions): ActorStatus {
  if (sourceInfo === ActorStatus.Whitelisted) return ActorStatus.Whitelisted;

  let status: ActorStatus;

  if (!sourceInfo) status = ActorStatus.Good; // if no history assume it's good
  else if (!tooBusy) { // if NOT busy we rely on rate limiting, if enabled
    if (!maxRate) {
      status = ActorStatus.Good; // rate limiting disabled
    } else { // check by rate limit
      status = sourceInfo.rate > maxRate ? ActorStatus.Bad : ActorStatus.Good;
    }
  } else { // otherwise we block by ratios
    const requiredThreshold = (lagRatio * badRange) + minBadThreshold;

    // if source meets or exceeds required threshold then it should be blocked
    status = sourceInfo.ratio >= requiredThreshold ? ActorStatus.Bad : ActorStatus.Good;
  }
  
  return status;
}
