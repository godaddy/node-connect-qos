import { IncomingMessage } from 'http';
import { Http2ServerRequest } from 'http2';
import { Metrics } from '../src';

describe('constructor', () => {
  it('defaults', () => {
    const metrics = new Metrics();
    expect(metrics.historySize).toEqual(1000);
    expect(metrics.isReady).toEqual(false);
    expect(metrics.hostBadActorSplit).toEqual(0.5);
    expect(metrics.ipBadActorSplit).toEqual(0.5);
    expect(Array.from(metrics.hostWhitelist)).toEqual([]);
    expect(Array.from(metrics.ipWhitelist)).toEqual([]);
  });

  it('overrides', () => {
    const metrics = new Metrics({
      historySize: 500,
      waitForHistory: false,
      hostBadActorSplit: 0.6,
      ipBadActorSplit: 0.4,
      hostWhitelist: new Set(['h1', 'h2']),
      ipWhitelist: new Set(['i1', 'i2'])
    });
    expect(metrics.historySize).toEqual(500);
    expect(metrics.isReady).toEqual(true);
    expect(metrics.hostBadActorSplit).toEqual(0.6);
    expect(metrics.ipBadActorSplit).toEqual(0.4);
    expect(Array.from(metrics.hostWhitelist)).toEqual(['h1', 'h2']);
    expect(Array.from(metrics.ipWhitelist)).toEqual(['i1', 'i2']);
  });
});

describe('trackRequest', () => {
  it('http.headers.host is valid', () => {
    const metrics = new Metrics();
    metrics.trackRequest({
      headers: { 'host': 'a' }
    } as IncomingMessage);
    expect(Array.from(metrics.hosts)).toEqual([['a', 1]]);
    expect(Array.from(metrics.ips)).toEqual([['unknown', 1]]);
  });

  it('http2.headers.:authority is valid', () => {
    const metrics = new Metrics();
    metrics.trackRequest({
      headers: { ':authority': 'b' }
    } as Http2ServerRequest);
    expect(Array.from(metrics.hosts)).toEqual([['b', 1]]);
    expect(Array.from(metrics.ips)).toEqual([['unknown', 1]]);
  });

  it('http.headers.x-forwarded-for is valid', () => {
    const metrics = new Metrics();
    /* @ts-ignore */
    metrics.trackRequest({
      headers: { 'x-forwarded-for': 'c' } 
    } as IncomingMessage);
    expect(Array.from(metrics.hosts)).toEqual([['unknown', 1]]);
    expect(Array.from(metrics.ips)).toEqual([['c', 1]]);
  });

  it('socket.remoteAddress is valid', () => {
    const metrics = new Metrics();
    /* @ts-ignore */
    metrics.trackRequest({
      headers: {},
      socket: { remoteAddress: 'd' }
    } as IncomingMessage);
    expect(Array.from(metrics.hosts)).toEqual([['unknown', 1]]);
    expect(Array.from(metrics.ips)).toEqual([['d', 1]]);
  });
});

describe('isBadActor', () => {
  it('return false on first usage', () => {
    const metrics = new Metrics();
    const req = {
      headers: { 'host': 'a' }
    } as IncomingMessage;
    metrics.trackRequest(req);
    expect(Array.from(metrics.hosts)).toEqual([['a', 1]]);
    expect(Array.from(metrics.ips)).toEqual([['unknown', 1]]);
    expect(metrics.isBadActor(req)).toEqual(false);
  });

  it('return `badHost` if bad host', () => {
    const metrics = new Metrics();
    const req = {
      headers: { 'host': 'a' }
    } as IncomingMessage;
    metrics.badHosts.set('a', 1);
    expect(metrics.isBadActor(req)).toEqual('badHost');
  });

  it('return `badIp` if bad IP', () => {
    const metrics = new Metrics();
    /* @ts-ignore */
    const req = {
      headers: { 'x-forwarded-for': 'c' }
    } as IncomingMessage;
    metrics.badIps.set('c', 1);
    expect(metrics.isBadActor(req)).toEqual('badIp');
  });
});

describe('identifyBadActors', () => {
  it('not invoked if insufficient history', () => {
    const metrics = new Metrics();
    const req = {
      headers: { 'host': 'a' }
    } as IncomingMessage;
    metrics.trackRequest(req);
    expect(Array.from(metrics.hosts)).toEqual([['a', 1]]);
    expect(Array.from(metrics.ips)).toEqual([['unknown', 1]]);
  });

  it('invoked if sufficient history', () => {
    const metrics = new Metrics({ historySize: 3 });
    expect(metrics.historySize).toEqual(3);
    const req = {
      headers: { 'host': 'a' }
    } as IncomingMessage;
    metrics.trackRequest(req);
    expect(metrics.history).toEqual(1);
    expect(metrics.badHosts.get('a')).toBeUndefined;
    expect(Array.from(metrics.hosts)).toEqual([['a', 1]]);
    metrics.trackRequest(req);
    expect(metrics.history).toEqual(2);
    expect(metrics.badHosts.get('a')).toBeUndefined;
    expect(Array.from(metrics.hosts)).toEqual([['a', 2]]);
    req.headers.host = 'b';
    metrics.trackRequest(req);
    expect(metrics.history).toEqual(0); // reset
    expect(metrics.badHosts.get('a')).toEqual(2);
    expect(Array.from(metrics.hosts)).toEqual([]);
  });
});
