import { parentPort } from 'worker_threads';
import sharp from 'sharp';

sharp.concurrency(1);

function pngInputToBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string') return Buffer.from(input.replace(/^data:[^;]+;base64,/, ''), 'base64');
  return Buffer.from(input);
}

async function decodePngToInk(input) {
  const buf = pngInputToBuffer(input);
  const { data, info } = await sharp(buf)
    .flatten({ background: '#ffffff' })
    .grayscale()
    .resize(256, 256, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const ink = new Float32Array(256 * 256);
  for (let i = 0; i < 256 * 256; i++) ink[i] = (255 - data[i * ch]) / 255;
  return ink;
}

async function encodeMaskPng(out) {
  return sharp(out, { raw: { width: 256, height: 256, channels: 1 } }).png().toBuffer();
}

async function renderAccumulatorPair({ inkSumBuffer, count, gamma, liveMin }) {
  const inkSum = new Float32Array(inkSumBuffer);
  const full = Buffer.alloc(256 * 256);
  const live = liveMin > 0 ? Buffer.alloc(256 * 256) : full;

  for (let i = 0; i < 256 * 256; i++) {
    const f = Math.min(1, inkSum[i] / count);
    const curved = 1 - Math.pow(1 - f, gamma);
    const val = Math.round((1 - curved) * 255);
    full[i] = val;
    if (live !== full) live[i] = inkSum[i] < liveMin * 0.35 ? 255 : val;
  }

  const fullPng = await encodeMaskPng(full);
  const livePng = live === full ? fullPng : await encodeMaskPng(live);
  return { fullPng, livePng };
}

parentPort.on('message', async msg => {
  try {
    if (msg.type === 'decode-png-to-ink') {
      const ink = await decodePngToInk(msg.input);
      parentPort.postMessage({ id: msg.id, ok: true, inkBuffer: ink.buffer }, [ink.buffer]);
      return;
    }
    if (msg.type === 'render-accumulator-pair') {
      const { fullPng, livePng } = await renderAccumulatorPair(msg);
      const fullBytes = new Uint8Array(fullPng);
      const liveBytes = livePng === fullPng ? fullBytes : new Uint8Array(livePng);
      parentPort.postMessage(
        { id: msg.id, ok: true, fullPng: fullBytes.buffer, livePng: liveBytes.buffer },
        liveBytes === fullBytes ? [fullBytes.buffer] : [fullBytes.buffer, liveBytes.buffer]
      );
      return;
    }
    parentPort.postMessage({ id: msg.id, ok: false, error: `unknown worker task: ${msg.type}` });
  } catch (error) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String(error?.stack || error) });
  }
});
