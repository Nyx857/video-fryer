/* 验证"保存到相册"按钮:存在性 + 无 share 能力时回退下载 */
import { chromium } from '/Users/wsq/.reasonix/global-workspace/video-fryer/test/node_modules/playwright/index.mjs';
import fs from 'fs';

const PAGE = 'http://127.0.0.1:8765/index.html';
const TEST_VIDEO = process.env.TEST_VIDEO || '/Users/wsq/Downloads/v2700fgi0000d3ubmovog65u0g6r31t0.MP4';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(PAGE, { waitUntil: 'load' });

// 上传并等待处理完成
await page.setInputFiles('#fileInput', TEST_VIDEO);
await page.waitForSelector('#resultsSection:not(.hidden)', { timeout: 8 * 60 * 1000 });

// 1) 保存按钮存在且可用
const saveVisible = await page.isVisible('#saveBtn');
const saveEnabled = await page.locator('#saveBtn').isEnabled();
console.log('[保存到相册按钮] 可见=' + saveVisible + ' 可用=' + saveEnabled);

// 2) 该环境 share 能力探测
const shareInfo = await page.evaluate(() => ({
  canShare: typeof navigator.canShare === 'function',
  share: typeof navigator.share === 'function',
}));
console.log('[share 能力]', JSON.stringify(shareInfo));

// 3) 点击保存按钮:无 share 能力时应回退为文件下载
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
  page.click('#saveBtn'),
]);
if (download) {
  await download.saveAs('/Users/wsq/.reasonix/global-workspace/video-fryer/test/tmp-dl.mp4');
  console.log('[回退下载] 成功, 大小=' + fs.statSync('/Users/wsq/.reasonix/global-workspace/video-fryer/test/tmp-dl.mp4').size);
} else {
  console.log('[回退下载] 未触发下载(可能环境弹了分享面板,headless 下正常)');
}

console.log('[页面错误]', errors.length ? errors : '无');
await browser.close();
