import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startFixture } from '../fixtures/source.mjs';
import { startService } from './service.mjs';
import { collectBills } from './collector.mjs';
import { CollectionLedger, sha256 } from './ledger.mjs';

const directory = await mkdtemp(join(tmpdir(), 'collect-demo-'));
const source = await startFixture();
const service = await startService({ source: source.url, directory });
const control = behavior => fetch(source.url + '/fixture/control', {
  method: 'POST',
  body: JSON.stringify(behavior),
}).then(response => response.json());
const ledger = () => new CollectionLedger(directory).load();
const billsDirectory = join(directory, 'collection', 'bills');
const show = (title, events) => {
  console.log(`\n=== ${title} ===`);
  for (const event of events) {
    console.log(' ', event.at.slice(11, 23), event.type, event.key ?? '',
      event.filename ?? '', event.reason ?? event.result ?? event.source ?? event.kept ?? '');
  }
};

try {
  // 场景一：两个同名 document.pdf 交错到达，窗口复用，旧预览页延后触发下载。
  // BILL-B 的下载被延缓；另一窗口里遗留的 BILL-A 预览页在 250 毫秒后才触发下载，
  // 它到达时正在处理 BILL-B，但只能按证据归入 BILL-A。
  await control({ drip: { 'BILL-B': 2500 } });
  const first = await collectBills({
    base: source.url,
    directory,
    prepare: async session => {
      const stray = await session.context.newPage();
      await stray.goto(`${source.url}/preview?id=BILL-A&drip=1200`);
      await stray.locator('[data-ready="true"]').waitFor();
      await stray.getByText('延后领取').click();
    },
  });
  show('场景一：同名附件交错到达 / 窗口复用 / 旧预览页延后下载', first.events);
  assert.equal(first.entries['BILL-A'].status, 'collected');
  assert.equal(first.entries['BILL-B'].status, 'collected');
  assert.notEqual(first.entries['BILL-A'].sha256, first.entries['BILL-B'].sha256);
  assert.ok(first.events.some(event => event.type === '预览窗口复用'));

  // 场景二：预览窗口半途关闭。先模拟上一轮 BILL-B 领取不完整。
  let current = await ledger();
  delete current.entries['BILL-B'];
  await current.save();
  await rm(join(billsDirectory, 'BILL-B.pdf'), { force: true });
  await control({ autoclose: { 'BILL-B': 60 } });
  const second = await (await fetch(service.url + '/collect?keys=BILL-B')).json();
  show('场景二：预览窗口半途关闭后重试恢复', second.events);
  assert.equal(second.entries['BILL-B'].status, 'collected');

  // 场景三：门户提示阻止点击，记录失败原因，提示解除后可恢复。
  current = await ledger();
  delete current.entries['BILL-A'];
  await current.save();
  await rm(join(billsDirectory, 'BILL-A.pdf'), { force: true });
  await control({ prompt: { 'BILL-A': true } });
  const blocked = await (await fetch(service.url + '/collect?keys=BILL-A')).json();
  show('场景三：门户提示阻止领取', blocked.events);
  assert.equal(blocked.entries['BILL-A'].status, 'failed');
  await control({});
  const recovered = await (await fetch(service.url + '/collect?keys=BILL-A')).json();
  assert.equal(recovered.entries['BILL-A'].status, 'collected');

  // 场景四：恢复核对、人工补领合并、不同内容不覆盖。
  const skipped = await (await fetch(service.url + '/collect')).json();
  show('场景四a：恢复核对一致后跳过', skipped.events);
  assert.ok(skipped.results.every(result => result.skipped));

  current = await ledger();
  delete current.entries['BILL-A'];
  await current.save();
  const manual = await (await fetch(service.url + '/collect?keys=BILL-A')).json();
  show('场景四b：人工补领的文件经预览声明核对后合并', manual.events);
  assert.equal(manual.results[0].merged, true);
  assert.ok(!manual.events.some(event => event.type === '下载已归属'));

  const foreign = Buffer.from('%PDF-1.4\nmanual unverified content\n%%EOF');
  current = await ledger();
  delete current.entries['BILL-B'];
  await current.save();
  await writeFile(join(billsDirectory, 'BILL-B.pdf'), foreign);
  const conflict = await (await fetch(service.url + '/collect?keys=BILL-B')).json();
  show('场景四c：不同内容保留不覆盖', conflict.events);
  const kept = (await readdir(billsDirectory)).find(name => name.startsWith('BILL-B.unverified-'));
  assert.ok(kept, '不同内容的既有文件应改名保留');
  assert.equal((await readFile(join(billsDirectory, kept))).toString(), foreign.toString());
  assert.equal(conflict.entries['BILL-B'].conflicts.length, 1);

  const final = await ledger();
  console.log('\n=== 最终台账 ===');
  console.log(JSON.stringify(final.entries, null, 2));
  console.log('\n附件目录:', await readdir(billsDirectory));
  console.log('台账校验: BILL-A', await final.verifyCollected('BILL-A'), '| BILL-B', await final.verifyCollected('BILL-B'));
} finally {
  await service.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
