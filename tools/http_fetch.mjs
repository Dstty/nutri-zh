/* 测试用下载器: 用 node:http 取回并 gunzip。
 * 不用全局 fetch —— Node 的 undici 解析 Python SimpleHTTPRequestHandler
 * 的大响应时会触发内部断言, 与浏览器行为无关。 */
import http from 'node:http';
import { gunzipSync } from 'node:zlib';

export function fetchBytes(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
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
