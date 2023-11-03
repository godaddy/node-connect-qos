import {
  Metrics,
  DEFAULT_HOST_WHITELIST, DEFAULT_IP_WHITELIST,
  DEFAULT_MIN_HOST_RATE,DEFAULT_MAX_HOST_RATE,
  DEFAULT_MIN_IP_RATE,DEFAULT_MAX_IP_RATE
} from '../src';
import { ActorStatus } from '../src/metrics';

global.Date.now = jest.fn();

beforeEach(() => {
  global.Date.now.mockReturnValue(0);
});

describe('constructor', () => {
  it('defaults', () => {
    const metrics = new Metrics();
    expect(metrics.historySize).toEqual(200);
    expect(metrics.maxAge).toEqual(1000 * 10);
    expect(metrics.minHostRate).toEqual(DEFAULT_MIN_HOST_RATE);
    expect(metrics.maxHostRate).toEqual(DEFAULT_MAX_HOST_RATE);
    expect(metrics.minIpRate).toEqual(DEFAULT_MIN_IP_RATE);
    expect(metrics.maxIpRate).toEqual(DEFAULT_MAX_IP_RATE);
    expect(Array.from(metrics.hostWhitelist)).toEqual(DEFAULT_HOST_WHITELIST);
    expect(Array.from(metrics.ipWhitelist)).toEqual(DEFAULT_IP_WHITELIST);
  });

  it('overrides', () => {
    const metrics = new Metrics({
      historySize: 400,
      maxAge: 1000 * 60 * 5,
      minHostRate: 150,
      maxHostRate: 200,
      minIpRate: 50,
      maxIpRate: 100,
      hostWhitelist: new Set(['h1', 'h2']),
      ipWhitelist: new Set(['i1', 'i2'])
    });
    expect(metrics.historySize).toEqual(400);
    expect(metrics.maxAge).toEqual(1000 * 60 * 5);
    expect(metrics.minHostRate).toEqual(150);
    expect(metrics.maxHostRate).toEqual(200);
    expect(metrics.minIpRate).toEqual(50);
    expect(metrics.maxIpRate).toEqual(100);
    expect(Array.from(metrics.hostWhitelist)).toEqual(['h1', 'h2']);
    expect(Array.from(metrics.ipWhitelist)).toEqual(['i1', 'i2']);
  });

  it('throws if minHostRate exceeds maxHostRate', () => {
    expect(() => new Metrics({ minHostRate: 2, maxHostRate: 1 })).toThrow();
  });

  it('throws if minIpRate exceeds maxIpRate', () => {
    expect(() => new Metrics({ minIpRate: 2, maxIpRate: 1 })).toThrow();
  });
});

describe('props', () => {
  it('do NOT cache host if rate limiting disabled', () => {
    const metrics = new Metrics({ minHostRate: 0 });
    expect(metrics.hosts.get('a')).toEqual(undefined);
    metrics.trackHost('a');
    expect(metrics.hosts.get('a')).toEqual(undefined);
  });

  it('cache host if rate limiting', () => {
    const metrics = new Metrics({ minHostRate: 1, maxHostRate: 1 });
    expect(metrics.hosts.get('a')).toEqual(undefined);
    metrics.trackHost('a');
    expect(typeof metrics.hosts.get('a')).toEqual('object');
  });

  it('do NOT cache IP if rate limiting disabled', () => {
    const metrics = new Metrics({ minIpRate: 0 });
    expect(metrics.ips.get('a')).toEqual(undefined);
    metrics.trackIp('a');
    expect(metrics.ips.get('a')).toEqual(undefined);
  });

  it('cache IP if rate limiting', () => {
    const metrics = new Metrics({ minIpRate: 1, maxIpRate: 1 });
    expect(metrics.ips.get('a')).toEqual(undefined);
    metrics.trackIp('a');
    expect(typeof metrics.ips.get('a')).toEqual('object');
  });
});

describe('getHostInfo', () => {
  it('returns Good if rate limiting disabled', () => {
    const metrics = new Metrics({ minHostRate: 0 });
    metrics.trackHost('a');
    metrics.trackHost('a');
    metrics.trackHost('a');
    expect(metrics.getHostInfo('a')).toEqual(ActorStatus.Good);
  });

  it('returns whitelisted if in list', () => {
    const metrics = new Metrics({ hostWhitelist: new Set(['a']), minHostRate: 1, maxHostRate: 1 });
    metrics.trackHost('a'); // would not normally be tracked if whitelisted, but no affect
    expect(metrics.getHostInfo('a')).toEqual(ActorStatus.Whitelisted); // no history required
    metrics.trackHost('b');
    expect(typeof metrics.getHostInfo('b')).toEqual('object');
  });

  it('rate measured over time', () => {
    const maxAge = 1000;
    const minHostRate = 2;
    const metrics = new Metrics({ maxAge, minHostRate, maxHostRate: minHostRate });
    expect(metrics.getHostInfo('a')).toEqual(undefined);
    metrics.trackHost('a');
    expect(metrics.getHostInfo('a')?.rate).toEqual(0); // does not min
    for (let i = 1; i <= 10; i++) {
      const elapsed = i * 100;
      global.Date.now.mockReturnValue(elapsed);
      metrics.trackHost('a');
      expect(metrics.getHostInfo('a')?.rate).toEqual(((i+1) / elapsed) * 1000);
    }
  });

  it('purge anything stale prior to getInfo', () => {
    const maxAge = 1000;
    const minHostRate = 10;
    const metrics = new Metrics({ maxAge, minHostRate, maxHostRate: minHostRate });
    let i;
    for (i = 0; i < minHostRate; i++) {
      metrics.trackHost('a');
    }
    expect(metrics.getHostInfo('a')?.history.length).toEqual(minHostRate); // nothing dropped
    expect(metrics.getHostInfo('a')?.rate).toEqual(10000); // no time has passed, so 1ms minimum assumed = 10K RPS
    global.Date.now.mockReturnValue(maxAge+1);
    expect(metrics.getHostInfo('a')?.history.length).toEqual(0); // everything is stale
    expect(metrics.getHostInfo('a')?.rate).toEqual(0); // insufficient history
  });
});

