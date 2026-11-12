import { readFile } from 'node:fs/promises';
import { listen } from '../src/http.mjs';
import { createHash } from 'node:crypto';
export async function startFixture() {

  const bills=[{id:'BILL-A',voyage:'V001',version:1},{id:'BILL-B',voyage:'V002',version:1}];
  const contents=Object.fromEntries(bills.map(row=>[row.id,Buffer.from('%PDF-1.4\n'+row.id+' synthetic document\n%%EOF')]));
  async function route(url){
    if(url.pathname==='/bills')return {body:bills};
    if(url.pathname==='/preview'){const id=url.searchParams.get('id');if(!contents[id])return {status:404,body:{}};const sha=createHash('sha256').update(contents[id]).digest('hex');return {type:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><main data-ready="true" data-document="${id}" data-sha256="${sha}"><h1>${id}</h1><a href="/download?id=${id}" download="document.pdf">领取附件</a><button onclick="setTimeout(()=>document.querySelector('a').click(),250)">延后领取</button></main>`};}
    if(url.pathname==='/download'){const id=url.searchParams.get('id');return contents[id]?{type:'application/pdf',headers:{'content-disposition':'attachment; filename="document.pdf"'},body:contents[id]}:{status:404,body:{}};}
    return {status:404,body:{}};
  }

  return listen(async (url, request) => {
    if (url.pathname === '/app.js') return { type: 'text/javascript; charset=utf-8', body: await readFile(new URL('../portal/app.js', import.meta.url), 'utf8') };
    if (url.pathname === '/') return { type: 'text/html; charset=utf-8', body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>业务演练门户</title><style>body{font:18px sans-serif;padding:24px}button{padding:8px;margin:6px}table{border-collapse:collapse}td,th{border:1px solid #aaa;padding:10px}.lane{border:2px solid #888;display:inline-block;vertical-align:top;min-height:220px;width:240px;padding:12px}.card{border:1px solid #777;padding:12px;margin:8px;background:#eef}#status{white-space:pre-wrap}</style><main id="app"></main><pre id="status"></pre><script src="/app.js"></script></html>` };
    return route(url, request);
  });
}
