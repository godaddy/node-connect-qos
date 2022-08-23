const http = require('http');
const { ConnectQOS } = require('../');

const PORT = Number(process.env.PORT) || 8080;
const BENCH_TIME = 30000;
const CONCURRENCY = 50;

const qos = new ConnectQOS();
const qosMiddleware = qos.getMiddleware();
const httpHandler = (req, res) => {
  qosMiddleware(req, res, cb => {
    res.statusCode = 200;
    res.end('OK');
  });
}

const server = http.createServer(httpHandler);

server.listen(PORT);

const start = Date.now();
let requests = 0;
let errors = 0;

const URL = `http://localhost:${PORT}/`;

function requestBatch() {
  return Array.from({ length: CONCURRENCY })
    .map(() => fetch(URL)
      .catch(err => {
        errors++;
      })
      .then(res => {
        if (res.statusCode !== 200) errors++;
        requests++;
      })
    )
  ;
}

(async () => {
  const timer = setInterval(() => {
    const rps = Math.round(requests / (Date.now() - start) * 1000);
    console.log('RPS:', rps, 'Blocks:', errors);
  }, 1000);

  while ((Date.now() - start) < BENCH_TIME) {
    await requestBatch();

    await new Promise(resolve => setImmediate(resolve));
  }

  clearInterval(timer);

  server.close();
  console.log('Benchmark complete');
})();

