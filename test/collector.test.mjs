import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../fixtures/source.mjs';
import { collectBills } from '../src/collector.mjs';
import { CollectionLedger, sha256 } from '../src/ledger.mjs';
import { startService } from '../src/service.mjs';

const CONTENT_A = Buffer.from('%PDF-1.4\nBILL-A synthetic document\n%%EOF');
const CONTENT_B = Buffer.from('%PDF-1.4\nBILL-B synthetic document\n%%EOF');
const SHA_A = sha256(CONTENT_A);
const SHA_B = sha256(CONTENT_B);

const control = (source, behavior) => fetch(source.url + '/fixture/control', {
  method: 'POST',
  body: JSON.stringify(behavior),
}).then(response => response.json());
const billsDirectory = directory => join(directory, 'collection', 'bills');
const temporary = () => mkdtemp(join(tmpdir(), 'collect-'));

test('批量领取按证据归属同名附件，恢复时跳过一致文件', async () => {
  const source = await startFixture();
  const directory = await temporary();
  try {
    const first = await collectBills({ base: source.url, directory });
    assert.deepEqual(first.results.map(result => result.status), ['collected', 'collected']);
    assert.equal((await readFile(join(billsDirectory(directory), 'BILL-A.pdf'))).toString(), CONTENT_A.toString());
    assert.equal((await readFile(join(billsDirectory(directory), 'BILL-B.pdf'))).toString(), CONTENT_B.toString());
    assert.equal(first.entries['BILL-A'].sha256, SHA_A);
    assert.equal(first.entries['BILL-B'].sha256, SHA_B);
    assert.equal(first.entries['BILL-B'].contentType, 'application/pdf');
    // 两次下载文件名相同，归属只靠证据链
    const attributed = first.events.filter(event => event.type === '下载已归属');
    assert.deepEqual(attributed.map(event => event.filename), ['document.pdf', 'document.pdf']);
    // 第二次点击复用同一预览窗口
    assert.ok(first.events.some(event => event.type === '预览窗口复用' && event.key === 'BILL-B'));
    // 恢复：台账与文件一致则跳过，不再下载
    const again = await collectBills({ base: source.url, directory });
    assert.ok(again.results.every(result => result.skipped));
    assert.ok(!again.events.some(event => event.type === '下载已归属'));
    // 文件被篡改后重新领取
    await writeFile(join(billsDirectory(directory), 'BILL-A.pdf'), 'corrupted');
    const repaired = await collectBills({ base: source.url, directory, keys: ['BILL-A'] });
    assert.equal(repaired.results[0].status, 'collected');
    assert.equal((await readFile(join(billsDirectory(directory), 'BILL-A.pdf'))).toString(), CONTENT_A.toString());
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('旧预览页延后触发的下载不会归到当前选中行', async () => {
  const source = await startFixture();
  const directory = await temporary();
  try {
    await control(source, { drip: { 'BILL-B': 2000 } });
    const result = await collectBills({
      base: source.url,
      directory,
      keys: ['BILL-B'],
      prepare: async session => {
        const stray = await session.context.newPage();
        await stray.goto(`${source.url}/preview?id=BILL-A&drip=900`);
        await stray.locator('[data-ready="true"]').waitFor();
        await stray.getByText('延后领取').click();
      },
    });
    // 延后的 BILL-A 文件在 BILL-B 处理期间到达，只能按证据归入 BILL-A
    assert.equal(result.entries['BILL-A'].status, 'collected');
    assert.equal(result.entries['BILL-A'].source, 'stray');
    assert.equal(result.entries['BILL-A'].sha256, SHA_A);
    assert.equal(result.entries['BILL-B'].sha256, SHA_B);
    assert.equal((await readFile(join(billsDirectory(directory), 'BILL-B.pdf'))).toString(), CONTENT_B.toString());
    const beginB = result.events.findIndex(event => event.type === '开始领取' && event.key === 'BILL-B');
    const lateA = result.events.findIndex(event => event.type === '下载已归属' && event.key === 'BILL-A');
    const doneB = result.events.findIndex(event => event.type === '领取成功' && event.key === 'BILL-B');
    assert.ok(beginB < lateA && lateA < doneB, '延后下载应发生在BILL-B处理期间');
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('预览窗口半途关闭可重试恢复且不误归', async () => {
  const source = await startFixture();
  const directory = await temporary();
  try {
    await control(source, { autoclose: { 'BILL-B': 30 } });
    const result = await collectBills({ base: source.url, directory, keys: ['BILL-B'] });
    assert.equal(result.results[0].status, 'collected');
    assert.equal(result.entries['BILL-B'].sha256, SHA_B);
    assert.ok(result.events.some(event => event.type === '窗口关闭'));
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('门户提示阻止点击时记录失败原因，不标记已领取', async () => {
  const source = await startFixture();
  const directory = await temporary();
  try {
    await control(source, { prompt: { 'BILL-A': true } });
    const blocked = await collectBills({ base: source.url, directory, keys: ['BILL-A', 'BILL-B'], timeoutMs: 2500 });
    assert.equal(blocked.entries['BILL-A'].status, 'failed');
    assert.match(blocked.entries['BILL-A'].failure.reason, /阻止/);
    assert.equal(blocked.entries['BILL-B'].status, 'collected');
    await control(source, {});
    const recovered = await collectBills({ base: source.url, directory, keys: ['BILL-A', 'BILL-B'] });
    assert.equal(recovered.entries['BILL-A'].status, 'collected');
    assert.equal(recovered.entries['BILL-A'].sha256, SHA_A);
    assert.ok(recovered.results.find(result => result.key === 'BILL-B').skipped);
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('人工补领可合并，不同内容保留不覆盖', async () => {
  const source = await startFixture();
  const directory = await temporary();
  try {
    // 人工补领：文件已存在且与预览声明一致，直接合并不再下载
    const ledger = await new CollectionLedger(directory).load();
    await ledger.storeVerified('BILL-A', CONTENT_A);
    await ledger.save();
    const manual = await collectBills({ base: source.url, directory, keys: ['BILL-A'] });
    assert.equal(manual.results[0].merged, true);
    assert.equal(manual.entries['BILL-A'].source, 'manual-merge');
    assert.ok(!manual.events.some(event => event.type === '下载已归属'));
    // 不同内容的既有文件不覆盖，改名保留并登记冲突
    const foreign = Buffer.from('%PDF-1.4\nforeign manual content\n%%EOF');
    await writeFile(join(billsDirectory(directory), 'BILL-B.pdf'), foreign);
    const conflict = await collectBills({ base: source.url, directory, keys: ['BILL-B'] });
    assert.equal(conflict.entries['BILL-B'].status, 'collected');
    assert.equal(conflict.entries['BILL-B'].sha256, SHA_B);
    const kept = (await readdir(billsDirectory(directory))).find(name => name.startsWith('BILL-B.unverified-'));
    assert.ok(kept, '不同内容的既有文件应被保留');
    assert.equal((await readFile(join(billsDirectory(directory), kept))).toString(), foreign.toString());
    assert.equal(conflict.entries['BILL-B'].conflicts.length, 1);
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('服务提供批量领取与台账查询，进行中的领取不重复启动', async () => {
  const source = await startFixture();
  const directory = await temporary();
  const service = await startService({ source: source.url, directory });
  try {
    const [first, second] = await Promise.all([
      fetch(service.url + '/collect'),
      fetch(service.url + '/collect'),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    const collected = await first.json();
    assert.ok(collected.results.every(result => result.status === 'collected'));
    const ledger = await (await fetch(service.url + '/ledger')).json();
    assert.equal(ledger['BILL-A'].sha256, SHA_A);
    assert.equal(ledger['BILL-B'].sha256, SHA_B);
    // 原有查看接口不受影响
    assert.equal((await (await fetch(service.url + '/inspect')).json()).length, 2);
  } finally {
    await service.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});
