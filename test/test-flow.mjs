/* 实测脚本:打开页面 → 上传测试视频 → 等待处理完成 → 验证结果 → 下载
 * 用法: PATH=/opt/homebrew/bin:$PATH node test/test-flow.mjs
 */
import { chromium } from '/Users/wsq/.reasonix/global-workspace/video-fryer/test/node_modules/playwright/index.mjs';
import fs from 'fs';

const PAGE = 'http://127.0.0.1:8765/index.html';
const TEST_VIDEO = process.env.TEST_VIDEO || '/Users/wsq/.reasonix/global-workspace/video-fryer/test/fixtures/test.mp4';
const OUT_MP4 = '/tmp/video-fryer-test/out.mp4';
const SHOT_DIR = '/tmp/video-fryer-test/shots';
const STAGE_TIMEOUT = 8 * 60 * 1000; // 引擎下载 + 处理,上限 8 分钟

fs.mkdirSync(SHOT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

console.log('[1] 打开页面');
await page.goto(PAGE, { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(800);
await page.screenshot({ path: SHOT_DIR + '/01-initial.png' });

// 检查标题与上传区
const title = await page.title();
const uploadVisible = await page.isVisible('#uploadZone');
console.log(`[2] 标题=${title} 上传区可见=${uploadVisible}`);

// 上传文件
console.log('[3] 上传测试视频');
await page.setInputFiles('#fileInput', TEST_VIDEO);

// 等待引擎加载(进度面板出现)
await page.waitForSelector('#progressPanel:not(.hidden)', { timeout: 15000 });
await page.waitForTimeout(1500);
console.log('[4] 进度面板出现,等待引擎加载 + 处理…');
await page.screenshot({ path: SHOT_DIR + '/02-progress.png' });

// 等待结果区出现
try {
  await page.waitForSelector('#resultsSection:not(.hidden)', { timeout: STAGE_TIMEOUT });
  console.log('[5] 处理完成,结果区可见');
} catch (e) {
  // 失败时抓取当前错误信息
  const err = await page.locator('#errorText').textContent().catch(() => '(无错误文本)');
  const prog = await page.locator('#progressText').textContent().catch(() => '');
  console.log('[5-FAIL] 超时未完成。errorText=' + err + ' progressText=' + prog);
  await page.screenshot({ path: SHOT_DIR + '/03-failed.png' });
  console.log('CONSOLE_ERRORS:', JSON.stringify(consoleErrors, null, 2));
  await browser.close();
  process.exit(1);
}

await page.waitForTimeout(800);
await page.screenshot({ path: SHOT_DIR + '/04-result.png' });

// 验证结果内容
const sizeCompare = await page.locator('#sizeCompare').textContent();
const downloadEnabled = await page.locator('#downloadBtn').isEnabled();
console.log(`[6] 体积对比: ${sizeCompare.trim()}`);
console.log(`[7] 下载按钮可用: ${downloadEnabled}`);

// 验证两个 video 都能加载
const vidState = await page.evaluate(() => {
  const ov = document.getElementById('origVideo');
  const fv = document.getElementById('friedVideo');
  return {
    origSrc: ov.src ? ov.src.slice(0, 40) : '(空)',
    friedSrc: fv.src ? fv.src.slice(0, 40) : '(空)',
    friedReady: fv.readyState,
  };
});
console.log('[8] 视频源:', JSON.stringify(vidState));

// 下载
console.log('[9] 点击下载');
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }),
  page.click('#downloadBtn'),
]);
await download.saveAs(OUT_MP4);
const size = fs.statSync(OUT_MP4).size;
console.log(`[10] 下载成功: ${OUT_MP4} (${(size / 1024).toFixed(1)} KB)`);

// 检查 MP4 文件头
const head = fs.readFileSync(OUT_MP4).subarray(4, 8).toString();
console.log(`[11] 文件类型标识(ftyp): ${head}`);

console.log('CONSOLE_ERRORS:', JSON.stringify(consoleErrors, null, 2));
await browser.close();
console.log('DONE');
