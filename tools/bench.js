const http = require('http');
const { ConnectQOS } = require('../');

const PORT = Number(process.env.PORT) || 8333;
const BENCH_TIME = Number(process.env.BENCH_TIME) || 20000;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 10;

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

const start = Date.now();
let requests = 0;
let errors = 0;

const URL = `http://localhost:${PORT}/`;

function requestBatch() {
  return Array.from({ length: CONCURRENCY })
    .map(() => fetch(URL).then(res => {
        if (res.status > 200) errors++;
        requests++;
      }, err => {
        errors++;
        requests++;
      })
    )
  ;
}

(async () => {
  const timer = setInterval(() => {
    const rps = Math.round(requests / (Date.now() - start) * 1000);
    const successRPS = Math.round((requests - errors) / (Date.now() - start) * 1000);
    console.log(`RPS: ${rps}, Success RPS: ${successRPS}, Requests: ${requests}, Blocks: ${errors}`);
  }, 1000);

  while ((Date.now() - start) < BENCH_TIME) {
    await requestBatch();

    await new Promise(resolve => setImmediate(resolve));
  }

  clearInterval(timer);

  server.close();
  console.log('Benchmark complete. See `cpu-profiles/` for perf details');
})();
