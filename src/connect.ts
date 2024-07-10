import toobusy from 'toobusy-js';
import { Metrics, MetricsOptions, ActorStatus, BadActorType, CacheItem } from './metrics';
import { IncomingMessage } from 'http';
import { Http2ServerRequest } from 'http2';
import { normalizeHost, resolveHostFromRequest, resolveIpFromRequest } from './util';

export type ConnectQOSMiddleware = (req: IncomingMessage|Http2ServerRequest, res: object, next: Function) => boolean;
export type BeforeThrottleFn = (qos: ConnectQOS, req: IncomingMessage|Http2ServerRequest, reason: string) => boolean|undefined;
export type GetMiddlewareOptions = {
  beforeThrottle?: BeforeThrottleFn,
  destroySocket?: boolean
}

export interface ConnectQOSOptions extends MetricsOptions {
  minLag?: number;
  maxLag?: number;
  errorStatusCode?: number;
  httpBehindProxy?: boolean;
  httpsBehindProxy?: boolean;
}

export class ConnectQOS {
  constructor(opts?: ConnectQOSOptions) {
    const {
      minLag = 70,
      maxLag = 300,
      errorStatusCode = 503,
      httpBehindProxy = false, // must be explicit to enable
      httpsBehindProxy = false, // must be explicit to enable
      ...metricOptions
    } = (opts || {} as ConnectQOSOptions);

    this.#minLag = minLag;
    this.#maxLag = maxLag;
    this.#lagRange = maxLag - minLag;
    this.#errorStatusCode = errorStatusCode;
    this.#httpBehindProxy = httpBehindProxy;
    this.#httpsBehindProxy = httpsBehindProxy;

    // we only require `toobusy.lag` feature and can ignore toobusy() via maxLag
    // toobusy.maxLag(this.#maxLag);

    this.#metrics = new Metrics(metricOptions);
    this.#hostRateRange = this.#metrics.maxHostRate - this.#metrics.minHostRate;
    this.#ipRateRange = this.#metrics.maxIpRate - this.#metrics.minIpRate;
  }

  #minLag: number;
  #maxLag: number;
  #lagRange: number;
  #hostRateRange: number;
  #ipRateRange: number;
  #errorStatusCode: number;
  #httpBehindProxy: boolean;
  #httpsBehindProxy: boolean;
  #metrics: Metrics;

  get minLag(): number {
    return this.#minLag;
  }

  get maxLag(): number {
    return this.#maxLag;
  }

  get errorStatusCode(): number {
    return this.#errorStatusCode;
  }

  get httpBehindProxy(): boolean {
    return this.#httpBehindProxy;
  }

