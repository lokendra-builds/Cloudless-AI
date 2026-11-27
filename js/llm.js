// In-browser models only. There is no server: the model runs inside this tab, either on the CPU
// (wllama = llama.cpp in WebAssembly, bundled in vendor/) or on the GPU (WebLLM over WebGPU).
//
// Every engine exposes the same function:
//   chat(messages, { signal, temperature, onToken }) -> Promise<string>   (the full reply)
// onToken(textSoFar) is called as the reply streams in.

export const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.89';
const WLLAMA_URL = new URL('../vendor/wllama/index.js', import.meta.url).href;
const WLLAMA_WASM = new URL('../vendor/wllama/wasm/wllama.wasm', import.meta.url).href;

export class SetupError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SetupError';
    this.code = code;
  }
}

const stopped = () => new DOMException('Stopped', 'AbortError');

// ---- CPU models (GGUF from Hugging Face). Each file stays under the browser's 2 GB buffer limit. ----
export const CPU_MODELS = Object.freeze([
  { company: 'Alibaba', name: 'Qwen3 1.7B', repo: 'unsloth/Qwen3-1.7B-GGUF', file: 'Qwen3-1.7B-Q4_K_M.gguf', maxCtx: 32768, kvKB: 112, gb: 1.1, note: 'recommended', thinks: true },
  { company: 'Alibaba', name: 'Qwen3 0.6B', repo: 'unsloth/Qwen3-0.6B-GGUF', file: 'Qwen3-0.6B-Q4_K_M.gguf', maxCtx: 32768, kvKB: 112, gb: 0.4, note: 'fastest', thinks: true },
  { company: 'Alibaba', name: 'Qwen2.5 1.5B', repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF', file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf', maxCtx: 32768, kvKB: 28, gb: 1.1, note: 'balanced' },
  { company: 'Alibaba', name: 'Qwen2.5 Coder 1.5B', repo: 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF', file: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf', maxCtx: 32768, kvKB: 28, gb: 1.1, note: 'best for code' },
  { company: 'Meta', name: 'Llama 3.2 1B', repo: 'bartowski/Llama-3.2-1B-Instruct-GGUF', file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf', maxCtx: 131072, kvKB: 32, gb: 0.8, note: 'fast' },
  { company: 'Meta', name: 'Llama 3.2 3B', repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF', file: 'Llama-3.2-3B-Instruct-Q3_K_M.gguf', maxCtx: 131072, kvKB: 112, gb: 1.7, note: 'smarter, slower' },
  { company: 'Google', name: 'Gemma 3 1B', repo: 'ggml-org/gemma-3-1b-it-GGUF', file: 'gemma-3-1b-it-Q4_K_M.gguf', maxCtx: 32768, kvKB: 26, gb: 0.8, note: 'fast' },
  { company: 'Hugging Face', name: 'SmolLM2 1.7B', repo: 'HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF', file: 'smollm2-1.7b-instruct-q4_k_m.gguf', maxCtx: 8192, kvKB: 192, gb: 1.1, note: 'light' },
  { company: 'Microsoft', name: 'Phi-3.5 mini', repo: 'bartowski/Phi-3.5-mini-instruct-GGUF', file: 'Phi-3.5-mini-instruct-Q3_K_S.gguf', maxCtx: 131072, kvKB: 384, gb: 1.7, note: 'slow on CPU' },
].map((m) => Object.freeze({ ...m, id: m.file, label: `${m.company} · ${m.name}` })));

export const DEFAULT_CPU_MODEL = CPU_MODELS[0].file;

export function cpuModelFor(file) {
  return CPU_MODELS.find((m) => m.file === file) || CPU_MODELS[0];
}

// ---- GPU models (MLC builds that WebLLM ships). Sizes are GPU memory from WebLLM's config. ----
export const GPU_MODELS = Object.freeze([
  { name: 'Qwen2.5 1.5B', id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', maxCtx: 32768, kvKB: 28, gb: 1.6, note: 'recommended' },
  { name: 'Qwen3 1.7B', id: 'Qwen3-1.7B-q4f16_1-MLC', maxCtx: 32768, kvKB: 112, gb: 2.0, note: 'thinks first', thinks: true },
  { name: 'Llama 3.2 3B', id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', maxCtx: 131072, kvKB: 112, gb: 2.3, note: 'smarter' },
  { name: 'Phi-3.5 mini', id: 'Phi-3.5-mini-instruct-q4f16_1-MLC', maxCtx: 131072, kvKB: 384, gb: 3.7, note: 'strong, big' },
  { name: 'Gemma 2 2B', id: 'gemma-2-2b-it-q4f16_1-MLC', maxCtx: 8192, kvKB: 106, gb: 1.9, note: 'balanced' },
  { name: 'Llama 3.1 8B', id: 'Llama-3.1-8B-Instruct-q4f16_1-MLC', maxCtx: 131072, kvKB: 128, gb: 5.0, note: 'best, needs a big GPU' },
].map((m) => Object.freeze({ ...m, label: m.name })));

export const DEFAULT_GPU_MODEL = GPU_MODELS[0].id;

/** The GPU model for a saved id; an f32 build id maps back to its model. */
export function gpuModelFor(id) {
  const base = String(id || '').replace('q4f32_1', 'q4f16_1');
  return GPU_MODELS.find((m) => m.id === base) || GPU_MODELS[0];
}

/** "f16" builds need the GPU's shader-f16 feature; without it use the same model's f32 build. */
export function compatibleModelId(id, hasF16) {
  if (hasF16 !== false) return id;
  return String(id || '').replace('q4f16_1', 'q4f32_1');
}

export function hasWebGPU() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

/**
 * Whether the GPU can run "f16" model builds. Detected once at start-up (detectGpu); until then
 * assume yes. Many GPUs, e.g. NVIDIA on Linux (Vulkan), lack the shader-f16 feature, and f16
 * builds then fail with "GPUPipelineError: Invalid ShaderModule … index_kernel".
 */
let gpuF16 = true;
export function setGpuF16(v) { gpuF16 = !!v; } // tests
export async function detectGpu() {
  if (!hasWebGPU()) return false;
  gpuF16 = await gpuHasF16();
  return gpuF16;
}

/** A WebGPU shader / pipeline failure: the GPU or its driver can't run this model build. */
export function isGpuShaderError(e) {
  return /GPUPipelineError|ShaderModule|shader-f16|WGSL|compute stage|createComputePipeline|GPUValidationError|device (was )?lost/i.test(String(e?.message || e));
}

export async function gpuHasF16() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    return !!adapter?.features?.has('shader-f16');
  } catch {
    return false;
  }
}

// ---- Which models this app downloaded (so "Delete all data" removes only its own) ----

const OWN_MODELS_KEY = 'cloudless.models';

export function ownModels() {
  try { return JSON.parse(localStorage.getItem(OWN_MODELS_KEY)) || []; } catch { return []; }
}

export function rememberModel(engine, id) {
  const list = ownModels();
  if (!list.some((m) => m.engine === engine && m.id === id)) {
    list.push({ engine, id });
    try { localStorage.setItem(OWN_MODELS_KEY, JSON.stringify(list)); } catch { /* storage blocked */ }
  }
}

// ---- Context window (how many tokens the model can hold at once) ----

export const DEFAULT_CTX = 4096;
export const CTX_STEPS = [2048, 4096, 8192, 16384, 32768];
// WebAssembly gives one tab at most 4 GB; leave room for the runtime itself.
const CPU_RAM_CAP_GB = 3.6;

/** Extra memory the context needs (the KV cache), in GB. */
export function kvGB(model, ctx) {
  return ((model.kvKB || 0) * ctx) / (1024 * 1024);
}

/** Context sizes this model can use: within its trained maximum and, on the CPU, within RAM. */
export function ctxOptions(model) {
  if (!model?.maxCtx) return CTX_STEPS;
  return CTX_STEPS.filter((n) => n <= model.maxCtx && (model.engine !== 'cpu' || model.gb + kvGB(model, n) <= CPU_RAM_CAP_GB || n <= DEFAULT_CTX));
}

/** The context to use: the setting, lowered to the biggest size this model allows. */
export function effectiveCtx(model, wanted = DEFAULT_CTX) {
  const opts = ctxOptions(model);
  return [...opts].reverse().find((n) => n <= wanted) || opts[0];
}

// ---- Streaming helper (pure, tested) ----

/** Text of one streamed chunk, whatever shape the engine sends. */
export function chunkText(chunk) {
  if (chunk == null) return '';
  if (typeof chunk === 'string') return chunk;
  const c = chunk.choices?.[0];
  return c?.delta?.content ?? c?.text ?? chunk.content ?? chunk.token_text ?? '';
}

// ---- wllama: CPU ----

let wllama = null;
let wllamaFile = null;
let wllamaCtx = 0;

export function cpuReady(file, ctx = 0) {
  return !!wllamaFile && cpuModelFor(file).file === wllamaFile && (!ctx || ctx === wllamaCtx);
}

export async function isCpuCached(file) {
  const m = cpuModelFor(file);
  try {
    const { ModelManager } = await import(WLLAMA_URL);
    const models = await new ModelManager().getModels();
    return models.some((x) => String(x.url || '').includes(m.file));
  } catch {
    return false;
  }
}

/** Download (first time only) and load a CPU model. Call only after the user agreed. */
export async function loadCpu(file, onProgress = () => {}, ctx = DEFAULT_CTX) {
  const m = cpuModelFor(file);
  if (wllamaFile === m.file && wllamaCtx === ctx) return;
  const { Wllama } = await import(WLLAMA_URL);
  if (wllama && wllamaFile) {
    await wllama.exit().catch(() => {});
    wllama = null;
    wllamaFile = null;
  }
  const alreadyCached = await isCpuCached(m.file); // downloaded earlier by another app on this site?
  wllama ??= new Wllama({ default: WLLAMA_WASM }, { suppressNativeLog: true });
  await wllama.loadModelFromHF({ repo: m.repo, file: m.file }, {
    n_gpu_layers: 0,
    n_ctx: ctx,
    progressCallback: ({ loaded, total }) => onProgress(total ? loaded / total : 0, `${Math.round(loaded / 1e6)} / ${Math.round((total || 0) / 1e6)} MB`),
  });
  wllamaFile = m.file;
  wllamaCtx = ctx;
  if (!alreadyCached) rememberModel('cpu', m.file); // only files this app downloaded are its to delete
}

export function cpuMultithread() {
  return !!wllama?.isMultithread?.();
}

/** Qwen3 skips its thinking when asked: the template flag plus the documented "/no_think" switch. */
function noThink(messages) {
  return messages.map((x, i) => (i === 0 && x.role === 'system' ? { ...x, content: `${x.content}\n/no_think` } : x));
}

async function cpuChat(file, messages, { signal, temperature = 0.7, onToken = () => {}, think = true, ctx = 0 } = {}) {
  const thinks = cpuModelFor(file).thinks;
  if (thinks && !think) messages = noThink(messages);
  if (!cpuReady(file, ctx)) throw new SetupError('The model is not loaded yet.', 'NOT_LOADED');
  if (signal?.aborted) throw stopped();
  let text = '';
  try {
    await wllama.createChatCompletion({
      messages,
      max_tokens: 2048,
      temperature,
      cache_prompt: true, // reuse the already-read conversation between turns
      stream: true,
      ...(thinks ? { chat_template_kwargs: { enable_thinking: !!think } } : {}),
      onData: (chunk) => { text += chunkText(chunk); onToken(text); },
      abortSignal: signal,
    });
  } catch (e) {
    if (signal?.aborted) throw stopped();
    throw e;
  }
  if (signal?.aborted) throw stopped();
  return text;
}

// ---- WebLLM: GPU ----

let webllm = null;
let webllmModel = '';
let webllmWorker = null;
let webllmCtx = 0;

export function gpuReady(id, ctx = 0) {
  return !!webllm && (!id || webllmModel === id) && (!ctx || ctx === webllmCtx);
}

async function dropGpuEngine() {
  try { await webllm?.unload?.(); } catch { /* already broken */ }
  try { webllmWorker?.terminate(); } catch { /* ignore */ }
  webllm = null;
  webllmWorker = null;
  webllmModel = '';
  webllmCtx = 0;
}

function gpuFailed(e) {
  const err = new SetupError(`Your GPU could not run this model (${String(e?.message || e).slice(0, 140)}). Switch to CPU, or try the GPU-safe version of the model.`, 'GPU_FAILED');
  err.cause = e;
  return err;
}

export async function isGpuCached(id) {
  try {
    if (!id || !('caches' in window)) return false;
    const names = (await caches.keys()).filter((n) => n.startsWith('webllm/model'));
    for (const name of names) {
      const keys = await (await caches.open(name)).keys();
      if (keys.some((r) => r.url.includes(`/${id}/`))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function loadGpu(id, onProgress = () => {}, ctx = DEFAULT_CTX) {
  if (webllm && webllmModel === id && webllmCtx === ctx) return;
  const { CreateWebWorkerMLCEngine } = await import(WEBLLM_URL);
  if (webllm) await dropGpuEngine();
  const alreadyCached = await isGpuCached(id);
  webllmWorker = new Worker(new URL('./webllm-worker.js?v=c38f851470', import.meta.url), { type: 'module' });
  try {
    webllm = await CreateWebWorkerMLCEngine(webllmWorker, id, {
      initProgressCallback: (p) => onProgress(p.progress ?? 0, p.text ?? ''),
    }, { context_window_size: ctx });
  } catch (e) {
    await dropGpuEngine();
    throw isGpuShaderError(e) ? gpuFailed(e) : e;
  }
  webllmModel = id;
  webllmCtx = ctx;
  if (!alreadyCached) rememberModel('gpu', id);
}

async function gpuChat(id, messages, { signal, temperature = 0.7, onToken = () => {}, think = true, ctx = 0 } = {}) {
  const thinks = gpuModelFor(id).thinks;
  if (thinks && !think) messages = noThink(messages);
  if (!gpuReady(id, ctx)) throw new SetupError('The model is not loaded yet.', 'NOT_LOADED');
  if (signal?.aborted) throw stopped();
  const onAbort = () => webllm.interruptGenerate();
  signal?.addEventListener('abort', onAbort, { once: true });
  let text = '';
  try {
    const stream = await webllm.chat.completions.create({
      messages, temperature, max_tokens: 2048, stream: true,
      ...(thinks ? { extra_body: { enable_thinking: !!think } } : {}),
    });
    for await (const chunk of stream) {
      text += chunkText(chunk);
      onToken(text);
      if (signal?.aborted) break;
    }
  } catch (e) {
    if (isGpuShaderError(e)) { await dropGpuEngine(); throw gpuFailed(e); } // some shaders compile on first use
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) throw stopped();
  return text;
}

// ---- Mock (tests and demos: ?mock=1). Streams scripted replies word by word. ----

let mockLoaded = false;
let mockCtx = 0;
export function mockReady(ctx = 0) { return mockLoaded && (!ctx || ctx === mockCtx); }
export async function loadMock(onProgress = () => {}, ctx = DEFAULT_CTX) {
  window.__mockLoads = (window.__mockLoads || 0) + 1;
  for (const p of [0.25, 0.5, 1]) {
    onProgress(p, 'mock');
    await new Promise((r) => setTimeout(r, window.__mockLoadMs ?? 20));
  }
  mockLoaded = true;
  mockCtx = ctx;
}

async function mockChat(messages, { signal, onToken = () => {}, think = true } = {}) {
  window.__mockLastThink = think;
  if (window.__mockError) { const { message, code } = window.__mockError; window.__mockError = null; throw new SetupError(message, code); }
  window.__mockSeen = [...(window.__mockSeen || []), JSON.parse(JSON.stringify(messages))];
  const replies = window.__mockReplies || [];
  const reply = replies.length ? replies.shift() : `Echo: ${messages.at(-1)?.content ?? ''}`;
  const delay = window.__mockDelayMs ?? 5;
  let text = '';
  for (const piece of reply.match(/\S+\s*|\s+/g) || []) {
    if (signal?.aborted) throw stopped();
    await new Promise((r) => setTimeout(r, delay));
    text += piece;
    onToken(text);
  }
  if (signal?.aborted) throw stopped();
  return text;
}

/** Free every loaded model (needed before deleting model files: open files cannot be removed). */
export async function unloadAll() {
  if (wllama) await wllama.exit().catch(() => {});
  wllama = null;
  wllamaFile = null;
  if (webllm) await webllm.unload?.().catch(() => {});
  webllm = null;
  webllmModel = '';
  mockLoaded = false;
}

// ---- One entry point for the app ----

/** The model the settings point at: {engine, id, label, gb, thinks}. */
export function currentModel(settings, { mock = false } = {}) {
  const withCtx = (m) => ({ ...m, ctx: effectiveCtx(m, Number(settings.ctx) || DEFAULT_CTX) });
  if (mock) return withCtx({ engine: 'mock', id: 'mock', label: 'Demo replies', gb: 0, thinks: true, maxCtx: 32768, kvKB: 112 });
  if (settings.engine === 'gpu') {
    const m = gpuModelFor(settings.gpuModel);
    const id = compatibleModelId(m.id, gpuF16 && !settings.gpuSafe);
    return withCtx({ engine: 'gpu', id, label: id === m.id ? m.label : `${m.label} (GPU-safe)`, gb: m.gb, thinks: !!m.thinks, safe: id !== m.id, maxCtx: m.maxCtx, kvKB: m.kvKB });
  }
  const m = cpuModelFor(settings.cpuModel);
  return withCtx({ engine: 'cpu', id: m.file, label: m.label, gb: m.gb, thinks: !!m.thinks, maxCtx: m.maxCtx, kvKB: m.kvKB });
}

export function modelReady(model) {
  if (model.engine === 'mock') return mockReady(model.ctx);
  return model.engine === 'gpu' ? gpuReady(model.id, model.ctx) : cpuReady(model.id, model.ctx);
}

/** The model's weights are in memory, but with a different context size (a quick reload, no download). */
export function loadedWithOtherCtx(model) {
  if (model.engine === 'mock') return mockLoaded && mockCtx !== model.ctx;
  return model.engine === 'gpu' ? gpuReady(model.id) && webllmCtx !== model.ctx : cpuReady(model.id) && wllamaCtx !== model.ctx;
}

export async function modelCached(model) {
  if (model.engine === 'mock') return mockLoaded || !window.__mockNotCached;
  return model.engine === 'gpu' ? isGpuCached(model.id) : isCpuCached(model.id);
}

export async function loadModel(model, onProgress) {
  const ctx = model.ctx || DEFAULT_CTX;
  if (model.engine === 'mock') return loadMock(onProgress, ctx);
  if (model.engine === 'gpu') {
    if (!hasWebGPU()) throw new SetupError('This browser has no WebGPU. Switch to CPU in the model menu.', 'NO_WEBGPU');
    return loadGpu(model.id, onProgress, ctx);
  }
  return loadCpu(model.id, onProgress, ctx);
}

export function chat(model, messages, opts = {}) {
  if (model.engine === 'mock') return mockChat(messages, opts);
  const o = { ...opts, ctx: model.ctx };
  return model.engine === 'gpu' ? gpuChat(model.id, messages, o) : cpuChat(model.id, messages, o);
}
