# connect-qos

[![NPM](https://nodei.co/npm/connect-qos.png?mini=true)](https://nodei.co/npm/connect-qos/) [![Build Status](https://app.travis-ci.com/godaddy/connect-qos.svg?branch=main)](https://app.travis-ci.com/godaddy/connect-qos)

Connect middleware that **helps** maintain a high quality of service
during heavy traffic. The basic idea is to identify bad actors and
not penalize legitimate traffic more than necessary until proper
mitigation can be activated.


## Warning

While this library provides some basic HTTP (Layer 7) flood attack protection,
it does **NOT** remove the need for proper multi-layered DDoS defenses.

It's recommended to monitor for 5xx errors and alarm if threshold exceeded --
otherwise you may face an attack and not know about it.


## Getting Started with Connect/Express

Using Connect or Express?

	const
		connect = require("connect"),
		http = require("http");
	const { ConnectQOS } = require("connect-qos");

	var app = connect()
		.use(new ConnectQOS().getMiddleware())
		.use(function(req, res) {
			res.end("Hello World!");
		});

	http.createServer(app).listen(8392);


## Getting Started with HTTP

Real coders don't use middleware? We've got you covered too...

	const http = require("http");
	const { ConnectQOS } = require("connect-qos");

	var qos = new ConnectQOS();
	var qosMiddleware = qos.getMiddleware();
	http.createServer(function(req, res) {
		qosMiddleware(req, res, function() {
			res.end("Hello World!");
		});
	}).listen(8392);

### Middleware Options

* `beforeThrottle(qosInstance, req, reason)` - If a function is provided it will be
  invoked prior to throttling a request in case a decision is desired. Only if
	the function explicitly returns `false` will the throttle request be denied,
	not resulting in a `503` status.
* `destroySocket` (default: `true`) - If denying bad actor also destroy the socket
  to prevent reuse.

## Additional Methods

Users may also invoke methods `isBadHost(host)` or `isBadIp(ip)` on the `qos` instance to check the status of a given host or IP address. These methods will return `true` or `false` indicating whether the `host` or `ip` is currently considered to be a bad actor. This can be done for TLS/SNI to provide additional layer 5 mitigations.

## Goals

1. Identify potential bad actors
2. Respond with 503 (BUSY) during heavy traffic for bad actors only
3. Very light weight, no complex algorithms



## Options

For you tweakers out there, here's some levers to pull:

* **minLag** (default: `70`) - Lag time in milliseconds before throttling kicks in.
  Default should typically suffice unless you support cpu-intensive operations.
* **maxLag** (default: `300`) - The highest lag threshold which will block the
  greatest amount of traffic determined by `maxBadHostThreshold` or `maxBadIpThreshold`.
* **minHostRate** (default: `20`) - Minimum rate if lag is >= maxLag. Disable
  rate limiting by setting to `0`.
* **maxHostRate** (default: `40`) - Maximum rate if lag is <= minLag.
* **maxHostRatio** (default: `0`) - If a given host receives the specified threshold (`0.1` = 10%)
  a `hostViolation` will be returned. This prevents a single host
	from accounting for excessive traffic and is an effective method for combating
	very large attacks.
* **minIpRate** (default: `0`) - Minimum rate if lag is >= maxLag. Disable
  rate limiting by setting to `0`.
* **maxIpRate** (default: `0`) - Maximum rate if lag is <= minLag.
* **maxIpRateHostViolation** (default: `0`) - Maximum rate if target host is currently exceeding the
  configured `maxHostRatio`. This can be used to increase IP throttling if a particular host is being
  targeted by a large number of IPs. Requests hitting this max rate will receive `hostViolation` while
	requests below the rate threshold but hitting the target host will not be flagged.
* **errorStatusCode** (default: `503`) - The HTTP status code to return if the
  request has been throttled.
* **errorResponseDelay** (default: `0`) - Number of milliseconds to delay sending an error response to
  bad actors. A value of 0 will result in the response being sent synchronously before returning from the middleware.
* **historySize** (default: `200`) - The LRU history size to use in
  tracking bad actors. Hosts and IPs both get their own dedicated LRU.
* **maxAge** (default: `10000`) - Time (in ms) before history is purged.
  10 seconds is generally more than adequate to capture an accurate hit rate.
* **hostWhitelist** `Set<string>(['localhost'])` - If provided will never
  flag hosts as bad actors.
* **ipWhitelist** `Set<string>([])` - If provided will never flag IPs as bad actors.
* **httpBehindProxy** (default: `false`) - `x-forwarded-for` header only supported
  if this option is set to `true`.
* **httpsBehindProxy** (default: `false`) - `x-forwarded-for` header only supported
  if this option is set to `true`.


## Performance

With quality of service being the entire purpose of this library needless to say
performance is a critical influence in every decision. You can expect `connect-qos`
to never be a bottleneck of any kind. Local tests on modest laptop easily
exceeds 3.5K req/sec on a hello world http server. See for yourself with
`npm run bench`.
