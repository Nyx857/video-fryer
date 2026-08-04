/* 验证按钮按设备分开设计:桌面只显示下载;手机显示保存到相册(主)+下载(次) */
import { chromium } from '/Users/wsq/.reasonix/global-workspace/video-fryer/test/node_modules/playwright/index.mjs';

const PAGE = 'http://127.0.0.1:8765/index.html';
const TEST_VIDEO = '/Users/wsq/.reasonix/global-workspace/video-fryer/test/fixtures/test.mp4';

async function run(ua, viewport, label) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: ua, viewport });
  const page = await ctx.newPage();
  await page.goto(PAGE, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', TEST_VIDEO);
  await page.waitForSelector('#resultsSection:not(.hidden)', { timeout: 8 * 60 * 1000 });

  const s = await page.evaluate(() => {
    const row = document.getElementById('actionsRow');
    const saveBtn = document.getElementById('saveBtn');
    const dlBtn = document.getElementById('downloadBtn');
    return {
      order: Array.from(row.children).filter((b) => !b.classList.contains('hidden')).map((b) => b.id),
      saveHidden: saveBtn.classList.contains('hidden'),
      savePrimary: saveBtn.classList.contains('btn-primary'),
      dlPrimary: dlBtn.classList.contains('btn-primary'),
      dlText: dlBtn.textContent.trim(),
      saveText: saveBtn.textContent.trim(),
      hint: document.getElementById('actionsHint').textContent,
    };
  });
  console.log(`[${label}]`);
  console.log(`  可见按钮顺序: ${s.order.join(' → ')}`);
  console.log(`  保存按钮: ${s.saveHidden ? '隐藏' : '显示'} | 文案="${s.saveText}" | 主样式=${s.savePrimary}`);
  console.log(`  下载按钮: 文案="${s.dlText}" | 主样式=${s.dlPrimary}`);
  console.log(`  提示: "${s.hint}"`);
  await browser.close();
}

await run(
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
  { width: 1280, height: 800 },
  '桌面 Chrome'
);
await run(
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  { width: 390, height: 844 },
  '手机 iPhone Safari'
);
