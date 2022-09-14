import { IncomingMessage } from 'http';
import { Http2ServerRequest } from 'http2';
import { Metrics, DEFAULT_HOST_WHITELIST, DEFAULT_IP_WHITELIST, REQUESTS_PER_PURGE } from '../src';
import { ActorStatus } from '../src/metrics';

global.Date.now = jest.fn();

beforeEach(() => {
  global.Date.now.mockReturnValue(0);
});

describe('constructor', () => {
  it('defaults', () => {
    const metrics = new Metrics();
    expect(metrics.historySize).toEqual(300);
    expect(metrics.maxAge).toEqual(1000 * 60 * 2);
    expect(metrics.minHostRequests).toEqual(30);
    expect(metrics.minIpRequests).toEqual(100);
    expect(metrics.maxHostRate).toEqual(0);
    expect(metrics.maxIpRate).toEqual(0);
    expect(Array.from(metrics.hostWhitelist)).toEqual(DEFAULT_HOST_WHITELIST);
    expect(Array.from(metrics.ipWhitelist)).toEqual(DEFAULT_IP_WHITELIST);
  });

  it('overrides', () => {
    const metrics = new Metrics({
      historySize: 400,
      maxAge: 1000 * 60 * 5,
      minHostRequests: 150,
      minIpRequests: 200,
      maxHostRate: 1,
      maxIpRate: 2,
      hostWhitelist: new Set(['h1', 'h2']),
      ipWhitelist: new Set(['i1', 'i2'])
    });
    expect(metrics.historySize).toEqual(400);
    expect(metrics.maxAge).toEqual(1000 * 60 * 5);
    expect(metrics.minHostRequests).toEqual(150);
    expect(metrics.minIpRequests).toEqual(200);
    expect(metrics.maxHostRate).toEqual(1);
    expect(metrics.maxIpRate).toEqual(2);
    expect(Array.from(metrics.hostWhitelist)).toEqual(['h1', 'h2']);
    expect(Array.from(metrics.ipWhitelist)).toEqual(['i1', 'i2']);
  });

  it('throws if minHostRequests exceeds historySize', () => {
    expect(() => new Metrics({ minHostRequests: 1000 })).toThrow();
  });

  it('throws if minIpRequests exceeds historySize', () => {
    expect(() => new Metrics({ minIpRequests: 1000 })).toThrow();
  });
});

describe('trackRequest', () => {
  it('http.headers.host is valid', () => {
    const metrics = new Metrics();
    metrics.trackRequest({
      headers: { 'host': 'a' }
    } as IncomingMessage);
    expect(metrics.hosts.get('a')).toEqual({ history: [0], hits: 1, rate: 0, ratio: 0 });
    expect(metrics.ips.get('unknown')).toEqual({ history: [0], hits: 1, rate: 0, ratio: 0 });
  });

  it('http2.headers.:authority is valid', () => {
    const metrics = new Metrics();
    metrics.trackRequest({
      headers: { ':authority': 'b' }
    } as Http2ServerRequest);
    expect(metrics.hosts.get('b')).toEqual({ history: [0], hits: 1, rate: 0, ratio: 0 });
    expect(metrics.ips.get('unknown')).toEqual({ history: [0], hits: 1, rate: 0, ratio: 0 });
  });

  it('http.headers.x-forwarded-for is valid', () => {
    const metrics = new Metrics();
    /* @ts-ignore */
    metrics.trackRequest({
      headers: { },
      socket: { remoteAddress: 'c' }
    } as IncomingMessage);
    expect(metrics.hosts.get('unknown')).toEqual({ history: [0], hits: 1, rate: 0, ratio: 0 });
    expect(metrics.ips.get('c')).toEqual({ history: [0], hits: 1, rate: 0, ratio: 0 });
  });

  it('socket.remoteAddress is valid', () => {
    const metrics = new Metrics();
    /* @ts-ignore */
    metrics.trackRequest({
      headers: {},
      socket: { remoteAddress: 'd' }
    } as IncomingMessage);
    expect(metrics.hosts.get('unknown')).toEqual({ history: [0], hits: 1, rate: 0, ratio: 0 });
    expect(metrics.ips.get('d')).toEqual({ history: [0], hits: 1, rate: 0, ratio: 0 });
  });
});

describe('LRU', () => {
  it('invokes dispose to reset hostRequests', () => {
    const metrics = new Metrics();
    /* @ts-ignore */
    metrics.trackRequest({
      headers: { host: 'a' }
    } as IncomingMessage);
    expect(metrics.hostRequests).toEqual(1);
    metrics.hosts.clear();
    expect(metrics.hostRequests).toEqual(0);
  });

  it('invokes dispose to reset ipRequests', () => {
    const metrics = new Metrics();
    /* @ts-ignore */
    metrics.trackRequest({
      headers: {},
      socket: { remoteAddress: 'a' }
    } as IncomingMessage);
    expect(metrics.ipRequests).toEqual(1);
    metrics.ips.clear();
    expect(metrics.ipRequests).toEqual(0);
  });
});

