import { IncomingMessage } from 'http';
import { default as ConnectQOS, BeforeThrottleFn, BadActorType } from '../src';
import toobusy from 'toobusy-js';

jest.mock('toobusy-js');

toobusy.mockReturnValue(false);
toobusy.maxLag = jest.fn();
toobusy.lag = jest.fn().mockReturnValue(0);

describe('constructor', () => {
  it('defaults', () => {
    const qos = new ConnectQOS();
    expect(qos.maxLag).toEqual(70);
    expect(qos.userLag).toEqual(300);
    expect(qos.errorStatusCode).toEqual(503);
  });

  it('overrides', () => {
    const qos = new ConnectQOS({
      maxLag: 50,
      userLag: 200,
      errorStatusCode: 500
    });
    expect(qos.maxLag).toEqual(50);
    expect(qos.userLag).toEqual(200);
    expect(qos.errorStatusCode).toEqual(500);
  });
});

describe('metrics', () => {
  it('defaults', () => {
    const qos = new ConnectQOS();
    expect(qos.metrics.historySize).toEqual(1000);
  });

  it('overrides', () => {
    const qos = new ConnectQOS({ historySize: 100 });
    expect(qos.metrics.historySize).toEqual(100);
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

  it('throttled if toobusy', () => {
    const qos = new ConnectQOS({ waitForHistory: false });
    const middleware = qos.getMiddleware();
    expect(typeof middleware).toEqual('function');
    qos.metrics.badHosts.set('unknown', 1); // force it
    const writeHead = jest.fn();
    const end = jest.fn();
    qos.metrics.badHosts.set('unknown', 1); // force it
    toobusy.mockReturnValue(true);
    middleware({ headers: {} } as IncomingMessage, { writeHead, end }, () => {});
    expect(writeHead).toHaveBeenCalled;
    expect(end).toHaveBeenCalled;
  });

  it('throttled if no bad actors but lag exceeds userLag', () => {
    const beforeThrottle = jest.fn().mockReturnValue(true) as BeforeThrottleFn;
    const qos = new ConnectQOS({ waitForHistory: false });
    const middleware = qos.getMiddleware({ beforeThrottle });
    expect(typeof middleware).toEqual('function');
    const writeHead = jest.fn();
    const end = jest.fn();
    toobusy.lag.mockReturnValue(1000);
    toobusy.mockReturnValue(true);
    const req = { headers: {} } as IncomingMessage;
    middleware(req, { writeHead, end }, () => {});
    expect(beforeThrottle).toHaveBeenCalledWith(qos, req, BadActorType.userLag);
    expect(writeHead).toHaveBeenCalled;
    expect(end).toHaveBeenCalled;
  });

  it('beforeThrottle invoked if badHost', () => {
    const beforeThrottle = jest.fn().mockReturnValue(true) as BeforeThrottleFn;
    const qos = new ConnectQOS({ waitForHistory: false });
    const middleware = qos.getMiddleware({ beforeThrottle });
    expect(typeof middleware).toEqual('function');
    qos.metrics.badHosts.set('unknown', 1); // force it
    const writeHead = jest.fn();
    const end = jest.fn();
    toobusy.mockReturnValue(true);
    const req = { headers: {} } as IncomingMessage;
    middleware(req, { writeHead, end }, () => {});
    expect(beforeThrottle).toHaveBeenCalledWith(qos, req, BadActorType.badHost);
    expect(writeHead).toHaveBeenCalled;
    expect(end).toHaveBeenCalled;
  });

  it('beforeThrottle invoked if badHost bad not blocked if returns false', () => {
    const beforeThrottle = jest.fn().mockReturnValue(false) as BeforeThrottleFn;
    const qos = new ConnectQOS({ waitForHistory: false });
    const middleware = qos.getMiddleware({ beforeThrottle });
    expect(typeof middleware).toEqual('function');
    qos.metrics.badHosts.set('unknown', 1); // force it
    const writeHead = jest.fn();
    const end = jest.fn();
    toobusy.mockReturnValue(true);
    const req = { headers: {} } as IncomingMessage;
    middleware(req, { writeHead, end }, () => {});
    expect(beforeThrottle).toHaveBeenCalledWith(qos, req, BadActorType.badHost);
    expect(writeHead).not.toHaveBeenCalled;
    expect(end).not.toHaveBeenCalled;
  });
});

describe('isBadHost', () => {
  it('returns false if no bad hosts', () => {
    const qos = new ConnectQOS({ waitForHistory: false });
    expect(qos.isBadHost('unknown')).toEqual(false);
  });

  it('returns true if bad hosts', () => {
    const qos = new ConnectQOS({ waitForHistory: false });
    qos.metrics.badHosts.set('unknown', 1);
    expect(qos.isBadHost('unknown')).toEqual(true);
  });
});

describe('isBadIp', () => {
  it('returns false if no bad IPs', () => {
    const qos = new ConnectQOS({ waitForHistory: false });
    expect(qos.isBadIp('unknown')).toEqual(false);
  });

  it('returns true if bad IPs', () => {
    const qos = new ConnectQOS({ waitForHistory: false });
    qos.metrics.badIps.set('unknown', 1);
    expect(qos.isBadIp('unknown')).toEqual(true);
  });
});