describe('getIpInfo', () => {
  it('returns Good if rate limiting disabled', () => {
    const metrics = new Metrics({ minIpRate: 0 });
    metrics.trackIp('a');
    metrics.trackIp('a');
    metrics.trackIp('a');
    expect(metrics.getIpInfo('a')).toEqual(ActorStatus.Good);
  });

  it('returns whitelisted if in list', () => {
    const metrics = new Metrics({ ipWhitelist: new Set(['a']), minIpRate: 1, maxIpRate: 1 });
    metrics.trackIp('a'); // would not normally be tracked if whitelisted, but no affect
    expect(metrics.getIpInfo('a')).toEqual(ActorStatus.Whitelisted); // no history required
    metrics.trackIp('b');
    expect(typeof metrics.getIpInfo('b')).toEqual('object');
  });

  it('rate measured over time', () => {
    const maxAge = 1000;
    const minIpRate = 2;
    const metrics = new Metrics({ maxAge, minIpRate, maxIpRate: minIpRate });
    expect(metrics.getIpInfo('a')).toEqual(undefined);
    metrics.trackIp('a');
    expect(metrics.getIpInfo('a')?.rate).toEqual(0); // does not min
    for (let i = 1; i <= 10; i++) {
      const elapsed = i * 100;
      global.Date.now.mockReturnValue(elapsed);
      metrics.trackIp('a');
      expect(metrics.getIpInfo('a')?.rate).toEqual(((i+1) / elapsed) * 1000);
    }
  });

  it('purge anything stale prior to getInfo', () => {
    const maxAge = 1000;
    const minIpRate = 10;
    const metrics = new Metrics({ maxAge, minIpRate, maxIpRate: minIpRate });
    let i;
    for (i = 0; i < minIpRate; i++) {
      metrics.trackIp('a');
    }
    expect(metrics.getIpInfo('a')?.history.length).toEqual(minIpRate); // nothing dropped
    expect(metrics.getIpInfo('a')?.rate).toEqual(10000); // no time has passed, so 1ms minimum assumed = 10K RPS
    global.Date.now.mockReturnValue(maxAge+1);
    expect(metrics.getIpInfo('a')?.history.length).toEqual(0); // everything is stale
    expect(metrics.getIpInfo('a')?.rate).toEqual(0); // insufficient history
  });
});

describe('maxHostRatio', () => {
  it('by default is disabled', () => {
    const metrics = new Metrics();
    expect(metrics.maxHostRatio).toEqual(0);
  });

  it('can be set', () => {
    const metrics = new Metrics({ maxHostRatio: 0.5 });
    expect(metrics.maxHostRatio).toEqual(0.5);
  });

  it('if set to 10% but not enough history, no violations', () => {
    const metrics = new Metrics({ maxHostRatio: 0.1 });
    Array.from({ length: 10 }, () => metrics.trackHost('a'));
    // despite all requests hitting host 'a', there's not enough history to determine if it's a bad actor
    expect([...metrics.hostRatioViolations.values()]).toEqual([]);
  });

  it('if set to 10% but not enough history, no violations', () => {
    const metrics = new Metrics({ maxHostRatio: 0.1 });
    const requiredHits = Math.ceil(metrics.maxHostRatio * 100 * 10); // 10x host ratio required before reporting violations
    Array.from({ length: requiredHits }, () => metrics.trackHost('a'));
    // despite all requests hitting host 'a', there's not enough history to determine if it's a bad actor
    expect([...metrics.hostRatioViolations.values()]).toEqual(['a']);
  });

  it('if set to 50%, only hosts 50% or greater will be reported for violations', () => {
    const metrics = new Metrics({ maxHostRatio: 0.5 });
    const requiredHits = Math.ceil(metrics.maxHostRatio * 100 * 10); // 10x host ratio required before reporting violations
    Array.from({ length: Math.round(requiredHits * 0.4) }, () => metrics.trackHost('a')); // 40% to 'a'
    Array.from({ length: Math.round(requiredHits * 0.6) }, () => metrics.trackHost('b')); // 60% to 'b'
    expect([...metrics.hostRatioViolations.values()]).toEqual(['b']);
  });
});