/* app.js - 页面交互:上传、校验、进度、结果渲染、下载 */

import { loadEngine, fryVideo, terminateEngine } from './fry.js';

(function () {
  'use strict';

  // ---- DOM 引用 ----
  const $ = (id) => document.getElementById(id);
  const uploadZone = $('uploadZone');
  const fileInput = $('fileInput');
  const pickBtn = $('pickBtn');
  const progressPanel = $('progressPanel');
  const progressTitle = $('progressTitle');
  const progressBarInner = $('progressBarInner');
  const progressText = $('progressText');
  const errorText = $('errorText');
  const cancelBtn = $('cancelBtn');
  const resultsSection = $('resultsSection');
  const downloadBtn = $('downloadBtn');
  const saveBtn = $('saveBtn');
  const actionsRow = $('actionsRow');
  const actionsHint = $('actionsHint');
  const origMeta = $('origMeta');
  const friedMeta = $('friedMeta');
  const sizeCompare = $('sizeCompare');
  const origVideo = $('origVideo');
  const friedVideo = $('friedVideo');

  // ---- 常量 ----
  const MAX_SIZE = 200 * 1024 * 1024; // 200MB
  const MAX_DURATION = 180;           // 3 分钟(秒)
  const VIDEO_EXT_RE = /\.(mp4|mov|mkv|webm|avi|flv|m4v|3gp|wmv)$/i;

  // ---- 状态 ----
  let currentFile = null;   // 当前上传的文件
  let resultBlob = null;    // 处理结果 Blob
  let resultUrl = null;     // 结果预览 URL
  let origUrl = null;       // 原片预览 URL
  let busy = false;         // 是否正在加载引擎/处理
  let cancelled = false;

  // ---- 工具 ----
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function setProgress(pct, text) {
    progressBarInner.style.width = pct + '%';
    progressText.textContent = text;
  }

  function showError(msg) {
    // 错误显示在进度面板里,先确保它可见
    progressPanel.classList.remove('hidden');
    progressBarInner.style.width = '0%';
    progressText.textContent = '';
    cancelBtn.classList.add('hidden');
    errorText.textContent = msg;
    errorText.classList.remove('hidden');
  }

  function clearError() {
    errorText.textContent = '';
    errorText.classList.add('hidden');
  }

  function revokeResultUrl() {
    if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = null; }
    if (origUrl) { URL.revokeObjectURL(origUrl); origUrl = null; }
  }

  // ---- 上传 ----
  pickBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });
  uploadZone.addEventListener('click', () => { if (!busy) fileInput.click(); });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) handleFile(f);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) => {
    uploadZone.addEventListener(ev, (e) => {
      e.preventDefault();
      if (!busy) uploadZone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    uploadZone.addEventListener(ev, (e) => { e.preventDefault(); uploadZone.classList.remove('dragover'); });
  });
  uploadZone.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && !busy) handleFile(f);
  });

  // ---- 校验 ----
  function validateFile(file) {
    const isVideo = (file.type && file.type.startsWith('video/')) || VIDEO_EXT_RE.test(file.name);
    if (!isVideo) return '这不是视频文件,请选择视频后再试';
    if (file.size > MAX_SIZE) return '视频太大(超过 200MB),请换一个小的再试';
    return null;
  }

  /* 用浏览器探测时长(拿不到元数据就跳过,ffmpeg 仍可处理 mkv 等) */
  function probeDuration(file, timeoutMs = 3000) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.preload = 'metadata';
      let done = false;
      const finish = (d) => { if (!done) { done = true; URL.revokeObjectURL(url); resolve(d); } };
      v.onloadedmetadata = () => finish(v.duration);
      v.onerror = () => finish(null);
      v.src = url;
      setTimeout(() => finish(null), timeoutMs);
    });
  }

  // ---- 主流程 ----
  async function handleFile(file) {
    const err = validateFile(file);
    if (err) { showError(err); return; }
    clearError();

    // 时长校验(异步,探测不到就放行)
    const duration = await probeDuration(file);
    if (duration != null && duration > MAX_DURATION) {
      showError('视频太长(超过 3 分钟),请剪辑短一点再试');
      return;
    }

    busy = true;
    cancelled = false;
    currentFile = file;
    resultsSection.classList.add('hidden');
    progressPanel.classList.remove('hidden');
    cancelBtn.classList.remove('hidden');
    uploadZone.classList.add('disabled');
    downloadBtn.disabled = true;
    revokeResultUrl();

    try {
      // 阶段一:加载引擎(首次 ~31MB,之后浏览器缓存了 wasm? blob URL 每次都要重新下载,
      // 但浏览器 HTTP 缓存会命中 CDN 请求,实际秒回)
      progressTitle.textContent = '加载处理引擎';
      setProgress(0, '首次使用需下载处理引擎(约 31MB),请稍候…');
      const onLoadProgress = (received, total) => {
        if (cancelled) return;
        const pct = total ? Math.min(99, Math.round((received / total) * 100)) : 0;
        setProgress(pct, '下载处理引擎中… ' + formatSize(received) + (total ? ' / ' + formatSize(total) : ''));
      };
      await loadEngine(onLoadProgress);

      // 阶段二:处理
      progressTitle.textContent = '正在全损化…';
      setProgress(0, '正在处理视频(全损画质 + 收音机烂音)…');
      const onProgress = (p) => {
        if (cancelled) return;
        const pct = Math.max(0, Math.min(99, Math.round((p || 0) * 100)));
        setProgress(pct, '正在处理视频… ' + pct + '%');
      };
      resultBlob = await fryVideo(file, { onProgress });

      if (cancelled) return;

      // 完成:渲染结果
      setProgress(100, '完成!');
      progressTitle.textContent = '处理完成';
      cancelBtn.classList.add('hidden');

      const savedPct = file.size > 0 ? Math.max(0, Math.round((1 - resultBlob.size / file.size) * 100)) : 0;
      sizeCompare.innerHTML = '体积:<span class="size-old">' + formatSize(file.size) + '</span> → <strong>' +
        formatSize(resultBlob.size) + '</strong>' + (savedPct > 0 ? '(缩小 ' + savedPct + '%)' : '');

      origUrl = URL.createObjectURL(file);
      origVideo.src = origUrl;
      resultUrl = URL.createObjectURL(resultBlob);
      friedVideo.src = resultUrl;
      downloadBtn.disabled = false;
      resultsSection.classList.remove('hidden');
      progressPanel.classList.add('hidden');
      positionButtons();
    } catch (e) {
      if (cancelled) return;
      console.error(e);
      showError('处理失败:' + (e && e.message ? e.message : '未知错误') + '。可能原因:网络问题、视频格式不支持或设备内存不足,请换更短的视频再试。');
    } finally {
      if (cancelled) resetAfterCancel();
      busy = false;
      uploadZone.classList.remove('disabled');
      cancelBtn.classList.add('hidden');
      cancelBtn.disabled = false;
    }
  }

  // ---- 取消 ----
  function resetAfterCancel() {
    terminateEngine(); // 终止后实例不可复用,下次自动重新加载
    setProgress(0, '已取消');
    progressTitle.textContent = '已取消';
    currentFile = null;
  }

  cancelBtn.addEventListener('click', () => {
    cancelled = true;
    cancelBtn.disabled = true;
    terminateEngine();
  });

  function formatTime(sec) {
    sec = Math.round(sec || 0);
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? m + ':' + String(s).padStart(2, '0') : s + 's';
  }

  // ---- 双视频互斥播放:播放一个自动暂停另一个,防同时出声 ----
  const videos = [origVideo, friedVideo];
  videos.forEach((v) => {
    const other = v === origVideo ? friedVideo : origVideo;
    v.addEventListener('play', () => {
      other.pause();
    });
    // 分辨率 + 时长角标
    v.addEventListener('loadedmetadata', () => {
      const el = v === origVideo ? origMeta : friedMeta;
      if (v.videoWidth && v.videoHeight) {
        el.textContent = v.videoWidth + '×' + v.videoHeight + ' · ' + formatTime(v.duration);
      }
    });
  });

  /* 设备判断:手机=触屏窄屏;桌面 Chrome 也支持 share,必须用 IS_MOBILE 守卫,否则桌面误弹分享面板 */
  const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 0 && window.innerWidth < 768);

  /* 主次按钮:按设备分开设计 —— 手机只推"保存到相册",桌面只显示"下载" */
  function positionButtons() {
    if (IS_MOBILE) {
      // 手机:保存到相册(主)+ 下载到文件(次)
      saveBtn.classList.remove('hidden');
      saveBtn.classList.add('btn-primary');
      saveBtn.classList.remove('btn-ghost');
      downloadBtn.classList.add('btn-ghost');
      downloadBtn.classList.remove('btn-primary');
      downloadBtn.textContent = '⬇ 下载到文件';
      actionsRow.appendChild(saveBtn);
      actionsRow.appendChild(downloadBtn);
      actionsHint.textContent = '推荐存相册,直接进手机照片库';
    } else {
      // 桌面:只有下载,隐藏相册按钮(桌面没有相册概念)
      saveBtn.classList.add('hidden');
      downloadBtn.classList.add('btn-primary');
      downloadBtn.classList.remove('btn-ghost');
      downloadBtn.textContent = '⬇ 下载全损视频';
      actionsRow.appendChild(downloadBtn);
      actionsHint.textContent = '';
    }
  }

  // ---- 下载(保存到文件) ----
  function triggerDownload() {
    if (!resultBlob) return;
    const base = (currentFile && currentFile.name) ? currentFile.name.replace(/\.\w+$/, '') : 'video';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(resultBlob);
    a.download = base + '_全损.mp4';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  downloadBtn.addEventListener('click', triggerDownload);

  // ---- 保存到相册(仅手机):Web Share API,弹系统分享面板选"存储到照片/视频" ----
  saveBtn.addEventListener('click', async () => {
    if (!resultBlob) return;
    // 桌面不弹分享(桌面无相册概念),按钮在桌面已隐藏,这里双保险
    if (!IS_MOBILE) { triggerDownload(); return; }
    const base = (currentFile && currentFile.name) ? currentFile.name.replace(/\.\w+$/, '') : 'video';
    const file = new File([resultBlob], base + '_全损.mp4', { type: 'video/mp4' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: '全损视频' });
        return; // 用户选了"存储到照片"或分享给了朋友,完成
      } catch (e) {
        if (e && e.name === 'AbortError') return; // 用户取消分享
        // 其他错误(如网络):回退到普通下载
      }
    }
    triggerDownload();
  });
})();
