/**
 * Integration test: requires a local Redis instance on localhost:6379.
 * Run with: REDIS_URL=redis://localhost:6379 npx jest test/integration.test.ts
 * Skip in CI if Redis is not available.
 */
import { ConnectQOS, BadActorType } from '../src';
import { IncomingMessage } from 'http';

const REDIS_URL = process.env.REDIS_URL;

const describeIfRedis = REDIS_URL ? describe : describe.skip;

describeIfRedis('cluster integration (requires Redis)', () => {
  let Redis: any;
  let redisClient: any;
  let redisReady = false;

  beforeAll(async () => {
    Redis = require('ioredis');
    redisClient = new Redis(REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 2000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null, // fail immediately instead of retrying
    });
    try {
      await redisClient.connect();
      redisReady = true;
    } catch {
      redisClient.disconnect();
      throw new Error(`Redis not reachable at ${REDIS_URL} — start Redis to run integration tests`);
    }
    // Clean up any leftover keys
    const keys = await redisClient.keys('qos:test:*');
    if (keys.length) await redisClient.del(...keys);
  }, 5000);

  afterAll(async () => {
    if (!redisReady || !redisClient) return;
    const keys = await redisClient.keys('qos:test:*');
    if (keys.length) await redisClient.del(...keys);
    await redisClient.quit().catch(() => {});
  });

  it('two nodes detect a distributed attacker via shared counts', async () => {
    const clusterConfig = {
      redis: { client: redisClient, keyPrefix: 'qos:test:' },
      syncIntervalMs: 500,
      clusterMaxIpRate: 25,
    };

    const node1 = new ConnectQOS({
      maxAge: 10000,
      minIpRate: 20,
      maxIpRate: 20,
      minHostRate: 0,
      cluster: clusterConfig,
    });

    const node2 = new ConnectQOS({
      maxAge: 10000,
      minIpRate: 20,
      maxIpRate: 20,
      minHostRate: 0,
      cluster: clusterConfig,
    });

    const makeReq = (ip: string) => ({
      headers: { host: 'target.com' },
      socket: { remoteAddress: ip }
    } as IncomingMessage);

    // Send 150 requests to each node (below local minIpRequests of 200)
    for (let i = 0; i < 150; i++) {
      expect(node1.shouldThrottleRequest(makeReq('1.2.3.4'))).toBe(false);
      expect(node2.shouldThrottleRequest(makeReq('1.2.3.4'))).toBe(false);
    }

    // Wait for sync cycle to publish + read
    await new Promise(resolve => setTimeout(resolve, 1200));

    // Now the cluster-wide count (300) exceeds cluster threshold (250)
    // Both nodes should block this IP
    expect(node1.shouldThrottleRequest(makeReq('1.2.3.4'))).toBe(BadActorType.badIp);
    expect(node2.shouldThrottleRequest(makeReq('1.2.3.4'))).toBe(BadActorType.badIp);

    // A different IP should still be allowed
    expect(node1.shouldThrottleRequest(makeReq('9.9.9.9'))).toBe(false);

    node1.destroy();
    node2.destroy();
  });

  it('cluster host ratio violation detected across nodes', async () => {
    const clusterConfig = {
      redis: { client: redisClient, keyPrefix: 'qos:test:ratio:' },
      syncIntervalMs: 500,
      clusterMaxHostRatio: 0.40, // flag if host > 40% of traffic
      clusterMaxIpRateHostViolation: 5,
    };

    const node1 = new ConnectQOS({
      maxAge: 10000,
      minIpRate: 5,
      maxIpRate: 100, // high local threshold so local limiting doesn't interfere
      minHostRate: 0,
      cluster: clusterConfig,
    });

    const makeReq = (host: string, ip: string) => ({
      headers: { host },
      socket: { remoteAddress: ip }
    } as IncomingMessage);

    // Send 80% of traffic to 'attacked.com', 20% to 'other.com'
    for (let i = 0; i < 40; i++) {
      node1.shouldThrottleRequest(makeReq('attacked.com', `10.0.0.${i % 10}`));
    }
    for (let i = 0; i < 10; i++) {
      node1.shouldThrottleRequest(makeReq('other.com', `10.1.0.${i}`));
    }

    // Wait for sync
    await new Promise(resolve => setTimeout(resolve, 1200));

    // 'attacked.com' at 80% > 40% threshold → host violation
    expect(node1.clusterSync!.isHostViolation('attacked.com')).toBe(true);
    expect(node1.clusterSync!.isHostViolation('other.com')).toBe(false);

    node1.destroy();
  });
});
