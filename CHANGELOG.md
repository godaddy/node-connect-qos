## 5.0.0

This release is about simplifying options, improved performance, and
predictable results (less "magic").

- **Breaking** `maxHostRate` option work the similar as before,
  but now require `minHostRate` to be set as well so that rate
  limiting is based on the lag ratio between `minLag` and `maxLag`.
  Additionally host rate limiting is enabled by default
- **Breaking** `maxIpRate` option work the similar as before,
  but now require `minIpRate` to be set as well so that rate
  limiting is based on the lag ratio between `minLag` and `maxLag`.
  IP rate limiting remains disabled by default
- **Breaking** `behindProxy` has been replaced with `httpBehindProxy`
  and `httpsBehindProxy` to account for possible differences between
  bindings
- **Breaking** `exemptLocalAddress` has been removed in favor
  of existing whitelisting. This "feature" was highly flawed and
  could potentially flag any internal NAT addresses as exempt when
  the intention is really only to exempt the immediate host
- **Breaking** All `Threshold` options have been removed blocking
  has shifted entirely to rate limiting via `minHostRate` and
  `minIpRate`. Additionally minimum request options have been
  removed, but rate limiting now must meet `minHostRate` or
  `minIpRate`

## 4.1.1

- **Debug** Expose `id` property on cache items and export utils

## 4.1.0

- **Feature** Normalize hosts to drop ports and `www` subdomain

## 4.0.1

- **Tuning** Default `maxAge` has been dropped from
  60 to 10 seconds which greatly increases the accuracy
  of throttling
- **Fix** Lag ratios and thresholds were being
  computed incorrectly and resulting in far fewer blocks
  while lag/load is present than expected

## 4.0.0

- **Feature** A subtle but major change no longer tracks
  hosts & IPs if they are bad. This allows for accurate
  rate limiting and auto-recovery when overwhelmed. This
  change will also greatly reduce the memory footprint
  required during times of high load
- **Critical Fix** If monitoring of host or IP monitoring
  was disabled (via `minHostRequests=0` or `minIpRequests=0`)
  the middleware would cease to block any traffic as it
  would behave as whitelisted
- **Critical Fix** LRU eviction was resulting in incorrect
  counts and thus skewing how ratios are calculated
- **Tuning** Stale purging is now based on time instead of
  request counts to provide more stable memory management.
  Additionally `maxAge` default has been reduced from 2
  to 1 minutes to avoid needless memory waste

## 3.3.0

- **Feature** Support for rate limiting when no lag is present via
  `maxHostRate` and/or `maxIpRate` options
- **Tuning** `minHostRequests` default dropped from `50` to `30`
  for faster reaction time, `maxAge` dropped from 10 minutes
  to 2 minutes to avoid wasted memory, and `historySize` dropped
  from `500` to `300` to avoid wasted memory

## 3.2.0

- **Feature** Support for disabling `badHost` via `minHostRequests:false`
  and disabling `badIp` via `minIpRequests:false`

## 3.1.0

- **Feature** Support for disabling `badHost` via `minHostRequests:false`
  and disabling `badIp` via `minIpRequests:false`

## 3.0.2

- **Fix** `172.*` space added to localhost IP check to support docker

## 3.0.0

- **Feature** Mitigation strategy has shifted to use a lag range
  (between `minLag` & `maxLag`) which is used to determine at any given
  time how aggressive throttling should be. Throttling habits are now
  proportional to the lag/load, and throttling is prioritized based
  on the the worst offenders. This also removes the need for
  `waitForHistory`, `hostBadActorSplit`, and `ipBadActorSplit`.
  `minBadActorThreshold` & `maxBadActorThreshold` indicate the min/max
  range for the requests that will be blocked in proportion to the lag
- **Feature** Shifting strategies to an LRU in combination with
  `minHostRequests` & `minIpRequests` allows us to much more quickly
  begin blocking bad traffic (5x improvement at startup with default
  config), in addition to progressive updates as statistics are
  calculated in real time and no longer lag behind the giant
  `historySize` window to detect shifts in traffic patterns
- **Feature** With the addition of `exemptLocalAddress` we will no longer
  block (by default) or even track localhost requests, which is
  especially important for healthchecks not failing

## 2.0.1

- **Change** No longer export `ConnectQOS` as `default`, export as itself

## 2.0.0

- **Feature** `hitRatio` has been replaced by `hostBadActorSplit` and
  `ipBadActorSplit` so that we're throttling the top offenders regardless
  if they hit an arbitrary percentage of traffic
- **Feature** Support for **TypeScript** has modern language features
- **Feature** Support for `waitForHistory` (enabled by default) which
  prevents `userLag` from being triggered prematurely before we have
  sufficient evidence/history
- **Feature** Official pre-request bad actor support (such as TLS SNI)
- **Fix** Calling `isBadHost` or `isBadIp` will now update history.
  This will make for more accurate bad actor detection for scenarios that
  leverage pre-request tracking (such as TLS SNI) in cases that result
  in large volumes of pre-middlware rejections
- **Feature** Support for `hostWhitelist` and `ipWhitelist` options
  if you want to prevent certains hosts or IP's from ever being blocked
- **Feature** Full test suite (that should have been in 1.0!)
- **Security** Only support `x-forwarded-for` header if `behindProxy`
  set to `true`.

## 1.0.1

- **Fix** `options` was not being adhered to

## 1.0.0

- **Feature** Support for `getMiddleware({ beforeThrottle })`
- **Feature** Support for `req.reason` for throttling

## 0.3.2

- **Fix** getMiddleware was not referencing `this` instance

## 0.3.1

- **Fix** Options were not defaulting

## 0.3.0

- **Breaking** `getMiddleware` is now part of the prototype so that instance
 functions are accessible

## 0.2.0

- Add support for errorStatusCode option and expose new methods isBadHost and isBadIp
