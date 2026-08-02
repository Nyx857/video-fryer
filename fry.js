/* fry.js - 处理核心:加载 ffmpeg.wasm、执行全损滤镜命令、读回结果
 * 引擎文件已本地化到 vendor/ffmpeg/ 同源托管(规避 CDN 跨域 Worker/模块限制,
 * 也避免国内访问 unpkg/jsdelivr 不稳定);单线程 core 不依赖 COOP/COEP 头。
 */

const VENDOR = new URL('./vendor/ffmpeg/', import.meta.url).href;

let ffmpeg = null;   // 已加载的 FFmpeg 实例(可复用,exec 多次)
let loading = false; // 防止并发加载

/* 读取文件流并报进度,返回原 URL(本地同源文件直接给 worker 用,
 * 无需 blob 化——blob 动态 import 在 module worker 内会失败) */
async function downloadWithProgress(url, onProgress) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('download failed: ' + url + ' (' + resp.status + ')');
  const total = Number(resp.headers.get('Content-Length')) || 0;
  const reader = resp.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (onProgress) onProgress(received, total);
  }
  return url;
}

/* 动态引入本地化的 @ffmpeg/ffmpeg 主模块 */
function importFFmpegModule() {
  return import(VENDOR + 'index.js');
}

/* 下载引擎文件(同源,有准确 Content-Length,可报真实进度) */
async function fetchEngineFiles(onProgress) {
  const js = await downloadWithProgress(VENDOR + 'ffmpeg-core.js', onProgress);
  const wasm = await fetchWasmParts(onProgress);
  return { js, wasm };
}

/* wasm 32MB 超过 Cloudflare Pages 单文件 25MiB 上限,拆成两个 part 提交;
 * 这里顺序下载两个 part 并拼回完整 wasm(blob URL 交给 worker 加载) */
async function fetchWasmParts(onProgress) {
  const PARTS = ['ffmpeg-core.wasm.part.aa', 'ffmpeg-core.wasm.part.ab'];
  const blobs = [];
  for (const p of PARTS) {
    const url = VENDOR + p;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('download failed: ' + url + ' (' + resp.status + ')');
    const total = Number(resp.headers.get('Content-Length')) || 0;
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (onProgress) onProgress(received, total);
    }
    blobs.push(new Blob(chunks, { type: 'application/wasm' }));
  }
  return URL.createObjectURL(new Blob(blobs, { type: 'application/wasm' }));
}

/* 加载引擎(onLoadProgress(received, total) 报告下载进度),成功后缓存复用 */
export async function loadEngine(onLoadProgress) {
  if (ffmpeg) return ffmpeg;
  if (loading) throw new Error('引擎正在加载中');
  loading = true;
  try {
    const mod = await importFFmpegModule();
    const f = new mod.FFmpeg();
    const { js, wasm } = await fetchEngineFiles(onLoadProgress);
    // classWorkerURL 与 core 均用同源 URL:worker.js 内部有 ./const.js 等相对
    // import,同源 module worker 才能解析;blob URL 会静默加载失败。
    const workerURL = new URL('./vendor/ffmpeg/worker.js', import.meta.url).href;
    await f.load({ classWorkerURL: workerURL, coreURL: js, wasmURL: wasm });
    ffmpeg = f;
    return f;
  } finally {
    loading = false;
  }
}

/* 终止当前实例(用于取消)。实例不可复用,下次 loadEngine 会重新加载。 */
export function terminateEngine() {
  if (ffmpeg) {
    try { ffmpeg.terminate(); } catch (e) { /* ignore */ }
    ffmpeg = null;
  }
}

/* 全损处理:输入 File → 输出全损 MP4 Blob
 * onProgress(p) 报告处理进度,p ∈ [0,1]
 */
export async function fryVideo(file, { onProgress, onLoadProgress } = {}) {
  const f = await loadEngine(onLoadProgress);
  const inputName = 'input.mp4';
  const outputName = 'output.mp4';
  let progCb = null;

  try {
    progCb = ({ progress }) => { if (onProgress) onProgress(progress); };
    f.on('progress', progCb);

    // 输入写入内存
    const data = new Uint8Array(await file.arrayBuffer());
    await f.writeFile(inputName, data);

    // 全损滤镜(v4 老照片版):
    //   视频:缩到 320 → 8fps 掉帧 → 噪点 → sepia 棕褐 → 褪色低对比 → 暗角 → 低码率
    //   音频:2.5x 增益 → 忽大忽小拉满 → 狠削波 → 11025Hz 单声道 24k 极糙
    const args = [
      '-i', inputName,
      '-vf', 'scale=320:-2,fps=8,noise=alls=15:allf=t,'
        + 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131,'
        + 'eq=saturation=0.6:contrast=0.85,'
        + 'vignette=PI/4.5',
      '-b:v', '150k',
      '-af', 'volume=2.5,tremolo=f=1.5:d=1.0,alimiter=limit=0.1',
      '-ar', '11025',
      '-ac', '1',
      '-b:a', '24k',
      '-pix_fmt', 'yuv420p',
      '-y', outputName
    ];
    await f.exec(args);

    const out = await f.readFile(outputName);
    return new Blob([out.buffer], { type: 'video/mp4' });
  } finally {
    if (progCb) { try { f.off('progress', progCb); } catch (e) { /* ignore */ } }
    try { await f.deleteFile(inputName); } catch (e) { /* ignore */ }
    try { await f.deleteFile(outputName); } catch (e) { /* ignore */ }
  }
}
