import { IncomingMessage } from 'http';
import { ConnectQOS, BeforeThrottleFn, BadActorType } from '../src';
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
    expect(beforeThrottle).not.toHaveBeenCalled;
    expect(writeHead).not.toHaveBeenCalled;
    expect(end).not.toHaveBeenCalled;
  });

  it('beforeThrottle NOT invoked if bad host but Host whitelisted', () => {
    const beforeThrottle = jest.fn().mockReturnValue(true) as BeforeThrottleFn;
    const hostWhitelist = new Set(['goodHost']);
    const qos = new ConnectQOS({ hostWhitelist, minHostRate: 1, maxHostRate: 1, minIpRate: 1, maxIpRate: 1 });
    const middleware = qos.getMiddleware({ beforeThrottle });
    expect(typeof middleware).toEqual('function');
    const writeHead = jest.fn();
    const end = jest.fn();
    const destroy = jest.fn();
    middleware({ headers: { host: 'goodHost' }, socket: { remoteAddress: 'badIp' } } as IncomingMessage, { writeHead, end, socket: { destroy, destroyed: false } }, () => {});
    expect(beforeThrottle).not.toHaveBeenCalled;
    expect(writeHead).not.toHaveBeenCalled;
    expect(end).not.toHaveBeenCalled;
    expect(destroy).not.toHaveBeenCalled;
    qos.isBadHost('goodHost', true);
    middleware({ headers: { host: 'badHost' }, socket: { remoteAddress: 'badIp' } } as IncomingMessage, { writeHead, end, socket: { destroy, destroyed: false } }, () => {});
    expect(beforeThrottle).toHaveBeenCalled;
    expect(writeHead).toHaveBeenCalled;
    expect(end).toHaveBeenCalled;
    expect(destroy).toHaveBeenCalled;
    middleware({ headers: { host: 'goodHost' }, socket: { remoteAddress: 'badIp' } } as IncomingMessage, { writeHead, end, socket: { destroy, destroyed: true } }, () => {});
    expect(beforeThrottle).not.toHaveBeenCalled;
    expect(writeHead).toHaveBeenCalled;
    expect(end).toHaveBeenCalled;
    expect(destroy).not.toHaveBeenCalled;
  });

  it('beforeThrottle NOT invoked if bad host but IP whitelisted', () => {
    const beforeThrottle = jest.fn().mockReturnValue(true) as BeforeThrottleFn;
    const ipWhitelist = new Set(['goodIp']);
    const qos = new ConnectQOS({ ipWhitelist, minHostRate: 1, maxHostRate: 1, minIpRate: 1, maxIpRate: 1 });
    const middleware = qos.getMiddleware({ beforeThrottle });
    expect(typeof middleware).toEqual('function');
    const writeHead = jest.fn();
    const end = jest.fn();
    const destroy = jest.fn();
    middleware({ headers: { host: 'badHost' }, socket: { remoteAddress: 'goodIp' } } as IncomingMessage, { writeHead, end, socket: { destroy, destroyed: false } }, () => {});
    expect(beforeThrottle).not.toHaveBeenCalled;
    expect(writeHead).not.toHaveBeenCalled;
    expect(end).not.toHaveBeenCalled;
    expect(destroy).not.toHaveBeenCalled;
    qos.isBadHost('badHost', true);
    middleware({ headers: { host: 'badHost' } } as IncomingMessage, { writeHead, end, socket: { destroy, destroyed: false } }, () => {});
    expect(beforeThrottle).toHaveBeenCalled;
    expect(writeHead).toHaveBeenCalled;
    expect(end).toHaveBeenCalled;
    expect(destroy).toHaveBeenCalled;
    middleware({ headers: { host: 'badHost' }, socket: { remoteAddress: 'goodIp' } } as IncomingMessage, { writeHead, end, socket: { destroy, destroyed: true } }, () => {});
    expect(beforeThrottle).not.toHaveBeenCalled;
    expect(writeHead).toHaveBeenCalled;
    expect(end).toHaveBeenCalled;
    expect(destroy).not.toHaveBeenCalled;
  });

  it('beforeThrottle invoked if bad host', () => {
    const beforeThrottle = jest.fn().mockReturnValue(true) as BeforeThrottleFn;
    const qos = new ConnectQOS({ minHostRate: 1, maxHostRate: 1 });
    const middleware = qos.getMiddleware({ beforeThrottle });
    expect(typeof middleware).toEqual('function');
    const writeHead = jest.fn();
    const end = jest.fn();
    const destroy = jest.fn();
    middleware({ headers: {} } as IncomingMessage, { writeHead, end, socket: { destroy, destroyed: false } }, () => {});
    expect(beforeThrottle).not.toHaveBeenCalled;
    expect(writeHead).not.toHaveBeenCalled;
    expect(end).not.toHaveBeenCalled;
    expect(destroy).not.toHaveBeenCalled;
    qos.isBadHost('unknown', true);
    middleware({ headers: {} } as IncomingMessage, { writeHead, end, socket: { destroy, destroyed: true } }, () => {});
    expect(beforeThrottle).toHaveBeenCalled;
    expect(writeHead).toHaveBeenCalled;
    expect(end).toHaveBeenCalled;
    expect(destroy).not.toHaveBeenCalled;
    middleware({ headers: {} } as IncomingMessage, { writeHead, end, socket: { destroy, destroyed: false } }, () => {});
    expect(beforeThrottle).toHaveBeenCalled;
    expect(writeHead).toHaveBeenCalled;
    expect(end).toHaveBeenCalled;
    expect(destroy).toHaveBeenCalled;
  });

  it('beforeThrottle invoked if bad host but not destroyed', () => {
    const beforeThrottle = jest.fn().mockReturnValue(true) as BeforeThrottleFn;
    const qos = new ConnectQOS({ minHostRate: 1, maxHostRate: 1 });
    const middleware = qos.getMiddleware({ beforeThrottle, destroySocket: false });
    expect(typeof middleware).toEqual('function');
    const writeHead = jest.fn();
    const end = jest.fn();
    const destroy = jest.fn();
    middleware({ headers: {} } as IncomingMessage, { writeHead, end, socket: { destroy, destroyed: false } }, () => {});
    expect(beforeThrottle).not.toHaveBeenCalled;
    expect(writeHead).not.toHaveBeenCalled;
    expect(end).not.toHaveBeenCalled;
    expect(destroy).not.toHaveBeenCalled;
    qos.isBadHost('unknown', true);
    middleware({ headers: {} } as IncomingMessage, { writeHead, end, socket: { destroy, destroyed: false } }, () => {});
    expect(beforeThrottle).toHaveBeenCalled;
    expect(writeHead).toHaveBeenCalled;
    expect(end).toHaveBeenCalled;
    expect(destroy).not.toHaveBeenCalled;
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
    expect(writeHead).toHaveBeenCalled;
    expect(end).toHaveBeenCalled;
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
    expect(writeHead).not.toHaveBeenCalled;
    expect(end).not.toHaveBeenCalled;
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
});
