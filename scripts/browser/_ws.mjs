/**
 * 极简 WebSocket 客户端（仅用于 CDP 冒烟测试）。
 * Node 22+ 自带全局 WebSocket，这里优先复用它，避免额外依赖。
 */
const NativeWS = globalThis.WebSocket

class MiniWS {
  constructor(url) {
    this._ws = new NativeWS(url)
    this.onmessage = null
    this.opened = new Promise((resolve, reject) => {
      this._ws.addEventListener('open', () => resolve())
      this._ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败')))
    })
    this._ws.addEventListener('message', (e) => {
      if (this.onmessage) this.onmessage(String(e.data))
    })
  }
  send(data) { this._ws.send(data) }
  close() { try { this._ws.close() } catch { /* ignore */ } }
}

export default MiniWS