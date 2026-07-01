import { ClusterSync, ClusterSyncOptions } from '../src/cluster';

function createMockRedis() {
  const pipeline = {
    zincrby: jest.fn().mockReturnThis(),
    zrangebyscore: jest.fn().mockReturnThis(),
    zremrangebyrank: jest.fn().mockReturnThis(),
    incrby: jest.fn().mockReturnThis(),
    get: jest.fn().mockReturnThis(),
    unlink: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  };
  return {
    pipeline: jest.fn().mockReturnValue(pipeline),
    _pipeline: pipeline,
  };
}

describe('ClusterSync', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('constructor and lifecycle', () => {
    it('creates instance with required options', () => {
      const redis = createMockRedis();
      const sync = new ClusterSync({
        redis: { client: redis as any },
        windowMs: 10000,
        syncIntervalMs: 2000,
        clusterMaxIpRate: 100,
        clusterMaxSubnetRate: 400,
      });
      expect(sync).toBeInstanceOf(ClusterSync);
      sync.stop();
    });

    it('start() begins the sync interval', () => {
      const redis = createMockRedis();
      const sync = new ClusterSync({
        redis: { client: redis as any },
        windowMs: 10000,
        syncIntervalMs: 2000,
        clusterMaxIpRate: 100,
      });
      sync.start();
      expect(sync.isRunning).toBe(true);
      sync.stop();
    });

    it('stop() clears the sync interval', () => {
      const redis = createMockRedis();
      const sync = new ClusterSync({
        redis: { client: redis as any },
        windowMs: 10000,
        syncIntervalMs: 2000,
        clusterMaxIpRate: 100,
      });
      sync.start();
      sync.stop();
      expect(sync.isRunning).toBe(false);
    });

    it('stop() is idempotent', () => {
      const redis = createMockRedis();
      const sync = new ClusterSync({
        redis: { client: redis as any },
        windowMs: 10000,
        syncIntervalMs: 2000,
        clusterMaxIpRate: 100,
      });
      sync.start();
      sync.stop();
      sync.stop();
      expect(sync.isRunning).toBe(false);
    });
  });

  describe('delta accumulation', () => {
    it('recordHit accumulates deltas by type and key', () => {
      const redis = createMockRedis();
      const sync = new ClusterSync({
        redis: { client: redis as any },
        windowMs: 10000,
        syncIntervalMs: 2000,
        clusterMaxIpRate: 100,
      });
      sync.recordHit('ip', '1.2.3.4');
      sync.recordHit('ip', '1.2.3.4');
      sync.recordHit('ip', '5.6.7.8');
      sync.recordHit('subnet', '1.2.3.0');
      sync.recordHit('host', 'example.com');

      const ipDeltas = sync.getAndResetDeltas('ip');
      expect(ipDeltas.get('1.2.3.4')).toBe(2);
      expect(ipDeltas.get('5.6.7.8')).toBe(1);

      const subnetDeltas = sync.getAndResetDeltas('subnet');
      expect(subnetDeltas.get('1.2.3.0')).toBe(1);

      const hostDeltas = sync.getAndResetDeltas('host');
      expect(hostDeltas.get('example.com')).toBe(1);
    });

    it('getAndResetDeltas clears accumulated deltas', () => {
      const redis = createMockRedis();
      const sync = new ClusterSync({
        redis: { client: redis as any },
        windowMs: 10000,
        syncIntervalMs: 2000,
        clusterMaxIpRate: 100,
      });
      sync.recordHit('ip', '1.2.3.4');
      sync.getAndResetDeltas('ip');

      const deltas = sync.getAndResetDeltas('ip');
      expect(deltas.size).toBe(0);
    });

    it('recordHit respects maxTrackedActors cap', () => {
      const redis = createMockRedis();
      const sync = new ClusterSync({
        redis: { client: redis as any },
        windowMs: 10000,
        syncIntervalMs: 2000,
        clusterMaxIpRate: 100,
        maxTrackedActors: 3,
      });
      sync.recordHit('ip', '1.1.1.1');
      sync.recordHit('ip', '2.2.2.2');
      sync.recordHit('ip', '3.3.3.3');
      sync.recordHit('ip', '4.4.4.4'); // should be dropped

      const deltas = sync.getAndResetDeltas('ip');
      expect(deltas.size).toBe(3);
      expect(deltas.has('4.4.4.4')).toBe(false);
    });
  });

  describe('blocklist queries', () => {
    it('isBlocked returns false initially', () => {
      const redis = createMockRedis();
      const sync = new ClusterSync({
        redis: { client: redis as any },
        windowMs: 10000,
        syncIntervalMs: 2000,
        clusterMaxIpRate: 100,
      });
      expect(sync.isBlocked('ip', '1.2.3.4')).toBe(false);
    });

    it('isHostViolation returns false initially', () => {
      const redis = createMockRedis();
      const sync = new ClusterSync({
        redis: { client: redis as any },
        windowMs: 10000,
        syncIntervalMs: 2000,
        clusterMaxHostRatio: 0.15,
      });
      expect(sync.isHostViolation('example.com')).toBe(false);
    });
  });
});