  get httpsBehindProxy(): boolean {
    return this.#httpsBehindProxy;
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
          res.statusCode = self.#errorStatusCode;
          res.end();
          // H2 must destroy the stream, H1 must destroy the socket
          const connection = res.stream ? res.stream.session : res.socket;
          if (destroySocket && connection?.destroyed === false) { // explicit destroyed check
            connection.destroy(); // if bad actor throw away connection!
          }
          return;
        }
      }

      // continue
      next();
    };
  }

  shouldThrottleRequest(req: IncomingMessage|Http2ServerRequest): BadActorType|boolean {
    const host = this.resolveHost(req);
    const hostStatus = this.getHostStatus(host, false); // defer tracking
    const ipStatus = this.getIpStatus(req, false); // defer tracking

    // never throttle whitelisted actors
    if (hostStatus === ActorStatus.Whitelisted || ipStatus === ActorStatus.Whitelisted) return false;

    if (hostStatus === ActorStatus.Bad) return BadActorType.badHost;

    if (ipStatus === ActorStatus.Bad) return BadActorType.badIp;

    // If host is exceeding host ratio and IP rate override is either not set or exceeded, return hostViolation status
    const maxIpRateHostViolation = this.#metrics.maxIpRateHostViolation;
    if (
      this.metrics.hostRatioViolations.has(host) &&
      (!maxIpRateHostViolation || this.getIpStatus(req, false, Math.max(0, maxIpRateHostViolation - this.#metrics.minIpRate)) === ActorStatus.Bad)
    ) {
      return BadActorType.hostViolation;
    }

    // only track if NOT throttling
    this.trackRequest(req);

    // do not throttle user
    return false;
  }

  get lag(): number {
    return toobusy.lag();
  }

  get lagRatio(): number {
    // lagRatio = 0-1
    const lag = toobusy.lag();
    // if lag exceeds maxLag will cap ratio at 1
    return lag > this.#minLag ? Math.min(1, (lag - this.#minLag) / this.#lagRange) : 0;
  }

  resolveHost(source: string|IncomingMessage|Http2ServerRequest): string {
    return typeof source === 'string' ? normalizeHost(source)
      : resolveHostFromRequest(source)
    ;
  }

  getHostStatus(source: string|IncomingMessage|Http2ServerRequest, track: boolean = true): ActorStatus {
    const sourceStr: string = this.resolveHost(source);
    const sourceInfo = this.#metrics.getHostInfo(sourceStr);

    const status = getStatus(sourceInfo, {
      minRate: this.#metrics.minHostRate,
      rateRange: this.#hostRateRange,
      lagRatio: this.lagRatio
    });
    if (sourceInfo === ActorStatus.Whitelisted) return ActorStatus.Whitelisted;

    if (track && status === ActorStatus.Good) {
      // only track if we're NOT throttling
      // forward cache to avoid additional lookup
      this.#metrics.trackHost(sourceStr, sourceInfo as CacheItem);
    }

    return status;
  }

  isBadHost(host: string|IncomingMessage|Http2ServerRequest, track: boolean = true): boolean {
    return this.getHostStatus(host, track) === ActorStatus.Bad;
  }

  resolveIp(source: string|IncomingMessage|Http2ServerRequest): string {
    return typeof source === 'string' ? source
      : resolveIpFromRequest(source, (source as Http2ServerRequest).scheme === 'https' ? this.#httpsBehindProxy : this.#httpBehindProxy)
    ;
  }

  getIpStatus(source: string|IncomingMessage|Http2ServerRequest, track: boolean = true, rateRange: number = this.#ipRateRange): ActorStatus {
    const sourceStr: string = this.resolveIp(source);
    const sourceInfo = this.#metrics.getIpInfo(sourceStr);

    const status = getStatus(sourceInfo, {
      minRate: this.#metrics.minIpRate,
      lagRatio: this.lagRatio,
      rateRange
    });

    if (track && status === ActorStatus.Good) {
      // only track if we're NOT throttling
      // forward cache to avoid additional lookup
      this.#metrics.trackIp(sourceStr, sourceInfo as CacheItem);
    }

    return status;
  }

  isBadIp(ip: string|IncomingMessage|Http2ServerRequest, track: boolean = true): boolean {
    return this.getIpStatus(ip, track) === ActorStatus.Bad;
  }

  trackRequest(req: IncomingMessage|Http2ServerRequest): void {
    const host = this.resolveHost(req);
    this.#metrics.trackHost(host);
    const ip = this.resolveIp(req);
    this.#metrics.trackIp(ip);
  }
}

export type GetStatusOptions = {
  minRate: number,
  rateRange: number,
  lagRatio: number
}

function getStatus(sourceInfo: ActorStatus|CacheItem|undefined, {
  minRate,
  rateRange,
  lagRatio
}: GetStatusOptions): ActorStatus {
  if (sourceInfo === ActorStatus.Whitelisted) return ActorStatus.Whitelisted;

  // if no history OR rate limiting disabled assume it's good
  if (!sourceInfo || !minRate) return ActorStatus.Good;

  // lagRatio = 0-1 (min-max)
  // minRate = 10
  // maxRate = 30
  // rateRange = (maxRate - minRate) = 20
  // ((1-0.00) * 20) + 10 = 30 // minLag RPS
  // ((1-0.25) * 20) + 10 = 25
  // ((1-0.50) * 20) + 10 = 20
  // ((1-0.75) * 20) + 10 = 15
  // ((1-1.00) * 20) + 10 = 10 // maxLag RPS
  const dynamicRate = ((1-lagRatio) * rateRange) + minRate;
  // min/max not required since lagRatio is guaranteed
  // to be 0-1 regardless of (under|over)flow

  return sourceInfo.rate > dynamicRate ? ActorStatus.Bad : ActorStatus.Good;
}
