# connect-qos

[![NPM](https://nodei.co/npm/connect-qos.png?mini=true)](https://nodei.co/npm/connect-qos/) [![Build Status](https://app.travis-ci.com/godaddy/connect-qos.svg?branch=main)](https://app.travis-ci.com/godaddy/connect-qos)

Connect middleware that **helps** maintain a high quality of service during heavy traffic. The basic
idea is to identify bad actors and not penalize legitimate traffic more than necessary until
proper mitigation can be activated.


## Warning

While this library provides some basic HTTP (Layer 7) flood attack protection,
it does **NOT** remove the need for proper multi-layered DDoS defenses.

It's recommended to monitor for 5xx errors and alarm if threshold exceeded --
otherwise you may face an attack and not know about it.


## Getting Started with Connect/Express

Using Connect or Express?

	var
		connect = require("connect"),
		http = require("http"),
		QoS = require("connect-qos")
	;

	var app = connect()
		.use(new QoS({ }).getMiddleware())
		.use(function(req, res) {
			res.end("Hello World!");
		});

	http.createServer(app).listen(8392);


## Getting Started with HTTP

Real coders don't use middleware? We've got you covered...

	var
		http = require("http"),
		QoS = require("connect-qos")
	;

	var qos = new QoS({ });
	var qosMiddleware = qos.getMiddleware();
	http.createServer(function(req, res) {
		qos(req, res, function() {
			res.end("Hello World!");
		});
	}).listen(8392);

### Middleware Options

* `beforeThrottle(qosInstance, req, reason)` - If a function is provided it will be
  invoked prior to throttling a request in case a decision is desired. Only if
	the function explicitly returns `false` will the throttle request be denied,
	not resulting in a `503` status.

## Additional Methods

Users may also invoke methods `isBadHost(host)` or `isBadIp(ip)` on the `qos` instance to check the status of a given host or IP address. These methods will return `true` or `false` indicating whether the `host` or `ip` is currently considered to be a bad actor. This can be done for TLS/SNI
to provide additional layer 5 mitigations.

## Goals

1. Identify potential bad actors
2. Respond with 503 (BUSY) during heavy traffic for bad actors only
3. Very light weight, no complex algorithms



## Options

For you tweakers out there, here's some levers to pull:

* **maxLag** (default: `70`) - Lag time in milliseconds before throttling kicks in.
  Default should typically suffice unless you support cpu-intensive operations.
* **userLag** (default: `300`) - If defined, even if bad actors are not
  identified, any user can be throttled during very heavy traffic.
* **errorStatusCode** (default: `503`) - The HTTP status code to return if the request has been throttled
* **historySize** (default: `1000`) - The length of request history to use in
  tracking bad actors. Greater the history the more accurate the results,
  but can also increase cpu usage.
* **waitForHistory** (default: `true`) - Will never attempt to deny actors until
  at least one window of history has been generated to avoid uneccessary `userLag`
	throttling.
* **hostBadActorSplit** (default: `0.5`) - The 50% highest traffic hosts will be
  flagged as bad actors, but throttling will only occur if `maxLag` is exceeded.
* **ipBadActorSplit** (default: `0.5`) - The 50% highest traffic IPs will be
  flagged as bad actors, but throttling will only occur if `maxLag` is exceeded.
* **hostWhitelist** `Set<string>` - If provided will never flag hosts as bad actors.
* **ipWhitelist** `Set<string>` - If provided will never flag IPs as bad actors.

## TODO

* Support for tracking top bad actors over time
  * Avoids small temporary bursts resulting in bad actor flag
  * Includes dampening factor
