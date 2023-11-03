const http = require('http');
const { ConnectQOS } = require('../');

const PORT = Number(process.env.PORT) || 8333;

const qos = new ConnectQOS({
  minHostRate: 100,
  maxHostRate: 100,
  hostWhitelist: new Set() // allow `localhost`
});
const qosMiddleware = qos.getMiddleware();
const httpHandler = (req, res) => {
  qosMiddleware(req, res, () => {
    res.statusCode = 200;
    res.end('OK');
  });
}

const server = http.createServer(httpHandler);

server.listen(PORT);
