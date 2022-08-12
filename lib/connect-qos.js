var toobusy = require('toobusy-js');
var QoSMetrics = require('./metrics');

module.exports = ConnectQOS;

function ConnectQOS(options) {
  if (!(this instanceof ConnectQOS)) {
    return new ConnectQOS(options);
  }

  const {
    historySize = 1000,
    maxLag = 70,
    userLag = 300,
    hitRatio = 0.01,
    errorStatusCode = 503
  } = {};
  this.options = {
    historySize,
    maxLag,
    userLag,
    hitRatio,
    errorStatusCode
  };

  toobusy.maxLag(this.options.maxLag);

  this.metrics = new QoSMetrics(this.options);
}

var p = ConnectQOS.prototype;

p.getMiddleware = function ({ beforeThrottle } = {}) {
  const self = this;
  return function QOSMiddleware(req, res, next) {
    if (self.shouldThrottleRequest(req) === true) {
      if (!beforeThrottle || beforeThrottle(self, req, res) !== false) {
        // if no throttle handler OR the throttle handler does not explicitly reject, do it
        res.writeHead(self.options.errorStatusCode);
        return res.end();
      }
    }

    // continue
    next();
  };
};

p.shouldThrottleRequest = function (req) {
  this.metrics.trackRequest(req);

  if (toobusy() === true) {
    if (this.metrics.isBadActor(req) === true ||
      (this.options.userLag && toobusy.lag() >= this.options.userLag)) {
      return true; // yes, throttle user
    }
  }

  // do not throttle user
  return false;
};

p.isBadHost = function (host) {
  return toobusy() && this.metrics.isBadHost(host);
};

p.isBadIp = function (ip) {
  return toobusy() && this.metrics.isBadIp(ip);
};
