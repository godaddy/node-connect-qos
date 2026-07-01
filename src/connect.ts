import toobusy from 'toobusy-js';
import { Metrics, MetricsOptions, ActorStatus, BadActorType, CacheItem } from './metrics';
import { IncomingMessage, ServerResponse } from 'http';
import { Http2ServerRequest, Http2ServerResponse } from 'http2';
import { normalizeHost, resolveHostFromRequest, resolveIpFromRequest, resolveSubnetFromIp, SubnetMaskBits } from './util';
import { ClusterSync, ClusterSyncOptions } from './cluster';

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
  errorResponseDelay?: number;
  httpBehindProxy?: boolean;
  httpsBehindProxy?: boolean;
  subnetMaskBits?: SubnetMaskBits;
  cluster?: Omit<ClusterSyncOptions, 'windowMs'>;
}

export const DEFAULT_SUBNET_MASK_BITS: SubnetMaskBits = 24;

export class ConnectQOS {
  constructor(opts?: ConnectQOSOptions) {
    const {
      minLag = 70,
      maxLag = 300,
      errorStatusCode = 503,
      errorResponseDelay = 0,
      httpBehindProxy = false, // must be explicit to enable
      httpsBehindProxy = false, // must be explicit to enable
      subnetMaskBits = DEFAULT_SUBNET_MASK_BITS,
      cluster,
      ...metricOptions
    } = (opts || {} as ConnectQOSOptions);

    if (subnetMaskBits < 20 || subnetMaskBits > 30) throw new Error(`subnetMaskBits ${subnetMaskBits} must be between 20 and 30`);
    if (minLag >= maxLag) throw new Error(`${minLag} minLag must be less than ${maxLag} maxLag`);

    this.#minLag = minLag;
    this.#maxLag = maxLag;
    this.#lagRange = maxLag - minLag;
    this.#errorStatusCode = errorStatusCode;
    this.#httpBehindProxy = httpBehindProxy;
    this.#httpsBehindProxy = httpsBehindProxy;
    this.#errorResponseDelay = errorResponseDelay;
    this.#subnetMaskBits = subnetMaskBits;

    if (cluster) {
      this.#clusterSync = new ClusterSync({
        ...cluster,
        windowMs: metricOptions.maxAge ?? 10000,
      });
      this.#clusterSync.start();
    }

    // we only require `toobusy.lag` feature and can ignore toobusy() via maxLag
    // toobusy.maxLag(this.#maxLag);

    this.#metrics = new Metrics({
      ...metricOptions,
      onTrack: this.#clusterSync
        ? (type, key) => this.#clusterSync!.recordHit(type, key)
        : undefined,
    });
    this.#hostRateRange = this.#metrics.maxHostRate - this.#metrics.minHostRate;
    this.#ipRateRange = this.#metrics.maxIpRate - this.#metrics.minIpRate;
    this.#subnetRateRange = this.#metrics.maxSubnetRate - this.#metrics.minSubnetRate;
  }

  #minLag: number;
  #maxLag: number;
  #lagRange: number;
  #hostRateRange: number;
  #ipRateRange: number;
  #subnetRateRange: number;
  #subnetMaskBits: SubnetMaskBits;
  #errorStatusCode: number;
  #httpBehindProxy: boolean;
  #httpsBehindProxy: boolean;
  #errorResponseDelay: number;
  #metrics: Metrics;
  #clusterSync?: ClusterSync;

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

  get clusterSync(): ClusterSync | undefined {
    return this.#clusterSync;
  }

  destroy(): void {
    this.#clusterSync?.stop();
  }

  getMiddleware({ beforeThrottle, destroySocket = true }: GetMiddlewareOptions = {}) {
    const self = this;
    function sendError(res: Http2ServerResponse | ServerResponse) {
      res.statusCode = self.#errorStatusCode;
      res.end();
      if (destroySocket) {
        if (res.stream) { // H2
          res.stream.session?.destroy();
        } else if (res.socket?.destroyed === false) {
          res.socket.destroySoon();
        }
      }
    }

    return function QOSMiddleware(req, res, next) {
      const reason = self.shouldThrottleRequest(req);
      if (reason) {
        if (!beforeThrottle || beforeThrottle(self, req, reason as string) !== false) {
          // if no throttle handler OR the throttle handler does not explicitly reject, do it
          return void (self.#errorResponseDelay ? setTimeout(sendError, self.#errorResponseDelay, res).unref() : sendError(res));
        }
      }

      // continue
      next();
    };
  }

  shouldThrottleRequest(req: IncomingMessage|Http2ServerRequest): BadActorType|boolean {
    const host = this.resolveHost(req);
    const ip = this.resolveIp(req);
    const subnet = resolveSubnetFromIp(ip, this.#subnetMaskBits);
    const hostStatus = this.getHostStatus(host, false); // defer tracking
    const ipStatus = this.getIpStatus(ip, false); // defer tracking
    const subnetStatus = this.getSubnetStatus(subnet, false); // defer tracking

    // never throttle whitelisted actors
    if (hostStatus === ActorStatus.Whitelisted || ipStatus === ActorStatus.Whitelisted) return false;

    if (hostStatus === ActorStatus.Bad) return BadActorType.badHost;

    // Cluster-wide host ratio violations (checked before local IP/subnet to return hostViolation
    // even when local IP rate limits are also exceeded)
    if (this.#clusterSync?.isHostViolation(host)) {
      const clusterMaxIpRateHostViolation = this.#clusterSync.clusterMaxIpRateHostViolation;
      const clusterMaxSubnetRateHostViolation = this.#clusterSync.clusterMaxSubnetRateHostViolation;

      if (!clusterMaxIpRateHostViolation && !clusterMaxSubnetRateHostViolation) {
        return BadActorType.hostViolation;
      }

      if (clusterMaxIpRateHostViolation) {
        const violationMin = Math.min(clusterMaxIpRateHostViolation, this.#metrics.minIpRate);
        const violationRange = Math.max(0, clusterMaxIpRateHostViolation - violationMin);
        if (this.getIpStatus(ip, false, violationRange, violationMin) === ActorStatus.Bad) {
          return BadActorType.hostViolation;
        }
      }

      if (clusterMaxSubnetRateHostViolation) {
        const subnetViolationMin = Math.min(clusterMaxSubnetRateHostViolation, this.#metrics.minSubnetRate);
        const subnetViolationRange = Math.max(0, clusterMaxSubnetRateHostViolation - subnetViolationMin);
        if (this.getSubnetStatus(subnet, false, subnetViolationRange, subnetViolationMin) === ActorStatus.Bad) {
          return BadActorType.hostViolation;
        }
      }
    }

    if (ipStatus === ActorStatus.Bad) return BadActorType.badIp;

    if (subnetStatus === ActorStatus.Bad) return BadActorType.badSubnet;

    // Cluster-wide checks (async-populated blocklists)
    if (this.#clusterSync) {
      if (!this.#metrics.ipWhitelist.has(ip) && this.#clusterSync.isBlocked('ip', ip)) return BadActorType.badIp;
      if (!this.#metrics.subnetWhitelist.has(subnet) && this.#clusterSync.isBlocked('subnet', subnet)) return BadActorType.badSubnet;
    }

    // If host is exceeding host ratio, apply per-actor rate overrides if configured
    if (this.metrics.hostRatioViolations.has(host)) {
      const maxIpRateHostViolation = this.#metrics.maxIpRateHostViolation;
      const maxSubnetRateHostViolation = this.#metrics.maxSubnetRateHostViolation;

      if (!maxIpRateHostViolation && !maxSubnetRateHostViolation) {
        // No per-actor override configured — unconditional host violation
        return BadActorType.hostViolation;
      }

      // IP override: only flag if IP rate exceeds threshold
      if (maxIpRateHostViolation) {
        const violationMin = Math.min(maxIpRateHostViolation, this.#metrics.minIpRate);
        const violationRange = Math.max(0, maxIpRateHostViolation - violationMin);
        if (this.getIpStatus(ip, false, violationRange, violationMin) === ActorStatus.Bad) {
          return BadActorType.hostViolation;
        }
      }

      // Subnet override: only flag if subnet rate exceeds threshold
      if (maxSubnetRateHostViolation) {
        const subnetViolationMin = Math.min(maxSubnetRateHostViolation, this.#metrics.minSubnetRate);
        const subnetViolationRange = Math.max(0, maxSubnetRateHostViolation - subnetViolationMin);
        if (this.getSubnetStatus(subnet, false, subnetViolationRange, subnetViolationMin) === ActorStatus.Bad) {
          return BadActorType.hostViolation;
        }
      }
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

    if (sourceInfo === ActorStatus.Whitelisted) return ActorStatus.Whitelisted;

    const status = getStatus(sourceInfo, {
      minRate: this.#metrics.minHostRate,
      rateRange: this.#hostRateRange,
      lagRatio: this.lagRatio
    });

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
    if (typeof source === 'string') return source;
    // HTTP/2: use :scheme pseudo-header. HTTP/1.1: fall back to socket.encrypted (set by Node's TLS stack).
    // Without the socket.encrypted check, HTTP/1.1 HTTPS connections fall through to httpBehindProxy,
    // causing QOS to trust x-forwarded-for for direct TLS connections (IP spoofing risk).
    const isHttps = (source as Http2ServerRequest).scheme === 'https' || (source.socket as any)?.encrypted === true;
    return resolveIpFromRequest(source, isHttps ? this.#httpsBehindProxy : this.#httpBehindProxy);
  }

  getIpStatus(source: string|IncomingMessage|Http2ServerRequest, track: boolean = true, rateRange: number = this.#ipRateRange, minRate: number = this.#metrics.minIpRate): ActorStatus {
    const sourceStr: string = this.resolveIp(source);
    const sourceInfo = this.#metrics.getIpInfo(sourceStr);

    const status = getStatus(sourceInfo, {
      minRate,
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

  resolveSubnet(source: string|IncomingMessage|Http2ServerRequest): string {
    return resolveSubnetFromIp(this.resolveIp(source), this.#subnetMaskBits);
  }

  getSubnetStatus(source: string|IncomingMessage|Http2ServerRequest, track: boolean = true, rateRange: number = this.#subnetRateRange, minRate: number = this.#metrics.minSubnetRate): ActorStatus {
    const sourceStr: string = this.resolveSubnet(source);
    const sourceInfo = this.#metrics.getSubnetInfo(sourceStr);

    const status = getStatus(sourceInfo, {
      minRate,
      lagRatio: this.lagRatio,
      rateRange
    });

    if (track && status === ActorStatus.Good) {
      // only track if we're NOT throttling
      // forward cache to avoid additional lookup
      this.#metrics.trackSubnet(sourceStr, sourceInfo as CacheItem);
    }

    return status;
  }

  isBadSubnet(subnet: string|IncomingMessage|Http2ServerRequest, track: boolean = true): boolean {
    return this.getSubnetStatus(subnet, track) === ActorStatus.Bad;
  }

  trackRequest(req: IncomingMessage|Http2ServerRequest): void {
    const host = this.resolveHost(req);
    this.#metrics.trackHost(host);
    const ip = this.resolveIp(req);
    this.#metrics.trackIp(ip);
    this.#metrics.trackSubnet(this.resolveSubnet(req));
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
