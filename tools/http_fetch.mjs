/* 测试用下载器: 取回并 gunzip, 支持 http/https。
 *
 * 不用全局 fetch —— Node 的 undici 解析 Python SimpleHTTPRequestHandler
 * 的大响应时会触发内部断言, 与浏览器行为无关。 */
import http from 'node:http';
import https from 'node:https';
import { gunzipSync } from 'node:zlib';

export function fetchBytes(url) {
  const mod = String(url).startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    mod.get(url, (res) => {
      // 跟随重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchBytes(new URL(res.headers.location, url).href).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

export async function fetchJson(url) {
  const buf = await fetchBytes(url);
  return JSON.parse(buf.toString('utf8'));
}

export async function fetchGunzip(url) {
  return new Uint8Array(gunzipSync(await fetchBytes(url)));
}
