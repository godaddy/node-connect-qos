const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 8333;
const BENCH_TIME = Number(process.env.BENCH_TIME) || 20000;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 10;

const server = spawn(process.argv[0], ['tools/bench-server.js'], {
  env: {
    PORT: PORT.toString(),
  }
});

const start = Date.now();
let requests = 0;
let errors = 0;

const URL = `http://localhost:${PORT}/`;

function requestBatch() {
  return Promise.all(Array.from({ length: CONCURRENCY })
    .map(() => fetch(URL).then(res => {
      if (res.status > 200) errors++;
      requests++;
      return res.text();
    }, err => {
      errors++;
      requests++;
    })
    )
  );
}

(async () => {
  let now = performance.now();

  function reportStats() {
    const rps = Math.round(requests / (Date.now() - start) * 1000);
    const successRPS = Math.round((requests - errors) / (Date.now() - start) * 1000);
    console.log(`RPS: ${rps}, Success RPS: ${successRPS}, Requests: ${requests}, Blocks: ${errors}`);
  }

  while ((Date.now() - start) < BENCH_TIME) {
    await requestBatch();

    if ((performance.now() - now) > 1000) {
      reportStats();
      now = performance.now();
    }
  }

  server.kill();
  console.log('Benchmark complete. See `cpu-profiles/` for perf details');
})();
