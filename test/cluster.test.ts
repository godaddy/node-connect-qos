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

  describe('sync cycle', () => {
    it('publishDeltas sends ZINCRBY commands for accumulated IPs', async () => {
      const redis = createMockRedis();
      redis._pipeline.exec.mockResolvedValue([]);
      const sync = new ClusterSync({
        redis: { client: redis as any, keyPrefix: 'qos:' },
        windowMs: 10000,
        syncIntervalMs: 2000,
        clusterMaxIpRate: 100,
      });

      sync.recordHit('ip', '1.2.3.4');
      sync.recordHit('ip', '1.2.3.4');
      sync.recordHit('ip', '5.6.7.8');

      await sync.sync();

      expect(redis.pipeline).toHaveBeenCalled();
      expect(redis._pipeline.zincrby).toHaveBeenCalledWith(
        expect.stringMatching(/^qos:ip:w\d+$/),
        2,
        '1.2.3.4'
      );
      expect(redis._pipeline.zincrby).toHaveBeenCalledWith(
        expect.stringMatching(/^qos:ip:w\d+$/),
        1,
        '5.6.7.8'
      );
      expect(redis._pipeline.exec).toHaveBeenCalled();
    });

    it('readThresholds populates blockedIps from ZRANGEBYSCORE results', async () => {
      // Pin time to a window boundary (offset = 0, prevWeight = 1.0) so the
      // sliding window weight is deterministic.
      jest.setSystemTime(new Date(10000 * 100)); // exactly at window boundary

      const redis = createMockRedis();
      // threshold = 50 req/s * 10s = 500 hits. Scores of 600 exceed threshold in both windows.
      // WITHSCORES format: [member, score, member, score, ...]
      redis._pipeline.exec.mockResolvedValueOnce([]) // publish
        .mockResolvedValueOnce([ // read
          [null, ['1.2.3.4', '600', '5.6.7.8', '600']], // current window IPs with scores
          [null, ['9.10.11.12', '600']],                 // prev window IPs with scores
        ]);
      const sync = new ClusterSync({
        redis: { client: redis as any },
        windowMs: 10000,
        syncIntervalMs: 2000,
        clusterMaxIpRate: 50,
      });

      sync.recordHit('ip', 'dummy');
      sync.start();
      await sync.sync();
      sync.stop();

      expect(sync.isBlocked('ip', '1.2.3.4')).toBe(true);
      expect(sync.isBlocked('ip', '5.6.7.8')).toBe(true);
      expect(sync.isBlocked('ip', '9.10.11.12')).toBe(true);
      expect(sync.isBlocked('ip', '99.99.99.99')).toBe(false);
    });

    it('host ratio violation detected when host exceeds clusterMaxHostRatio', async () => {
      const redis = createMockRedis();
      // Simulate: total = 1000, host 'attack.com' = 200 (20% > 15% threshold)
      redis._pipeline.exec.mockResolvedValueOnce([]) // publish
        .mockResolvedValueOnce([ // read
          [null, '1000'],                               // current total
          [null, '0'],                                  // prev total
          [null, ['attack.com', '200', 'good.com', '50']], // current hosts WITHSCORES
          [null, []],                                   // prev hosts WITHSCORES
        ]);
      const sync = new ClusterSync({
        redis: { client: redis as any },
        windowMs: 10000,
        syncIntervalMs: 2000,
        clusterMaxHostRatio: 0.15,
      });

      sync.recordHit('host', 'attack.com');
      sync.start();
      await sync.sync();
      sync.stop();

      expect(sync.isHostViolation('attack.com')).toBe(true);
      expect(sync.isHostViolation('good.com')).toBe(false);
    });

    it('onError is called and deltas are retried when Redis pipeline throws', async () => {
      const redis = createMockRedis();
      const error = new Error('Redis connection lost');
      redis._pipeline.exec.mockRejectedValue(error);
      const onError = jest.fn();
      const sync = new ClusterSync({
        redis: { client: redis as any },
        windowMs: 10000,
        syncIntervalMs: 2000,
        clusterMaxIpRate: 100,
        onError,
      });

      sync.recordHit('ip', '1.2.3.4');
      sync.recordHit('ip', '1.2.3.4');
      await sync.sync();

      expect(onError).toHaveBeenCalledWith(error);
      // Deltas should be merged back for retry on next cycle
      const retryDeltas = sync.getAndResetDeltas('ip');
      expect(retryDeltas.get('1.2.3.4')).toBe(2);
    });

    it('onSync is called with stats after successful sync', async () => {
      const redis = createMockRedis();
      redis._pipeline.exec.mockResolvedValue([]);
      const onSync = jest.fn();
      const sync = new ClusterSync({
        redis: { client: redis as any },
        windowMs: 10000,
        syncIntervalMs: 2000,
        clusterMaxIpRate: 100,
        onSync,
      });

      sync.recordHit('ip', '1.2.3.4');
      sync.start();
      await sync.sync();
      sync.stop();

      expect(onSync).toHaveBeenCalledWith(expect.objectContaining({
        publishedDeltas: { ip: 1, subnet: 0, host: 0 },
        blockedIps: 0,
        blockedSubnets: 0,
        hostViolations: 0,
      }));
      expect(onSync.mock.calls[0][0].syncDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('does not publish if no deltas accumulated', async () => {
      const redis = createMockRedis();
      const sync = new ClusterSync({
        redis: { client: redis as any },
        windowMs: 10000,
        syncIntervalMs: 2000,
        clusterMaxIpRate: 100,
      });

      await sync.sync();

      expect(redis._pipeline.zincrby).not.toHaveBeenCalled();
    });

    it('cleanup removes stale window keys via UNLINK', async () => {
      const redis = createMockRedis();
      redis._pipeline.exec.mockResolvedValue([]);
      const sync = new ClusterSync({
        redis: { client: redis as any, keyPrefix: 'qos:' },
        windowMs: 10000,
        syncIntervalMs: 2000,
        clusterMaxIpRate: 100,
      });

      sync.recordHit('ip', '1.2.3.4');
      sync.start();
      await sync.sync();
      sync.stop();

      expect(redis._pipeline.unlink).toHaveBeenCalled();
    });
  });

  describe('cardinality cap', () => {
    it('trims sorted sets to maxTrackedActors after publish', async () => {
      const redis = createMockRedis();
      redis._pipeline.exec.mockResolvedValue([]);
      const sync = new ClusterSync({
        redis: { client: redis as any, keyPrefix: 'qos:' },
        windowMs: 10000,
        syncIntervalMs: 2000,
        clusterMaxIpRate: 100,
        maxTrackedActors: 1000,
      });

      sync.recordHit('ip', '1.2.3.4');
      await sync.sync();

      // ZREMRANGEBYRANK should be called to trim lowest-scoring members
      // keeping only top maxTrackedActors entries
      expect(redis._pipeline.zremrangebyrank).toHaveBeenCalledWith(
        expect.stringMatching(/^qos:ip:w\d+$/),
        0,
        -1001 // removes all but top 1000
      );
    });
  });
});
