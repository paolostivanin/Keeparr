// Timing traces for the slow list endpoints.

let perfRequestSeq = 0;

function createPerfTrace(name, details = {}) {
  const id = ++perfRequestSeq;
  const start = process.hrtime.bigint();
  let last = start;
  const elapsed = (from = start) => Number(process.hrtime.bigint() - from) / 1e6;
  const detailText = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  console.log(`[KeeparrPerf:server] ${name}#${id} start${detailText}`);
  return {
    id,
    mark(label, extra = {}) {
      const now = process.hrtime.bigint();
      const delta = Number(now - last) / 1e6;
      last = now;
      const extraText = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
      console.log(`[KeeparrPerf:server] ${name}#${id} ${label} +${delta.toFixed(1)}ms total=${elapsed().toFixed(1)}ms${extraText}`);
    },
    end(extra = {}) {
      const extraText = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
      console.log(`[KeeparrPerf:server] ${name}#${id} end total=${elapsed().toFixed(1)}ms${extraText}`);
    }
  };
}

function sendJsonWithPerf(res, trace, payload) {
  const serializeStart = process.hrtime.bigint();
  const body = JSON.stringify(payload);
  const serializeMs = Number(process.hrtime.bigint() - serializeStart) / 1e6;
  trace.mark('serialize', { ms: Number(serializeMs.toFixed(1)), bytes: Buffer.byteLength(body) });
  res.type('application/json').send(body);
  trace.end({ bytes: Buffer.byteLength(body) });
}

module.exports = {
  createPerfTrace, sendJsonWithPerf
};
