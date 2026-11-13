import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const KEY_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
const checkKey = key => { if (!KEY_PATTERN.test(key)) throw new Error('业务键无效'); };

// 领取台账：记录每票单据的领取状态、摘要、失败原因与冲突保留。
// 台账文件与附件存放在数据目录的 collection/ 子目录，与单次查看回执互不干扰。
export class CollectionLedger {
  constructor(directory) {
    this.directory = join(directory, 'collection');
    this.bills = join(this.directory, 'bills');
    this.file = join(this.directory, 'ledger.json');
    this.entries = {};
  }
  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (data?.entries && typeof data.entries === 'object') this.entries = data.entries;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`台账读取失败: ${error.message}`);
    }
    return this;
  }
  async save() {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}`;
    await writeFile(temporary, JSON.stringify({ version: 1, entries: this.entries }, null, 2), { flag: 'wx' });
    await rename(temporary, this.file);
  }
  entry(key) { return this.entries[key]; }
  async fileStat(key) {
    checkKey(key);
    try {
      const bytes = await readFile(join(this.bills, `${key}.pdf`));
      return { sha256: sha256(bytes), bytes: bytes.length };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  // 恢复时核对：台账标记已领取的票，文件必须存在且摘要一致。
  async verifyCollected(key) {
    const entry = this.entries[key];
    if (entry?.status !== 'collected') return 'not-collected';
    const stat = await this.fileStat(key);
    if (!stat) return 'missing';
    return stat.sha256 === entry.sha256 ? 'verified' : 'mismatch';
  }
  // 存放已核实的附件。同名不同内容的既有文件不覆盖，改名保留并登记冲突。
  async storeVerified(key, bytes) {
    checkKey(key);
    await mkdir(this.bills, { recursive: true });
    const digest = sha256(bytes);
    const target = join(this.bills, `${key}.pdf`);
    const existing = await this.fileStat(key);
    let conflict = null;
    if (existing) {
      if (existing.sha256 === digest) return { merged: true, digest };
      conflict = `${key}.unverified-${existing.sha256.slice(0, 8)}.pdf`;
      await rename(target, join(this.bills, conflict));
      this.recordConflict(key, conflict, existing.sha256);
    }
    const temporary = `${target}.${randomUUID()}`;
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, target);
    return { merged: false, digest, conflict };
  }
  recordConflict(key, kept, keptSha256) {
    const entry = (this.entries[key] ??= { key, status: 'pending', attempts: 0 });
    (entry.conflicts ??= []).push({ kept: `bills/${kept}`, sha256: keptSha256, at: new Date().toISOString() });
  }
  // 人工补领合并：既有文件摘要与预览声明一致时直接采纳，不再下载。
  async adoptIfMatches(key, declaredSet) {
    const stat = await this.fileStat(key);
    if (!stat || ![...declaredSet].includes(stat.sha256)) return false;
    const prior = this.entries[key];
    this.markCollected(key, {
      sha256: stat.sha256,
      declaredSha256: stat.sha256,
      contentType: prior?.contentType ?? null,
      bytes: stat.bytes,
      source: prior?.status === 'collected' ? prior.source : 'manual-merge',
    });
    return true;
  }
  markCollected(key, { sha256, declaredSha256, contentType, bytes, source }) {
    checkKey(key);
    const prior = this.entries[key];
    this.entries[key] = {
      ...prior,
      key,
      status: 'collected',
      sha256,
      declaredSha256,
      contentType,
      file: `bills/${key}.pdf`,
      bytes,
      source,
      attempts: (prior?.attempts ?? 0) + 1,
      collectedAt: new Date().toISOString(),
      failure: null,
    };
  }
  markFailed(key, reason) {
    checkKey(key);
    const prior = this.entries[key];
    this.entries[key] = {
      ...prior,
      key,
      status: 'failed',
      attempts: (prior?.attempts ?? 0) + 1,
      failure: { reason, at: new Date().toISOString() },
    };
  }
}
