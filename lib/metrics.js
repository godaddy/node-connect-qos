module.exports = Metrics;

function Metrics(options) {
  this.hosts = {};
  this.ips = {};
  this.badHosts = this.badIps = {};
  this.history = 0;
  this.historySize = options.historySize || 1000;
  this.hitRatio = options.hitRatio || 0.01;
}

var p = Metrics.prototype;

p.trackRequest = function trackRequest(req) {
  req.remoteIp = req.headers["x-forwarded-for"] ||
    (req.connection && req.connection.remoteAddress) ||
    (req.socket && req.socket.remoteAddress) ||
    (req.connection && req.connection.socket && req.connection.socket.remoteAddress)
  ;
  var host = req.headers["host"];

  var count;

  if (host) {
    count = (this.hosts[host] || 0) + 1;
    this.hosts[host] = count;
  }
  count = (this.ips[req.remoteIp] || 0) + 1;
  this.ips[req.remoteIp] = count;

  // periodically aggregate data and identify bad actors
  if (++this.history >= this.historySize) {
    identifyBadActors.call(this);
  }
};

p.isBadActor = function isBadActor(req) {
  if (req.isBadActor !== undefined) {
    return req.isBadActor;
  }

  // innocent until proven guilty
  req.isBadActor = false;

  // determine if bad actor
  var host = req.headers["host"];
  if (host && host in this.badHosts) {
    req.isBadActor = true;
    return req.isBadActor;
  }
  if (req.remoteIp && req.remoteIp in this.badIps) {
    req.isBadActor = true;
    return req.isBadActor;
  }

  return req.isBadActor;
};

function identifyBadActors() {
  // reset every cycle? one option would be to keep them around for a while or track ranking
  this.badHosts = this.badIps = {};

  var k, count, ratio;

  // hosts
  for (k in this.hosts) {
    count = this.hosts[k];
    ratio = count / this.historySize;
    if (ratio >= this.hitRatio) {
      this.badHosts[k] = count;
    }
  }

  // ips
  for (k in this.ips) {
    count = this.ips[k];
    ratio = count / this.historySize;
    if (ratio >= this.hitRatio) {
      this.badIps[k] = count;
    }
  }

  // reset
  this.history = 0;
  this.ips = this.hosts = {};
}
