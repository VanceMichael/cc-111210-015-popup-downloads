import { listen } from './http.mjs';
import { inspect } from './connector.mjs';
import { ReceiptStore } from './store.mjs';
import { collectBills } from './collector.mjs';
import { CollectionLedger } from './ledger.mjs';

export async function startService({ source, directory, port = 0 }) {
  const store = new ReceiptStore(directory);
  let running = null;
  return listen(async url => {
    if (url.pathname === '/health') return { body: { state: 'ready' } };
    if (url.pathname === '/inspect') {
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: result };
    }
    if (url.pathname === '/receive') {
      const key = url.searchParams.get('key') ?? 'single';
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: await store.save(key, result) };
    }
    if (url.pathname === '/collect') {
      if (running) return { status: 409, body: { error: '批量领取进行中，请稍后查询台账' } };
      const keys = url.searchParams.get('keys')?.split(',').map(item => item.trim()).filter(Boolean);
      running = collectBills({ base: source, directory, keys });
      try {
        return { body: await running };
      } finally {
        running = null;
      }
    }
    if (url.pathname === '/ledger') {
      const ledger = await new CollectionLedger(directory).load();
      return { body: ledger.entries };
    }
    if (url.pathname.startsWith('/receipts/')) return { body: await store.read(url.pathname.split('/').pop()) };
    return { status: 404, body: { error: '接口不存在' } };
  }, port);
}
