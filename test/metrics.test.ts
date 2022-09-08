import { IncomingMessage } from 'http';
import { Http2ServerRequest } from 'http2';
import { Metrics, DEFAULT_HOST_WHITELIST, DEFAULT_IP_WHITELIST, REQUESTS_PER_PURGE } from '../src';

global.Date.now = jest.fn();

beforeEach(() => {
  global.Date.now.mockReturnValue(0);
});

describe('constructor', () => {
  it('defaults', () => {
    const metrics = new Metrics();
    expect(metrics.historySize).toEqual(500);
    expect(metrics.maxAge).toEqual(1000 * 60 * 10);
    expect(metrics.minHostRequests).toEqual(50);
    expect(metrics.minIpRequests).toEqual(100);
    expect(Array.from(metrics.hostWhitelist)).toEqual(DEFAULT_HOST_WHITELIST);
    expect(Array.from(metrics.ipWhitelist)).toEqual(DEFAULT_IP_WHITELIST);
  });

  it('overrides', () => {
    const metrics = new Metrics({
      historySize: 400,
      maxAge: 1000 * 60 * 5,
      minHostRequests: 150,
      minIpRequests: 200,
      hostWhitelist: new Set(['h1', 'h2']),
      ipWhitelist: new Set(['i1', 'i2'])
    });
    expect(metrics.historySize).toEqual(400);
    expect(metrics.maxAge).toEqual(1000 * 60 * 5);
    expect(metrics.minHostRequests).toEqual(150);
    expect(metrics.minIpRequests).toEqual(200);
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
    expect(metrics.hosts.get('a')).toEqual({ history: [0], hits: 1 });
    expect(metrics.ips.get('unknown')).toEqual({ history: [0], hits: 1 });
  });

  it('http2.headers.:authority is valid', () => {
    const metrics = new Metrics();
    metrics.trackRequest({
      headers: { ':authority': 'b' }
    } as Http2ServerRequest);
    expect(metrics.hosts.get('b')).toEqual({ history: [0], hits: 1 });
    expect(metrics.ips.get('unknown')).toEqual({ history: [0], hits: 1 });
  });

  it('http.headers.x-forwarded-for is valid', () => {
    const metrics = new Metrics();
    /* @ts-ignore */
    metrics.trackRequest({
      headers: { },
      socket: { remoteAddress: 'c' }
    } as IncomingMessage);
    expect(metrics.hosts.get('unknown')).toEqual({ history: [0], hits: 1 });
    expect(metrics.ips.get('c')).toEqual({ history: [0], hits: 1 });
  });

  it('socket.remoteAddress is valid', () => {
    const metrics = new Metrics();
    /* @ts-ignore */
    metrics.trackRequest({
      headers: {},
      socket: { remoteAddress: 'd' }
    } as IncomingMessage);
    expect(metrics.hosts.get('unknown')).toEqual({ history: [0], hits: 1 });
    expect(metrics.ips.get('d')).toEqual({ history: [0], hits: 1 });
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

describe('getHostRatio', () => {
  it('returns whitelisted if min set to false', () => {
    const metrics = new Metrics({ minHostRequests: false });
    /* @ts-ignore */
    const req = {
      headers: { ':authority': 'a' }
    } as IncomingMessage;
    expect(metrics.getHostRatio(req, false)).toEqual(-1); // whitelisted
    expect(metrics.getHostRatio(req, true)).toEqual(-1); // whitelisted
  });

  it('returns whitelisted if in list', () => {
    const metrics = new Metrics({ hostWhitelist: new Set(['a']) });
    /* @ts-ignore */
    const req = {
      headers: { ':authority': 'a' }
    } as IncomingMessage;
    expect(metrics.getHostRatio(req, true)).toEqual(-1); // whitelisted
    req.headers[':authority'] = 'b';
    expect(metrics.getHostRatio(req, true)).toEqual(0); // whitelisted
  });

  it(':authority respected', () => {
    const metrics = new Metrics({ minHostRequests: 2 });
    /* @ts-ignore */
    const req = {
      headers: { ':authority': 'a' }
    } as IncomingMessage;
    metrics.getHostRatio(req, true);
    expect(metrics.getHostRatio(req, false)).toEqual(0); // insufficient history
    metrics.getHostRatio(req, true);
    expect(metrics.getHostRatio(req, false)).toEqual(1); // sufficient history
    expect(metrics.getHostRatio('a', false)).toEqual(1); // by name also matches
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
    expect(metrics.getHostRatio('a', false)).toEqual(1);
    global.Date.now.mockReturnValue(2000);
    for (let i = 0; i < half; i++) {
      /* @ts-ignore */
      metrics.trackRequest({
        headers: { host: 'b' }
      } as IncomingMessage);
    }
    expect(metrics.hostRequests).toEqual(half);
    expect(metrics.hosts.get('a')).toEqual(undefined);
    expect(metrics.getHostRatio('a', false)).toEqual(0); // they all expired
    expect(metrics.getHostRatio('b', false)).toEqual(1);
  });
});

describe('getIpRatio', () => {
  it('returns whitelisted if min set to false', () => {
    const metrics = new Metrics({ minIpRequests: false });
    /* @ts-ignore */
    const req = {
      headers: { },
      socket: { remoteAddress: 'a' }
    } as IncomingMessage;
    expect(metrics.getIpRatio(req, false)).toEqual(-1); // whitelisted
    expect(metrics.getIpRatio(req, true)).toEqual(-1); // whitelisted
  });

  it('returns whitelisted if in list', () => {
    const metrics = new Metrics({ ipWhitelist: new Set(['a']) });
    /* @ts-ignore */
    const req = {
      headers: { },
      socket: { remoteAddress: 'a' }
    } as IncomingMessage;
    expect(metrics.getIpRatio(req, true)).toEqual(-1); // whitelisted
    req.socket.remoteAddress = 'b';
    expect(metrics.getIpRatio(req, true)).toEqual(0); // whitelisted
  });

  it('x-forwarded-for respected', () => {
    const metrics = new Metrics({ minIpRequests: 2, behindProxy: true });
    /* @ts-ignore */
    const req = {
      headers: { 'x-forwarded-for': 'a' }
    } as IncomingMessage;
    metrics.getIpRatio(req, true);
    expect(metrics.getIpRatio(req, false)).toEqual(0); // insufficient history
    metrics.getIpRatio(req, true);
    expect(metrics.getIpRatio(req, false)).toEqual(1); // sufficient history
    expect(metrics.getIpRatio('a', false)).toEqual(1); // by name also matches
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
    expect(metrics.getIpRatio('a', false)).toEqual(1);
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
    expect(metrics.getIpRatio('a', false)).toEqual(0); // they all expired
    expect(metrics.getIpRatio('b', false)).toEqual(1);
  });
});
