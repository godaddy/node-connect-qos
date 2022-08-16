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