describe('getHostInfo', () => {
  it('returns whitelisted if min set to false', () => {
    const metrics = new Metrics({ minHostRequests: false });
    /* @ts-ignore */
    const req = {
      headers: { ':authority': 'a' }
    } as IncomingMessage;
    expect(metrics.getHostInfo(req, false)).toEqual(ActorStatus.Whitelisted); // whitelisted
    expect(metrics.getHostInfo(req, true)).toEqual(ActorStatus.Whitelisted); // whitelisted
  });

  it('returns whitelisted if in list', () => {
    const metrics = new Metrics({ hostWhitelist: new Set(['a']) });
    /* @ts-ignore */
    const req = {
      headers: { ':authority': 'a' }
    } as IncomingMessage;
    expect(metrics.getHostInfo(req, true)).toEqual(ActorStatus.Whitelisted); // whitelisted
    req.headers[':authority'] = 'b';
    expect(metrics.getHostInfo(req, true)?.ratio).toEqual(0);
  });

  it(':authority respected', () => {
    const metrics = new Metrics({ minHostRequests: 2 });
    /* @ts-ignore */
    const req = {
      headers: { ':authority': 'a' }
    } as IncomingMessage;
    metrics.getHostInfo(req, true);
    expect(metrics.getHostInfo(req, false)?.ratio).toEqual(0); // insufficient history
    metrics.getHostInfo(req, true);
    expect(metrics.getHostInfo(req, false)?.ratio).toEqual(1); // sufficient history
    expect(metrics.getHostInfo('a', false)?.ratio).toEqual(1); // by name also matches
  });

  it('purge after REQUESTS_PER_PURGE', () => {
    const metrics = new Metrics({ maxAge: 1000 });
    const half = Math.floor(REQUESTS_PER_PURGE/2);
    for (let i = 0; i < half; i++) {
      /* @ts-ignore */
      metrics.trackRequest({
        headers: { host: 'a' }
      } as IncomingMessage);
    }
    expect(metrics.hostRequests).toEqual(half);
    expect(metrics.getHostInfo('a', false)?.ratio).toEqual(1);
    global.Date.now.mockReturnValue(2000);
    for (let i = 0; i < half; i++) {
      /* @ts-ignore */
      metrics.trackRequest({
        headers: { host: 'b' }
      } as IncomingMessage);
    }
    expect(metrics.hostRequests).toEqual(half);
    expect(metrics.hosts.get('a')).toEqual(undefined);
    expect(metrics.getHostInfo('a', false)).toEqual(undefined); // they all expired
    expect(metrics.getHostInfo('b', false)?.ratio).toEqual(1);
  });
});

describe('getIpInfo', () => {
  it('returns whitelisted if min set to false', () => {
    const metrics = new Metrics({ minIpRequests: false });
    /* @ts-ignore */
    const req = {
      headers: { },
      socket: { remoteAddress: 'a' }
    } as IncomingMessage;
    expect(metrics.getIpInfo(req, false)).toEqual(ActorStatus.Whitelisted); // whitelisted
    expect(metrics.getIpInfo(req, true)).toEqual(ActorStatus.Whitelisted); // whitelisted
  });

  it('returns whitelisted if in list', () => {
    const metrics = new Metrics({ ipWhitelist: new Set(['a']) });
    /* @ts-ignore */
    const req = {
      headers: { },
      socket: { remoteAddress: 'a' }
    } as IncomingMessage;
    expect(metrics.getIpInfo(req, true)).toEqual(ActorStatus.Whitelisted); // whitelisted
    req.socket.remoteAddress = 'b';
    expect(metrics.getIpInfo(req, true)?.ratio).toEqual(0);
  });

  it('x-forwarded-for respected', () => {
    const metrics = new Metrics({ minIpRequests: 2, behindProxy: true });
    /* @ts-ignore */
    const req = {
      headers: { 'x-forwarded-for': 'a' }
    } as IncomingMessage;
    metrics.getIpInfo(req, true);
    expect(metrics.getIpInfo(req, false)?.ratio).toEqual(0); // insufficient history
    metrics.getIpInfo(req, true);
    expect(metrics.getIpInfo(req, false)?.ratio).toEqual(1); // sufficient history
    expect(metrics.getIpInfo('a', false)?.ratio).toEqual(1); // by name also matches
  });

  it('purge after REQUESTS_PER_PURGE', () => {
    const metrics = new Metrics({ maxAge: 1000 });
    const half = Math.floor(REQUESTS_PER_PURGE/2);
    for (let i = 0; i < half; i++) {
      /* @ts-ignore */
      metrics.trackRequest({
        headers: { },
        socket: { remoteAddress: 'a' }
      } as IncomingMessage);
    }
    expect(metrics.ipRequests).toEqual(half);
    expect(metrics.getIpInfo('a', false)?.ratio).toEqual(1);
    global.Date.now.mockReturnValue(2000);
    for (let i = 0; i < half; i++) {
      /* @ts-ignore */
      metrics.trackRequest({
        headers: { },
        socket: { remoteAddress: 'b' }
      } as IncomingMessage);
    }
    expect(metrics.ipRequests).toEqual(half);
    expect(metrics.ips.get('a')).toEqual(undefined);
    expect(metrics.getIpInfo('a', false)).toEqual(undefined); // they all expired
    expect(metrics.getIpInfo('b', false)?.ratio).toEqual(1);
  });
});
