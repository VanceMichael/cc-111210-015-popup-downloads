import { readFile } from 'node:fs/promises';
import { openBrowser } from './browser.mjs';
import { CollectionLedger, sha256 } from './ledger.mjs';

const KEY_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
const PREVIEW_PATH = '/preview';
const DOWNLOAD_PATH = '/download';
const PDF_TYPE = 'application/pdf';

// 批量领取：通过真实 Chromium 页面逐票操作门户。
// 归属只认证据链：列表业务键 → 打开的窗口（页面对象）→ 预览声明的单据标识与摘要 →
// 该窗口触发的下载事件 → 下载字节的摘要。窗口序号与文件名不参与归属判断。
export async function collectBills({ base, directory, keys, timeoutMs = 8000, prepare, onEvent }) {
  const origin = new URL(base).origin;
  const ledger = await new CollectionLedger(directory).load();
  const events = [];
  const log = (type, detail = {}) => {
    const event = { at: new Date().toISOString(), type, ...detail };
    events.push(event);
    onEvent?.(event);
  };
  const session = await openBrowser(base);
  const declarations = new Map();
  const waiters = new Map();
  const completions = [];
  const pages = new Set();
  const navigatedAt = new Map();

  const readDeclaration = async page => {
    if (page.isClosed()) return;
    let url;
    try { url = new URL(page.url()); } catch { return; }
    if (url.origin !== origin || url.pathname !== PREVIEW_PATH) return;
    const declared = await page.evaluate(() => {
      const main = document.querySelector('main[data-document][data-sha256]');
      return main ? { document: main.dataset.document, sha256: main.dataset.sha256 } : null;
    }).catch(() => null);
    if (!declared) return;
    if (!declarations.has(declared.document)) declarations.set(declared.document, new Set());
    const set = declarations.get(declared.document);
    if (!set.has(declared.sha256)) {
      set.add(declared.sha256);
      log('预览声明', { key: declared.document, sha256: declared.sha256 });
    }
  };

  const fetchContentType = async url => {
    try {
      const head = await session.context.request.head(url, { timeout: 5000 });
      const type = head.headers()['content-type'];
      if (type) return type;
    } catch { /* 门户不支持HEAD时改用GET核对 */ }
    try {
      const get = await session.context.request.get(url, { timeout: 5000 });
      return get.headers()['content-type'] ?? '';
    } catch { return ''; }
  };

  // 下载事件归属：只依据下载来源页、地址中的单据标识与内容摘要，不看窗口序号和文件名。
  // 旧预览页延后触发的下载同样走这条证据链，绝不会归到当前正在处理的行。
  const handleDownload = async (page, download) => {
    const url = download.url();
    const filename = download.suggestedFilename();
    let id = null;
    try {
      const parsed = new URL(url);
      if (parsed.origin !== origin || parsed.pathname !== DOWNLOAD_PATH) {
        log('外来下载被拒绝', { url, filename });
        return;
      }
      id = parsed.searchParams.get('id');
    } catch {
      log('下载地址无法解析', { url, filename });
      return;
    }
    if (!id || !KEY_PATTERN.test(id)) {
      log('下载缺少有效单据标识', { url, filename });
      return;
    }
    const failure = await download.failure();
    if (failure) {
      log('下载中断', { key: id, failure, filename });
      waiters.get(id)?.notify({ ok: false, reason: `下载中断: ${failure}` });
      return;
    }
    const bytes = await readFile(await download.path());
    await download.delete().catch(() => {});
    const digest = sha256(bytes);
    await readDeclaration(page);
    const declared = declarations.get(id);
    if (!declared) {
      log('下载无法归属', { key: id, sha256: digest, filename, reason: '缺少预览声明' });
      waiters.get(id)?.notify({ ok: false, reason: '缺少预览声明，拒绝归属' });
      return;
    }
    if (!declared.has(digest)) {
      log('下载无法归属', { key: id, sha256: digest, filename, reason: '内容与预览声明不符' });
      waiters.get(id)?.notify({ ok: false, reason: '内容与预览声明不符' });
      return;
    }
    const contentType = await fetchContentType(url);
    if (!contentType.toLowerCase().includes(PDF_TYPE)) {
      log('内容类型不符', { key: id, contentType, filename });
      waiters.get(id)?.notify({ ok: false, reason: `内容类型不符: ${contentType || '未知'}` });
      return;
    }
    const stored = await ledger.storeVerified(id, bytes);
    if (stored.conflict) log('保留不同内容', { key: id, kept: stored.conflict });
    const prior = ledger.entry(id);
    ledger.markCollected(id, {
      sha256: digest,
      declaredSha256: digest,
      contentType,
      bytes: bytes.length,
      source: waiters.has(id) ? 'auto' : prior?.status === 'collected' ? prior.source : 'stray',
    });
    await ledger.save();
    log(stored.merged ? '重复领取，内容一致' : '下载已归属', {
      key: id, sha256: digest, filename, source: ledger.entry(id).source,
    });
    waiters.get(id)?.notify({ ok: true, key: id, sha256: digest });
  };

  const trackPage = page => {
    if (pages.has(page)) return;
    pages.add(page);
    navigatedAt.set(page, Date.now());
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigatedAt.set(page, Date.now()); });
    page.on('download', download => {
      const completion = handleDownload(page, download)
        .catch(error => log('下载处理异常', { message: error.message }));
      completions.push(completion);
    });
    page.on('dialog', dialog => {
      log('门户对话框', { message: dialog.message() });
      dialog.accept().catch(() => {});
    });
    page.on('domcontentloaded', () => { readDeclaration(page).catch(() => {}); });
    page.on('close', () => log('窗口关闭', { url: page.url() }));
    readDeclaration(page).catch(() => {});
  };

  // 预览窗口可能被复用（同名窗口不再触发popup事件），也可能每次新开。
  // 统一轮询所有已跟踪页面，按预览DOM中的单据标识匹配，优先取最近导航的窗口。
  const waitForPreview = async (key, windowMs) => {
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      let best = null;
      for (const page of pages) {
        if (page.isClosed()) continue;
        try {
          const url = new URL(page.url());
          if (url.origin !== origin || url.pathname !== PREVIEW_PATH) continue;
          const matches = await page.evaluate(
            expected => document.querySelector('main[data-ready="true"]')?.dataset.document === expected, key,
          ).catch(() => false);
          if (!matches) continue;
          const when = navigatedAt.get(page) ?? 0;
          if (!best || when > best.when) best = { page, when };
        } catch { /* 页面正在跳转，下一轮再试 */ }
      }
      if (best) {
        await readDeclaration(best.page);
        return best.page;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return null;
  };

  const requestDownload = async (key, preview) => {
    let notify;
    const outcome = new Promise(resolve => {
      const timer = setTimeout(() => {
        waiters.delete(key);
        resolve({ ok: false, reason: '下载未在限定时间内到达或被阻止' });
      }, timeoutMs);
      notify = value => { clearTimeout(timer); waiters.delete(key); resolve(value); };
      waiters.set(key, { notify });
    });
    try {
      await preview.locator('a[download]').click({ timeout: Math.min(Math.max(timeoutMs - 500, 500), 4000) });
    } catch (error) {
      const reason = /closed/i.test(error.message)
        ? '预览窗口中途关闭'
        : error.name === 'TimeoutError'
          ? '门户提示阻止了领取点击'
          : `领取点击失败: ${error.message.split('\n')[0]}`;
      notify({ ok: false, reason });
    }
    return outcome;
  };

  const collectOne = async key => {
    if (!KEY_PATTERN.test(key)) {
      log('领取失败', { key, reason: '业务键无效' });
      return { key, status: 'failed', reason: '业务键无效' };
    }
    if (!rows.includes(key)) {
      ledger.markFailed(key, '列表中不存在该业务键');
      await ledger.save();
      log('领取失败', { key, reason: '列表中不存在该业务键' });
      return { key, status: 'failed', reason: '列表中不存在该业务键' };
    }
    if (ledger.entry(key)?.status === 'collected') {
      const check = await ledger.verifyCollected(key);
      if (check === 'verified') {
        log('恢复核对', { key, result: '文件与台账一致，跳过' });
        return { key, status: 'collected', skipped: true };
      }
      log('恢复核对', { key, result: `记录与文件不符（${check}），重新领取` });
    }
    let lastReason = '未知原因';
    for (let attempt = 1; attempt <= 2; attempt++) {
      log('开始领取', { key, attempt });
      const known = new Set(pages);
      try {
        await session.page.locator(`[data-open="${key}"]`).click({ timeout: 4000 });
      } catch (error) {
        lastReason = error.name === 'TimeoutError'
          ? '列表点击被门户提示阻止'
          : `列表点击失败: ${error.message.split('\n')[0]}`;
        log('领取异常', { key, attempt, reason: lastReason });
        continue;
      }
      const preview = await waitForPreview(key, Math.min(timeoutMs, 4000));
      if (!preview) {
        lastReason = '预览未出现，点击可能被门户提示阻止';
        log('领取异常', { key, attempt, reason: lastReason });
        continue;
      }
      log(known.has(preview) ? '预览窗口复用' : '预览新窗口', { key });
      const declared = declarations.get(key);
      if (!declared) {
        lastReason = '预览未声明单据摘要';
        log('领取异常', { key, attempt, reason: lastReason });
        continue;
      }
      if (await ledger.adoptIfMatches(key, declared)) {
        log('人工补领合并', { key, sha256: ledger.entry(key).sha256 });
        await ledger.save();
        return { key, status: 'collected', merged: true };
      }
      const outcome = await requestDownload(key, preview);
      if (outcome.ok) {
        log('领取成功', { key, sha256: outcome.sha256 });
        return { key, status: 'collected' };
      }
      lastReason = outcome.reason;
      log('领取异常', { key, attempt, reason: lastReason });
    }
    ledger.markFailed(key, lastReason);
    await ledger.save();
    log('领取失败', { key, reason: lastReason });
    return { key, status: 'failed', reason: lastReason };
  };

  let rows;
  try {
    for (const page of session.context.pages()) trackPage(page);
    session.context.on('page', trackPage);
    rows = await session.page.locator('[data-bill]').evaluateAll(
      elements => elements.map(element => element.getAttribute('data-key')),
    );
    log('列表读取', { keys: rows });
    if (prepare) await prepare(session);
    const requested = [...new Set(keys?.length ? keys : rows)];
    const results = [];
    for (const key of requested) results.push(await collectOne(key));
    let settled = 0;
    while (settled < completions.length) {
      await Promise.all(completions.slice(settled));
      settled = completions.length;
    }
    await ledger.save();
    return { results, entries: ledger.entries, events };
  } finally {
    await session.close();
  }
}
