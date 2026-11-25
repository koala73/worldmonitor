import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EMBEDDINGS_MODEL = 'Xenova/all-MiniLM-L6-v2';
const REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
const FILES: Record<string, string> = {
  'config.json': '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7',
  'tokenizer.json': 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
  'tokenizer_config.json': '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
  'onnx/model_quantized.onnx': 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
};
const ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 60_000;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_DIR = join(repoRoot, '.cache/e2e-models', EMBEDDINGS_MODEL, REVISION);

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function readVerified(file: string): Promise<Buffer | null> {
  const bytes = await readFile(join(MODEL_DIR, file)).catch(() => null);
  return bytes && sha256(bytes) === FILES[file] ? bytes : null;
}

export async function loadEmbeddingsModelFiles(): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const file of Object.keys(FILES)) {
    const bytes = await readVerified(file);
    if (!bytes) {
      throw new Error(`${EMBEDDINGS_MODEL} ${file} is missing or corrupt in ${MODEL_DIR}. Run \`node e2e/fetch-embeddings-model.ts\`.`);
    }
    files.set(file, bytes);
  }
  return files;
}

async function download(file: string): Promise<Buffer> {
  const url = `https://huggingface.co/${EMBEDDINGS_MODEL}/resolve/${REVISION}/${file}`;
  let lastError = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'worldmonitor-e2e-model-fetch' },
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha256(bytes) !== FILES[file]) throw new Error('sha256 mismatch');
      return bytes;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.warn(`[e2e-model] ${file} attempt ${attempt}/${ATTEMPTS} failed: ${lastError}`);
    }
  }
  throw new Error(`Could not fetch ${url}: ${lastError}`);
}

async function main() {
  for (const file of Object.keys(FILES)) {
    if (await readVerified(file)) continue;
    const bytes = await download(file);
    const target = join(MODEL_DIR, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    console.log(`[e2e-model] fetched ${file} (${bytes.length} bytes)`);
  }
  console.log(`[e2e-model] ${EMBEDDINGS_MODEL}@${REVISION} ready in ${MODEL_DIR}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`[e2e-model] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
