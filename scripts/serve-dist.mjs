/**
 * 把一份构建产物原样伺服起来 —— 只为「没有安卓模拟器时怎么验证 APK」这条流程。
 *
 * 为什么需要它：`npm run dev` 用的是 Vite 的 dev server（按需编译、模块按路径
 * 实时转换），和 APK 里那份**已经打好包的 dist** 完全是两套伺服方式。
 * 想验证「资源路径对不对、hash 文件名有没有被打进包、SPA 回退在不在」，
 * 就必须把它当成普通静态站点伺服 —— 这个脚本干的就是这件事（零依赖）。
 *
 * 用法：
 *   node scripts/serve-dist.mjs                          # 伺服 dist/，端口 5174
 *   node scripts/serve-dist.mjs android/app/src/main/assets/public  5180
 *   node scripts/serve-dist.mjs dist 5174
 *
 * 然后指着这个地址跑浏览器测试：
 *   node scripts/browser/smoke.mjs    http://127.0.0.1:5180/
 *   node scripts/browser/mobile.mjs   http://127.0.0.1:5180/
 *   node scripts/browser/mobileui.mjs http://127.0.0.1:5180/
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const MIME = {
  '.html': 'text/html;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.mjs': 'text/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.json': 'application/json;charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json;charset=utf-8',
  '.txt': 'text/plain;charset=utf-8',
  '.md': 'text/markdown;charset=utf-8',
}

const root = resolve(process.argv[2] || 'dist')
const port = Number(process.argv[3] || 5174)

if (!existsSync(join(root, 'index.html'))) {
  console.error(`找不到 ${join(root, 'index.html')} —— 先 npm run build，或把目录指对`)
  process.exit(2)
}

const server = createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0])
  if (p === '/') p = '/index.html'
  let file = join(root, p)
  // 目录穿越防护：解析后的路径必须还在 root 里面
  if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return }
  /*
   * SPA 回退：hash 路由用不到，但直接访问 /foo 这类不存在的路径时，
   * WebView / 浏览器应当拿到 index.html 而不是 404 —— 真实 APK 里
   * Capacitor 也是这么处理的，所以验证时要一致，否则测出来的行为不算数。
   */
  if (!existsSync(file) || !statSync(file).isFile()) {
    file = join(root, 'index.html')
    if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return }
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  })
  createReadStream(file).pipe(res)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`伺服 ${root}`)
  console.log(`  → http://127.0.0.1:${port}/`)
  console.log('  Ctrl+C 结束')
})
