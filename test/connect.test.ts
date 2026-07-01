import { IncomingMessage } from 'http';
import { ConnectQOS, BeforeThrottleFn, BadActorType, DEFAULT_SUBNET_MASK_BITS } from '../src';
import toobusy from 'toobusy-js';

jest.mock('toobusy-js');

global.Date.now = jest.fn();

beforeEach(() => {
  global.Date.now.mockReturnValue(0);
  toobusy.mockReturnValue(false);
  toobusy.maxLag = jest.fn();
  toobusy.lag = jest.fn().mockReturnValue(0);
});

describe('constructor', () => {
  it('defaults', () => {
    const qos = new ConnectQOS();
    expect(qos.minLag).toEqual(70);
    expect(qos.maxLag).toEqual(300);
    expect(qos.errorStatusCode).toEqual(503);
    expect(qos.httpBehindProxy).toEqual(false);
    expect(qos.httpsBehindProxy).toEqual(false);
  });

  it('overrides', () => {
    const qos = new ConnectQOS({
      minLag: 50,
      maxLag: 200,
      errorStatusCode: 500,
      httpBehindProxy: true,
      httpsBehindProxy: true
    });
    expect(qos.minLag).toEqual(50);
    expect(qos.maxLag).toEqual(200);
    expect(qos.errorStatusCode).toEqual(500);
    expect(qos.httpBehindProxy).toEqual(true);
    expect(qos.httpsBehindProxy).toEqual(true);
  });

  it('throws if subnetMaskBits is out of range', () => {
    expect(() => new ConnectQOS({ subnetMaskBits: 19 as any })).toThrow();
    expect(() => new ConnectQOS({ subnetMaskBits: 31 as any })).toThrow();
  });

  it('throws if minLag >= maxLag', () => {
    expect(() => new ConnectQOS({ minLag: 100, maxLag: 100 })).toThrow();
    expect(() => new ConnectQOS({ minLag: 200, maxLag: 100 })).toThrow();
  });

  it('subnetMaskBits defaults to 24', () => {
    // DEFAULT_SUBNET_MASK_BITS is 24; verify resolveSubnet uses /24 aggregation
    const qos = new ConnectQOS();
    expect(DEFAULT_SUBNET_MASK_BITS).toEqual(24);
    // 1.2.3.4 with /24 mask → subnet key is '1.2.3.0'
    expect(qos.resolveSubnet({
      headers: {},
      socket: { remoteAddress: '1.2.3.4' }
    } as IncomingMessage)).toEqual('1.2.3.0');
  });
});

describe('props', () => {
  it('lag returns 0 initially', () => {
    const qos = new ConnectQOS();
    expect(qos.lag).toEqual(0);
  });

  it('lag returns desired lag', () => {
    const qos = new ConnectQOS();
    toobusy.lag.mockReturnValue(100);
    expect(qos.lag).toEqual(100);
  });

  it('lagRatio returns 0 if no lag', () => {
    const qos = new ConnectQOS();
    expect(qos.lagRatio).toEqual(0);
  });

  it('lagRatio returns 0 if lag is minLag', () => {
    const minLag = 10;
    const maxLag = 20;
    const qos = new ConnectQOS({ minLag, maxLag });
    expect(qos.lagRatio).toEqual(0);
    toobusy.lag.mockReturnValue(minLag);
    expect(qos.lagRatio).toEqual(0);
  });

  it('lagRatio returns 0.5 if lag is half way between min and max lag', () => {
    const minLag = 10;
    const maxLag = 20;
    const qos = new ConnectQOS({ minLag, maxLag });
    toobusy.lag.mockReturnValue(15);
    expect(qos.lagRatio).toEqual(0.5);
  });

  it('lagRatio returns 1 if lag is maxLag', () => {
    const minLag = 10;
    const maxLag = 20;
    const qos = new ConnectQOS({ minLag, maxLag });
    toobusy.lag.mockReturnValue(maxLag);
    expect(qos.lagRatio).toEqual(1);
  });

  it('lagRatio returns 1 if lag exceeds maxLag', () => {
    const minLag = 10;
    const maxLag = 20;
    const qos = new ConnectQOS({ minLag, maxLag });
    toobusy.lag.mockReturnValue(maxLag * 2);
    expect(qos.lagRatio).toEqual(1);
  });
});

