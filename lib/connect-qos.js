var toobusy = require("toobusy-js");
var QoSMetrics = require("./metrics");

module.exports = ConnectQOS;

function ConnectQOS(options) {
  if (!(this instanceof ConnectQOS)) {
    return new ConnectQOS(options);
  }
  var self = this;
  self.options = {};
  self.options.historySize = options.historySize || 1000;
  self.options.maxLag = options.maxLag || 70;
  self.options.userLag = options.userLag || 300;
  self.options.hitRatio = options.hitRatio || 0.01;
  toobusy.maxLag(self.options.maxLag);

  self.metrics = new QoSMetrics(self.options);

  return function ConnectQOS(req, res, next) {
    if (self.shouldThrottleRequest(req) === true) {
      res.writeHead(503);
      return res.end();
    }

    // continue
    next();
  };
}

var p = ConnectQOS.prototype;

p.shouldThrottleRequest = function(req) {
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
