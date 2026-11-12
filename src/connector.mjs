import {openBrowser}from './browser.mjs';
export async function inspect(base){const session=await openBrowser(base);try{return await session.page.locator('[data-bill]').evaluateAll(elements=>elements.map(element=>({text:element.textContent.trim(),key:element.getAttribute('data-key'),version:element.getAttribute('data-version')})));}finally{await session.close();}}