describe('getMiddleware', () => {
  it('returns Function', () => {
    const qos = new ConnectQOS();
    const middleware = qos.getMiddleware();
    expect(typeof middleware).toEqual('function');
  });

  it('beforeThrottle option', () => {
    const beforeThrottle = jest.fn().mockReturnValue(true) as BeforeThrottleFn;
    const qos = new ConnectQOS();
    const middleware = qos.getMiddleware({ beforeThrottle });
    expect(typeof middleware).toEqual('function');
    const writeHead = jest.fn();
    const end = jest.fn();
    middleware({ headers: {} } as IncomingMessage, { writeHead, end }, () => {});
    expect(beforeThrottle).not.toHaveBeenCalled();
    expect(writeHead).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });

  it('beforeThrottle NOT invoked if bad host but Host whitelisted', () => {
    const beforeThrottle = jest.fn().mockReturnValue(true) as BeforeThrottleFn;
    const hostWhitelist = new Set(['goodHost']);
    const qos = new ConnectQOS({ hostWhitelist, minHostRate: 1, maxHostRate: 1, minIpRate: 1, maxIpRate: 1, maxAge: 1000 });
    const middleware = qos.getMiddleware({ beforeThrottle });
    expect(typeof middleware).toEqual('function');
    const end = jest.fn();
    const destroySoon = jest.fn();
    middleware({ headers: { host: 'goodHost' }, socket: { remoteAddress: 'badIp' } } as IncomingMessage, { end, socket: { destroySoon, destroyed: false } }, () => {});
    expect(beforeThrottle).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(destroySoon).not.toHaveBeenCalled();
    qos.isBadHost('goodHost', true);
    middleware({ headers: { host: 'badHost' }, socket: { remoteAddress: 'badIp' } } as IncomingMessage, { end, socket: { destroySoon, destroyed: false } }, () => {});
    expect(beforeThrottle).toHaveBeenCalled();
    expect(end).toHaveBeenCalled();
    expect(destroySoon).toHaveBeenCalled();
    destroySoon.mockReset();
    middleware({ headers: { host: 'goodHost' }, socket: { remoteAddress: 'badIp' } } as IncomingMessage, { end, socket: { destroySoon, destroyed: true } }, () => {});
    expect(beforeThrottle).toHaveBeenCalled();
    expect(end).toHaveBeenCalled();
    expect(destroySoon).not.toHaveBeenCalled();
  });

  it('beforeThrottle NOT invoked if bad host but IP whitelisted', () => {
    const beforeThrottle = jest.fn().mockReturnValue(true) as BeforeThrottleFn;
    const ipWhitelist = new Set(['goodIp']);
    const qos = new ConnectQOS({ ipWhitelist, minHostRate: 1, maxHostRate: 1, minIpRate: 1, maxIpRate: 1, maxAge: 1000 });
    const middleware = qos.getMiddleware({ beforeThrottle });
    expect(typeof middleware).toEqual('function');
    const end = jest.fn();
    const destroySoon = jest.fn();
    middleware({ headers: { host: 'badHost' }, socket: { remoteAddress: 'goodIp' } } as IncomingMessage, { end, socket: { destroySoon, destroyed: false } }, () => {});
    expect(beforeThrottle).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(destroySoon).not.toHaveBeenCalled();
    qos.isBadHost('badHost', true);
    middleware({ headers: { host: 'badHost' } } as IncomingMessage, { end, socket: { destroySoon, destroyed: false } }, () => {});
    expect(beforeThrottle).toHaveBeenCalled();
    expect(end).toHaveBeenCalled();
    expect(destroySoon).toHaveBeenCalled();
    destroySoon.mockReset();
    middleware({ headers: { host: 'badHost' }, socket: { remoteAddress: 'goodIp' } } as IncomingMessage, { end, socket: { destroySoon, destroyed: true } }, () => {});
    expect(beforeThrottle).toHaveBeenCalled();
    expect(end).toHaveBeenCalled();
    expect(destroySoon).not.toHaveBeenCalled();
  });

  it('beforeThrottle invoked if bad host', () => {
    const beforeThrottle = jest.fn().mockReturnValue(true) as BeforeThrottleFn;
    const qos = new ConnectQOS({ minHostRate: 1, maxHostRate: 1, maxAge: 1000 });
    const middleware = qos.getMiddleware({ beforeThrottle });
    expect(typeof middleware).toEqual('function');
    const end = jest.fn();
    const destroySoon = jest.fn();
    middleware({ headers: {} } as IncomingMessage, { end, socket: { destroySoon, destroyed: false } }, () => {});
    expect(beforeThrottle).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(destroySoon).not.toHaveBeenCalled();
    qos.isBadHost('unknown', true);
    middleware({ headers: {} } as IncomingMessage, { end, socket: { destroySoon, destroyed: true } }, () => {});
    expect(beforeThrottle).toHaveBeenCalled();
    expect(end).toHaveBeenCalled();
    expect(destroySoon).not.toHaveBeenCalled();
    middleware({ headers: {} } as IncomingMessage, { end, socket: { destroySoon, destroyed: false } }, () => {});
    expect(beforeThrottle).toHaveBeenCalled();
    expect(end).toHaveBeenCalled();
    expect(destroySoon).toHaveBeenCalled();
  });

  it('beforeThrottle invoked if bad host but not destroyed', () => {
    const beforeThrottle = jest.fn().mockReturnValue(true) as BeforeThrottleFn;
    const qos = new ConnectQOS({ minHostRate: 1, maxHostRate: 1 });
    const middleware = qos.getMiddleware({ beforeThrottle, destroySocket: false });
    expect(typeof middleware).toEqual('function');
    const writeHead = jest.fn();
    const end = jest.fn();
    const destroySoon = jest.fn();
    middleware({ headers: {} } as IncomingMessage, { writeHead, end, socket: { destroySoon, destroyed: false } }, () => {});
    expect(beforeThrottle).not.toHaveBeenCalled();
    expect(writeHead).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(destroySoon).not.toHaveBeenCalled();
    qos.isBadHost('unknown', true);
    middleware({ headers: {} } as IncomingMessage, { writeHead, end, socket: { destroySoon, destroyed: false } }, () => {});
    expect(beforeThrottle).not.toHaveBeenCalled();
    expect(writeHead).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(destroySoon).not.toHaveBeenCalled();
  });

  it('beforeThrottle invoked if badHost', () => {
    const beforeThrottle = jest.fn().mockReturnValue(true) as BeforeThrottleFn;
    const qos = new ConnectQOS({ maxAge: 1000, minHostRate: 1, maxHostRate: 1 });
    const middleware = qos.getMiddleware({ beforeThrottle });
    expect(typeof middleware).toEqual('function');
    qos.isBadHost('unknown', true);
    const writeHead = jest.fn();
    const end = jest.fn();
    const req = { headers: {} } as IncomingMessage;
    middleware(req, { writeHead, end, socket: { destroyed: true } }, () => {});
    expect(beforeThrottle).toHaveBeenCalledWith(qos, req, BadActorType.badHost);
    expect(writeHead).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalled();
  });

  it('errorResponseDelay defers sendError via setTimeout', () => {
    jest.useFakeTimers();
    const qos = new ConnectQOS({ maxAge: 1000, minHostRate: 1, maxHostRate: 1, errorResponseDelay: 200 });
    qos.isBadHost('unknown', true);
    const end = jest.fn();
    qos.getMiddleware()({ headers: {} } as IncomingMessage, { end, socket: { destroyed: true } }, () => {});
    expect(end).not.toHaveBeenCalled(); // not called yet — waiting for delay
    jest.advanceTimersByTime(200);
    expect(end).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('beforeThrottle invoked if badHost bad not blocked if returns false', () => {
    const beforeThrottle = jest.fn().mockReturnValue(false) as BeforeThrottleFn;
    const qos = new ConnectQOS({ maxAge: 1000, minHostRate: 1, maxHostRate: 1 });
    const middleware = qos.getMiddleware({ beforeThrottle });
    expect(typeof middleware).toEqual('function');
    qos.isBadHost('unknown', true);
    const writeHead = jest.fn();
    const end = jest.fn();
    const req = { headers: {} } as IncomingMessage;
    middleware(req, { writeHead, end }, () => {});
    expect(beforeThrottle).toHaveBeenCalledWith(qos, req, BadActorType.badHost);
    expect(writeHead).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });
});

describe('isBadHost', () => {
  it('returns false if no bad hosts', () => {
    const qos = new ConnectQOS();
    expect(qos.isBadHost('unknown')).toEqual(false);
  });

  it('returns true if bad hosts', () => {
    const qos = new ConnectQOS({ maxAge: 1000, minHostRate: 2, maxHostRate: 2 });
    expect(qos.isBadHost('unknown', false)).toEqual(false); // insufficient history
    qos.isBadHost('unknown', true);
    expect(qos.isBadHost('unknown', false)).toEqual(false); // insufficient history
    qos.isBadHost('unknown', true);
    expect(qos.isBadHost('unknown', false)).toEqual(true);
  });

  it('returns true if throttling bad hosts', () => {
    const qos = new ConnectQOS({ maxAge: 1000, minHostRate: 1, maxHostRate: 1 });
    expect(qos.isBadHost('a')).toEqual(false);
    expect(qos.metrics.getHostInfo('a')?.history.length).toEqual(1);
    expect(qos.isBadHost('a')).toEqual(true);
    expect(qos.metrics.getHostInfo('a')?.history.length).toEqual(1); // bad hosts won't track
  });

  it('normalizes host correctly and identifies bad host', () => {
    const qos = new ConnectQOS({ maxAge: 1000, minHostRate: 1, maxHostRate: 1 });
    expect(qos.isBadHost('a.com:443')).toEqual(false);
    expect(qos.isBadHost('a.com')).toEqual(true);
    expect(qos.isBadHost('www.a.com:443')).toEqual(true);
  });
});

describe('isBadIp', () => {
  it('returns false if no bad IPs', () => {
    const qos = new ConnectQOS();
    expect(qos.isBadIp('unknown')).toEqual(false);
  });

  it('returns true if bad IPs', () => {
    const qos = new ConnectQOS({ maxAge: 1000, minIpRate: 2, maxIpRate: 2 });
    expect(qos.isBadIp('unknown', false)).toEqual(false); // insufficient history
    qos.isBadIp('unknown', true);
    expect(qos.isBadIp('unknown', false)).toEqual(false); // insufficient history
    qos.isBadIp('unknown', true);
    expect(qos.isBadIp('unknown', false)).toEqual(true);
  });

  it('returns true if throttling bad IPs', () => {
    const qos = new ConnectQOS({ maxAge: 1000, minIpRate: 1, maxIpRate: 1 });
    expect(qos.isBadIp('a')).toEqual(false);
    expect(qos.metrics.getIpInfo('a')?.history.length).toEqual(1);
    expect(qos.isBadIp('a')).toEqual(true);
    expect(qos.metrics.getIpInfo('a')?.history.length).toEqual(1); // bad IPs won't track
  });
});

describe('isBadSubnet', () => {
  it('returns false if no bad subnets', () => {
    const qos = new ConnectQOS();
    expect(qos.isBadSubnet('1.2.3')).toEqual(false);
  });

  it('returns true if bad subnets', () => {
    const qos = new ConnectQOS({ maxAge: 1000, minSubnetRate: 2, maxSubnetRate: 2 });
    expect(qos.isBadSubnet('1.2.3', false)).toEqual(false); // insufficient history
    qos.isBadSubnet('1.2.3', true);
    expect(qos.isBadSubnet('1.2.3', false)).toEqual(false); // insufficient history
    qos.isBadSubnet('1.2.3', true);
    expect(qos.isBadSubnet('1.2.3', false)).toEqual(true);
  });

  it('returns true if throttling bad subnets', () => {
    const qos = new ConnectQOS({ maxAge: 1000, minSubnetRate: 1, maxSubnetRate: 1 });
    expect(qos.isBadSubnet('1.2.3')).toEqual(false);
    expect(qos.metrics.getSubnetInfo('1.2.3')?.history.length).toEqual(1);
    expect(qos.isBadSubnet('1.2.3')).toEqual(true);
    expect(qos.metrics.getSubnetInfo('1.2.3')?.history.length).toEqual(1); // bad subnets won't track
  });

  it('resolves subnet from request socket address', () => {
    const qos = new ConnectQOS({ maxAge: 1000, minSubnetRate: 1, maxSubnetRate: 1 });
    const req = { headers: {}, socket: { remoteAddress: '1.2.3.4' } } as IncomingMessage;
    expect(qos.isBadSubnet(req)).toEqual(false);       // first hit — insufficient history
    expect(qos.isBadSubnet(req)).toEqual(true);        // second hit — bad subnet
    expect(qos.metrics.subnets.get('1.2.3.0')?.history.length).toEqual(1); // bad subnets won't track
  });
});

describe('shouldThrottleRequest', () => {
  it('if host or IP is whitelisted do not throttle', () => {
    const qos = new ConnectQOS({ maxAge: 1000, minHostRate: 1, maxHostRate: 1, minIpRate: 1, maxIpRate: 1, hostWhitelist: new Set(['goodhost.com']), ipWhitelist: new Set(['goodIp']) });
    expect(qos.shouldThrottleRequest({
      headers: { host: 'goodhost.com' }
    } as IncomingMessage)).toEqual(false);
    expect(qos.shouldThrottleRequest({
      headers: { host: 'goodhost.com' }
    } as IncomingMessage)).toEqual(false);
    expect(qos.shouldThrottleRequest({
      headers: { host: 'badhost.com' }
    } as IncomingMessage)).toEqual(false); // first attempt hasn't satisified minHostRate
    expect(qos.shouldThrottleRequest({
      headers: { host: 'badhost.com' }
    } as IncomingMessage)).toEqual(BadActorType.badHost);
    expect(qos.shouldThrottleRequest({
      headers: { host: 'badhost.com' },
      socket: { remoteAddress: 'goodIp' }
    } as IncomingMessage)).toEqual(false); // won't block even if bad host since goodIp is whitelisted
    expect(qos.shouldThrottleRequest({
      headers: { host: 'badhost.com' },
      socket: { remoteAddress: 'goodIp' }
    } as IncomingMessage)).toEqual(false); // won't block even if bad host since goodIp is whitelisted
    expect(qos.shouldThrottleRequest({
      headers: { host: 'goodhost.com' },
      socket: { remoteAddress: 'badIp' }
    } as IncomingMessage)).toEqual(false); // won't block even if bad IP since goodhost.com is whitelisted
    expect(qos.shouldThrottleRequest({
      headers: { host: 'goodhost.com' },
      socket: { remoteAddress: 'badIp' }
    } as IncomingMessage)).toEqual(false); // won't block even if bad IP since goodhost.com is whitelisted
  });

  it('whitelisted host/IP still exempt when local tracking is disabled (minHostRate/minIpRate=0)', () => {
    // When minHostRate=0, Metrics.getInfo returns Good (not Whitelisted) because minRequests=0
    // short-circuits before the whitelist check. The guard must check whitelist sets directly.
    const qos = new ConnectQOS({
      maxAge: 1000,
      minHostRate: 0, maxHostRate: 0, // host tracking disabled
      minIpRate: 0, maxIpRate: 0,     // ip tracking disabled
      hostWhitelist: new Set(['goodhost.com']),
      ipWhitelist: new Set(['1.2.3.4']),
    });
    expect(qos.shouldThrottleRequest({
      headers: { host: 'goodhost.com' },
      socket: { remoteAddress: '9.9.9.9' }
    } as IncomingMessage)).toEqual(false);
    expect(qos.shouldThrottleRequest({
      headers: { host: 'badhost.com' },
      socket: { remoteAddress: '1.2.3.4' }
    } as IncomingMessage)).toEqual(false);
  });

  it('if host monitoring disabled should still be able to throttle IPs', () => {
    const qos = new ConnectQOS({ maxAge: 1000, minIpRate: 1, maxIpRate: 1, minHostRate: 0 });
    expect(qos.shouldThrottleRequest({
      headers: { host: 'ignored' },
      socket: { remoteAddress: 'a' }
    } as IncomingMessage)).toEqual(false); // hasn't satisified minIpRate
    expect(qos.shouldThrottleRequest({
      headers: { host: 'ignored' },
      socket: { remoteAddress: 'a' }
    } as IncomingMessage)).toEqual(BadActorType.badIp);
    expect(qos.shouldThrottleRequest({
      headers: { host: 'ignored' },
      socket: { remoteAddress: 'b' }
    } as IncomingMessage)).toEqual(false); // hasn't satisified minIpRate
  });

  it('if IP monitoring disabled should still be able to throttle hosts', () => {
    const qos = new ConnectQOS({ maxAge: 1000, minHostRate: 1, maxHostRate: 1, minIpRate: 0 });
    expect(qos.shouldThrottleRequest({
      headers: { host: 'a' },
      socket: { remoteAddress: 'ignoredIp' }
    } as IncomingMessage)).toEqual(false); // hasn't satisified maxHostRate
    expect(qos.shouldThrottleRequest({
      headers: { host: 'a' },
      socket: { remoteAddress: 'ignoredIp' }
    } as IncomingMessage)).toEqual(BadActorType.badHost);
    expect(qos.shouldThrottleRequest({
      headers: { host: 'b' },
      socket: { remoteAddress: 'ignoredIp' }
    } as IncomingMessage)).toEqual(false); // hasn't satisified maxHostRate
  });

  it('handle bursts of requests over time', () => {
    const qos = new ConnectQOS({
      minIpRate: 3, // 30 requests per 10s window
      maxIpRate: 6, // 60 requests per 10s window
      minLag: 40,
      maxLag: 300,
      maxAge: 10 * 1000,
      minHostRate: 10,
      maxHostRate: 10
    });
    toobusy.lag.mockReturnValue(0); // no lag will use max rate limit
    for (let i = 0; i < 60; i++) {
      // should only ever flag `badIp` anyway due to threshold being under 10/sec
      const shouldBeThrottled = i >= 59 ? 'badIp' : false;
      global.Date.now.mockReturnValue((i/60) * 10_000);
      const res = qos.shouldThrottleRequest({
        headers: { host: 'ignored' },
        socket: { remoteAddress: 'a' }
      } as IncomingMessage);
      expect(res).toEqual(shouldBeThrottled);
    }
  });

  it('maxHostRatio flags host violations as hostViolation', () => {
    const qos = new ConnectQOS({
      maxHostRatio: 0.5,
      minHostRate: 1,
      maxHostRate: 1,
      minIpRate: 1,
      maxIpRate: 1
    });
    qos.metrics.hostRatioViolations.add('a');
    expect(qos.shouldThrottleRequest({
      headers: { host: 'a' },
      socket: { remoteAddress: 'ignoredIp' }
    } as IncomingMessage)).toEqual(BadActorType.hostViolation);
    expect(qos.shouldThrottleRequest({
      headers: { host: 'b' },
      socket: { remoteAddress: 'ignoredIp' }
    } as IncomingMessage)).toEqual(false);
  });

  it('maxIpRateHostViolation flags host violations as hostViolation only if IP rate is exceeded', () => {
    const qos = new ConnectQOS({
      maxIpRateHostViolation: 1,
      maxHostRatio: 0.5,
      minIpRate: 1,
      maxIpRate: 10000,
      maxAge: 1000
    });
    qos.metrics.hostRatioViolations.add('a');
    expect(qos.shouldThrottleRequest({
      headers: { host: 'a' },
      socket: { remoteAddress: 'badIp' }
    } as IncomingMessage)).toEqual(false);
    expect(qos.shouldThrottleRequest({
      headers: { host: 'a' },
      socket: { remoteAddress: 'badIp' }
    } as IncomingMessage)).toEqual(BadActorType.hostViolation);
  });

  it('maxIpRateHostViolation below minIpRate correctly enforces the lower threshold', () => {
    // Bug: old code computed violationRange = max(0, maxIpRateHostViolation - minIpRate)
    //      when maxIpRateHostViolation(1) < minIpRate(3), range was 0 and
    //      dynamicRate = minIpRate(3), so threshold was 3 req/s instead of 1 req/s.
    // Fix: violationMin = min(maxIpRateHostViolation, minIpRate) = 1,
    //      violationRange = max(0, 1-1) = 0, dynamicRate = 1 req/s (correct).
    //
    // To observe the difference, we need a measured IP rate between 1 and 3 req/s.
    // With minIpRate:3, maxAge:2000 → minIpRequests = round(3*2) = 6.
    // Track 6 requests spread evenly so rate = exactly 3 req/s at check time.
    // Old threshold: 3 req/s, rate(3) > 3 = false (no fire).
    // New threshold: 1 req/s, rate(3) > 1 = true (fires!).
    const maxAge = 2000;
    const qos = new ConnectQOS({
      maxIpRateHostViolation: 1,
      minIpRate: 3,
      maxIpRate: 10000,
      maxAge
    });
    qos.metrics.hostRatioViolations.add('a');

    // Track 6 requests spread over 2000ms (rate = 6/2000ms * 1000 = 3 req/s)
    const timestamps = [0, 400, 800, 1200, 1600, 2000];
    for (const t of timestamps) {
      global.Date.now.mockReturnValue(t);
      const result = qos.shouldThrottleRequest({
        headers: { host: 'b' }, // use non-violated host so requests are tracked
        socket: { remoteAddress: 'badIp' }
      } as IncomingMessage);
      expect(result).toEqual(false); // none should throttle (not violated host, IP rate not yet exceeded vs maxIpRate)
    }

    // Now check against violated host 'a'. Rate is 3 req/s, which is > violationThreshold(1) but not > maxIpRate(10000).
    // With the fix the check uses threshold=1, so rate(3) > 1 → hostViolation.
    global.Date.now.mockReturnValue(2000);
    expect(qos.shouldThrottleRequest({
      headers: { host: 'a' },
      socket: { remoteAddress: 'badIp' }
    } as IncomingMessage)).toEqual(BadActorType.hostViolation);
  });

  it('badSubnet returned when subnet rate exceeded', () => {
    const qos = new ConnectQOS({ maxAge: 1000, minSubnetRate: 1, maxSubnetRate: 1 });
    // First request: insufficient history → not throttled
    expect(qos.shouldThrottleRequest({
      headers: { host: 'somehost' },
      socket: { remoteAddress: '1.2.3.4' }
    } as IncomingMessage)).toEqual(false);
    // Second request: rate exceeded → badSubnet
    expect(qos.shouldThrottleRequest({
      headers: { host: 'somehost' },
      socket: { remoteAddress: '1.2.3.4' }
    } as IncomingMessage)).toEqual(BadActorType.badSubnet);
  });

  it('subnet whitelisted IPs are not flagged as badSubnet', () => {
    const qos = new ConnectQOS({ maxAge: 1000, minSubnetRate: 1, maxSubnetRate: 1, subnetWhitelist: new Set(['1.2.3.0']) });
    // Both requests from 1.2.3.4 (subnet 1.2.3.0/24 is whitelisted) should never get badSubnet
    expect(qos.shouldThrottleRequest({
      headers: { host: 'somehost' },
      socket: { remoteAddress: '1.2.3.4' }
    } as IncomingMessage)).toEqual(false);
    expect(qos.shouldThrottleRequest({
      headers: { host: 'somehost' },
      socket: { remoteAddress: '1.2.3.4' }
    } as IncomingMessage)).toEqual(false);
  });

  it('maxSubnetRateHostViolation flags host violations when subnet rate exceeded', () => {
    // maxIpRateHostViolation is unset — only maxSubnetRateHostViolation gates the violation.
    // First request hits the violated host but has no subnet history → subnet Good → no hostViolation.
    // Second request: subnet rate >> threshold → hostViolation.
    // This proves the subnet check is the actual gate (not an unconditional hostViolation return).
    const qos = new ConnectQOS({
      maxSubnetRateHostViolation: 1,
      minSubnetRate: 1,
      maxSubnetRate: 10000,
      maxAge: 1000
    });
    qos.metrics.hostRatioViolations.add('a');

    global.Date.now.mockReturnValue(0);
    // First request to violated host: no subnet history yet → subnet Good → not hostViolation
    expect(qos.shouldThrottleRequest({
      headers: { host: 'a' },
      socket: { remoteAddress: '1.2.3.4' }
    } as IncomingMessage)).toEqual(false);

    // Second request to violated host: subnet rate >> 1 req/s → hostViolation
    expect(qos.shouldThrottleRequest({
      headers: { host: 'a' },
      socket: { remoteAddress: '1.2.3.4' }
    } as IncomingMessage)).toEqual(BadActorType.hostViolation);
  });
});

describe('cluster integration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shouldThrottleRequest returns badIp when cluster blocks the IP', () => {
    const mockRedisClient = {
      pipeline: jest.fn().mockReturnValue({
        zincrby: jest.fn().mockReturnThis(),
        zrangebyscore: jest.fn().mockReturnThis(),
        zremrangebyrank: jest.fn().mockReturnThis(),
        incrby: jest.fn().mockReturnThis(),
        get: jest.fn().mockReturnThis(),
        unlink: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
    };
    const qos = new ConnectQOS({
      minIpRate: 0, // disable local IP limiting
      maxAge: 1000,
      cluster: {
        redis: { client: mockRedisClient },
        syncIntervalMs: 2000,
        clusterMaxIpRate: 50,
      },
    });

    // Manually inject a blocked IP into the cluster sync's blocklist
    qos.clusterSync!.blockedIps.add('1.2.3.4');

    const result = qos.shouldThrottleRequest({
      headers: { host: 'example.com' },
      socket: { remoteAddress: '1.2.3.4' }
    } as IncomingMessage);

    expect(result).toEqual(BadActorType.badIp);
    qos.destroy();
  });

  it('shouldThrottleRequest returns badSubnet when cluster blocks the subnet', () => {
    const mockRedisClient = {
      pipeline: jest.fn().mockReturnValue({
        zincrby: jest.fn().mockReturnThis(),
        zrangebyscore: jest.fn().mockReturnThis(),
        zremrangebyrank: jest.fn().mockReturnThis(),
        incrby: jest.fn().mockReturnThis(),
        get: jest.fn().mockReturnThis(),
        unlink: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
    };
    const qos = new ConnectQOS({
      minSubnetRate: 0, // disable local subnet limiting
      maxAge: 1000,
      cluster: {
        redis: { client: mockRedisClient },
        syncIntervalMs: 2000,
        clusterMaxSubnetRate: 200,
      },
    });

    qos.clusterSync!.blockedSubnets.add('1.2.3.0');

    const result = qos.shouldThrottleRequest({
      headers: { host: 'example.com' },
      socket: { remoteAddress: '1.2.3.4' }
    } as IncomingMessage);

    expect(result).toEqual(BadActorType.badSubnet);
    qos.destroy();
  });

  it('shouldThrottleRequest returns hostViolation when cluster detects host ratio violation', () => {
    const mockRedisClient = {
      pipeline: jest.fn().mockReturnValue({
        zincrby: jest.fn().mockReturnThis(),
        zrangebyscore: jest.fn().mockReturnThis(),
        zremrangebyrank: jest.fn().mockReturnThis(),
        incrby: jest.fn().mockReturnThis(),
        get: jest.fn().mockReturnThis(),
        unlink: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
    };
    const qos = new ConnectQOS({
      minIpRate: 1,
      maxIpRate: 1,
      maxAge: 1000,
      cluster: {
        redis: { client: mockRedisClient },
        syncIntervalMs: 2000,
        clusterMaxHostRatio: 0.15,
        clusterMaxIpRateHostViolation: 1,
      },
    });

    qos.clusterSync!.hostViolations.add('attacked.com');

    // First request: tracks the IP (history = 1)
    expect(qos.shouldThrottleRequest({
      headers: { host: 'attacked.com' },
      socket: { remoteAddress: '1.2.3.4' }
    } as IncomingMessage)).toEqual(false);

    // Second request: IP rate exceeds clusterMaxIpRateHostViolation threshold
    expect(qos.shouldThrottleRequest({
      headers: { host: 'attacked.com' },
      socket: { remoteAddress: '1.2.3.4' }
    } as IncomingMessage)).toEqual(BadActorType.hostViolation);

    qos.destroy();
  });

  it('whitelisted IPs are never cluster-blocked', () => {
    const mockRedisClient = {
      pipeline: jest.fn().mockReturnValue({
        zincrby: jest.fn().mockReturnThis(),
        zrangebyscore: jest.fn().mockReturnThis(),
        zremrangebyrank: jest.fn().mockReturnThis(),
        incrby: jest.fn().mockReturnThis(),
        get: jest.fn().mockReturnThis(),
        unlink: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
    };
    const qos = new ConnectQOS({
      maxAge: 1000,
      ipWhitelist: new Set(['1.2.3.4']),
      cluster: {
        redis: { client: mockRedisClient },
        syncIntervalMs: 2000,
        clusterMaxIpRate: 50,
      },
    });

    qos.clusterSync!.blockedIps.add('1.2.3.4');

    const result = qos.shouldThrottleRequest({
      headers: { host: 'example.com' },
      socket: { remoteAddress: '1.2.3.4' }
    } as IncomingMessage);

    expect(result).toEqual(false);
    qos.destroy();
  });

  it('no cluster sync created when cluster option is not provided', () => {
    const qos = new ConnectQOS({ maxAge: 1000 });
    expect(qos.clusterSync).toBeUndefined();
  });

  it('destroy() stops the cluster sync', () => {
    const mockRedisClient = {
      pipeline: jest.fn().mockReturnValue({
        zincrby: jest.fn().mockReturnThis(),
        zrangebyscore: jest.fn().mockReturnThis(),
        zremrangebyrank: jest.fn().mockReturnThis(),
        incrby: jest.fn().mockReturnThis(),
        get: jest.fn().mockReturnThis(),
        unlink: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
    };
    const qos = new ConnectQOS({
      maxAge: 1000,
      cluster: {
        redis: { client: mockRedisClient },
        syncIntervalMs: 2000,
        clusterMaxIpRate: 50,
      },
    });

    expect(qos.clusterSync!.isRunning).toBe(true);
    qos.destroy();
    expect(qos.clusterSync!.isRunning).toBe(false);
  });
});

describe('resolveHost', () => {
  it('returns self if string', () => {
    const qos = new ConnectQOS();
    expect(qos.resolveHost('a')).toEqual('a');
  });
});

describe('resolveIp', () => {
  it('returns self if string', () => {
    const qos = new ConnectQOS();
    expect(qos.resolveIp('a')).toEqual('a');
  });

  it('returns remoteAddress by default', () => {
    const qos = new ConnectQOS();
    expect(qos.resolveIp({
      headers: {},
      socket: { remoteAddress: 'a' }
    } as IncomingMessage)).toEqual('a');
  });

  it('returns x-forwarded-for if enabled via http', () => {
    const qos = new ConnectQOS({ httpBehindProxy: true });
    /* @ts-ignore */
    expect(qos.resolveIp({
      headers: { 'x-forwarded-for': 'a' },
      socket: { remoteAddress: 'ignored' }
    } as IncomingMessage)).toEqual('a');
  });

  it('returns x-forwarded-for if enabled via https', () => {
    const qos = new ConnectQOS({ httpsBehindProxy: true });
    /* @ts-ignore */
    expect(qos.resolveIp({
      scheme: 'https',
      headers: { 'x-forwarded-for': 'a' },
      socket: { remoteAddress: 'ignored' }
    } as IncomingMessage)).toEqual('a');
  });

  it('extracts only the first IP from a comma-separated x-forwarded-for', () => {
    const qos = new ConnectQOS({ httpBehindProxy: true });
    expect(qos.resolveIp({
      headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1, 10.0.0.2' },
      socket: { remoteAddress: 'ignored' }
    } as IncomingMessage)).toEqual('1.2.3.4');
  });

  it('uses socket.remoteAddress for HTTP/1.1 TLS even if httpBehindProxy is true', () => {
    // httpBehindProxy applies to plain HTTP. For TLS (socket.encrypted=true), httpsBehindProxy
    // must be used instead — otherwise an attacker on an HTTPS connection could spoof their IP
    // via x-forwarded-for even though no trusted proxy set that header.
    const qos = new ConnectQOS({ httpBehindProxy: true, httpsBehindProxy: false });
    expect(qos.resolveIp({
      headers: { 'x-forwarded-for': 'spoofed' },
      socket: { remoteAddress: '1.2.3.4', encrypted: true }
    } as IncomingMessage)).toEqual('1.2.3.4');
  });

  it('trusts x-forwarded-for for HTTP/1.1 TLS when httpsBehindProxy is true', () => {
    const qos = new ConnectQOS({ httpsBehindProxy: true });
    expect(qos.resolveIp({
      headers: { 'x-forwarded-for': '5.6.7.8' },
      socket: { remoteAddress: 'ignored', encrypted: true }
    } as IncomingMessage)).toEqual('5.6.7.8');
  });
});
