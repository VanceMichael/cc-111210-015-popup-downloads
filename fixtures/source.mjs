import { readFile } from 'node:fs/promises';
import { listen } from '../src/http.mjs';
import { createHash } from 'node:crypto';

// 演练控制只用于布置场景（延缓下载、半途关窗、门户提示），不参与批量领取。
const readBody = request => new Promise((resolve, reject) => {
  let data = '';
  request.on('data', chunk => { data += chunk; });
  request.on('end', () => resolve(data));
  request.on('error', reject);
});

export async function startFixture() {

  const bills=[{id:'BILL-A',voyage:'V001',version:1},{id:'BILL-B',voyage:'V002',version:1}];
  const contents=Object.fromEntries(bills.map(row=>[row.id,Buffer.from('%PDF-1.4\n'+row.id+' synthetic document\n%%EOF')]));
  const behavior={drip:{},autoclose:{},prompt:{}};
  async function route(url,request,response){
    if(url.pathname==='/bills')return {body:bills};
    if(url.pathname==='/preview'){
      const id=url.searchParams.get('id');
      if(!contents[id])return {status:404,body:{}};
      const sha=createHash('sha256').update(contents[id]).digest('hex');
      const drip=url.searchParams.get('drip')??behavior.drip[id];
      const href='/download?id='+id+(drip?'&drip='+drip:'');
      const closeMs=behavior.autoclose[id];
      if(closeMs!=null)delete behavior.autoclose[id];
      const modal=behavior.prompt[id]?'<div style="position:fixed;inset:0;background:#fff9;z-index:99"><p>门户提示：当前账号需人工复核，领取已被阻止</p></div>':'';
      const closer=closeMs!=null?`<script>setTimeout(()=>window.close(),${closeMs})</script>`:'';
      return {type:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><main data-ready="true" data-document="${id}" data-sha256="${sha}"><h1>${id}</h1><a href="${href}" download="document.pdf">领取附件</a><button onclick="setTimeout(()=>document.querySelector('a').click(),250)">延后领取</button>${modal}${closer}</main>`};
    }
    if(url.pathname==='/download'){
      const id=url.searchParams.get('id');
      if(!contents[id])return {status:404,body:{}};
      const headers={'content-disposition':'attachment; filename="document.pdf"'};
      const dripMs=Number(url.searchParams.get('drip')??0);
      if(dripMs>0&&request.method!=='HEAD'){
        response.writeHead(200,{'content-type':'application/pdf',...headers});
        const bytes=contents[id];
        const parts=4;
        const size=Math.ceil(bytes.length/parts);
        for(let index=0;index<parts;index++){
          response.write(bytes.subarray(index*size,(index+1)*size));
          await new Promise(resolve=>setTimeout(resolve,dripMs/parts));
        }
        response.end();
        return {raw:true};
      }
      return {type:'application/pdf',headers,body:contents[id]};
    }
    return {status:404,body:{}};
  }

  return listen(async (url, request, response) => {
    if (url.pathname === '/fixture/control') {
      if (request.method === 'POST') {
        const next = JSON.parse(await readBody(request) || '{}');
        behavior.drip = next.drip ?? {};
        behavior.autoclose = next.autoclose ?? {};
        behavior.prompt = next.prompt ?? {};
      }
      return { body: behavior };
    }
    if (url.pathname === '/app.js') return { type: 'text/javascript; charset=utf-8', body: await readFile(new URL('../portal/app.js', import.meta.url), 'utf8') };
    if (url.pathname === '/') return { type: 'text/html; charset=utf-8', body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>业务演练门户</title><style>body{font:18px sans-serif;padding:24px}button{padding:8px;margin:6px}table{border-collapse:collapse}td,th{border:1px solid #aaa;padding:10px}.lane{border:2px solid #888;display:inline-block;vertical-align:top;min-height:220px;width:240px;padding:12px}.card{border:1px solid #777;padding:12px;margin:8px;background:#eef}#status{white-space:pre-wrap}</style><main id="app"></main><pre id="status"></pre><script src="/app.js"></script></html>` };
    return route(url, request, response);
  });
}
