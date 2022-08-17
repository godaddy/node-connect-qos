import toobusy from 'toobusy-js';
import { Metrics, MetricsOptions, BadActorType } from './metrics';
import { IncomingMessage } from 'http';
import { Http2ServerRequest } from 'http2';

export type ConnectQOSMiddleware = (req: IncomingMessage|Http2ServerRequest, res: object, next: Function) => boolean;
export type BeforeThrottleFn = (qos: ConnectQOS, req: IncomingMessage|Http2ServerRequest, reason: string) => boolean|undefined;
export type GetMiddlewareOptions = {
  beforeThrottle?: BeforeThrottleFn
}

export interface ConnectQOSOptions extends MetricsOptions {
  maxLag?: number;
  userLag?: number;
  errorStatusCode?: number;
}

export class ConnectQOS {
  constructor(opts?: ConnectQOSOptions) {
    const {
      maxLag = 70,
      userLag = 300,
      errorStatusCode = 503,
      ...metricOptions
    } = (opts || {} as ConnectQOSOptions);

    this.#maxLag = maxLag;
    this.#userLag = userLag;
    this.#errorStatusCode = errorStatusCode;
  
    toobusy.maxLag(this.#maxLag);
  
    this.#metrics = new Metrics(metricOptions);
  }

  #maxLag: number;
  #userLag: number;
  #errorStatusCode: number;
  #metrics: Metrics;

  get maxLag(): number {
    return this.#maxLag;
  }

  get userLag(): number {
    return this.#userLag;
  }

  get errorStatusCode(): number {
    return this.#errorStatusCode;
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
    this.#metrics.trackRequest(req);

    if (this.tooBusy === true) {
      const badActor = this.#metrics.isBadActor(req);
      if (badActor) return badActor; // contains reason for bad actor
      if (this.#userLag && this.lag >= this.#userLag) {
        return BadActorType.userLag; // yes, throttle possibly innocent user
      }
    }
  
    // do not throttle user
    return false;  
  }

  get tooBusy() { // if metrics are not ready, we cannot be too busy
    return this.#metrics.isReady && toobusy();
  }

  get lag() {
    return toobusy.lag();
  }

  isBadHost(host: string): boolean {
    return this.#metrics.isBadHost(host) && this.tooBusy; // order matters since we track
  }

  isBadIp(ip: string|IncomingMessage|Http2ServerRequest): boolean {
    return this.#metrics.isBadIp(ip) && this.tooBusy; // order matters since we track
  }
}
