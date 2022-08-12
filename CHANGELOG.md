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
