/**
 * 生成应用图标（PNG）
 * ==================
 * 没有图像库可用（项目只依赖 mermaid + react），所以直接手写 PNG：
 *   · 自己算像素（4x4 超采样做抗锯齿）
 *   · zlib deflate 压缩 IDAT
 *   · 自己算 CRC32
 * 图案就是产品本身的隐喻：一个圆角「纸片」，右上角折起来。
 *
 * 用法：node scripts/make-icon.mjs [size] [out.png]
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const SIZE = Number(process.argv[2] || 1024)
const OUT = process.argv[3] || 'src-tauri/app-icon.png'

/* ---------------- PNG 编码 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** rgba: Uint8Array(size*size*4) → PNG Buffer */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8      // bit depth
  ihdr[9] = 6      // color type: RGBA
  ihdr[10] = 0     // compression
  ihdr[11] = 0     // filter
  ihdr[12] = 0     // interlace

  // 每行前面加一个 filter 字节（0 = None）
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy
      ? rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
      : Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ---------------- 形状（归一化坐标 0..1） ---------------- */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** 圆角矩形内部？ */
function inRoundRect(x, y, l, t, r, b, rad) {
  if (x < l || x > r || y < t || y > b) return false
  const cx = Math.min(Math.max(x, l + rad), r - rad)
  const cy = Math.min(Math.max(y, t + rad), b - rad)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= rad * rad
}

/** 折角大小（归一化） */
const FOLD = 0.20
const PAD = 0.20            // 纸片四周留白
const RAD = 0.075

/**
 * 返回该点的颜色 {r,g,b,a}，a=0 表示透明。
 * 图案：
 *   1. 蓝色渐变圆角方底
 *   2. 白色纸片（右上角被斜切）
 *   3. 折起来的那个角（浅蓝三角）
 */
function sample(x, y) {
  // 1. 底
  if (!inRoundRect(x, y, 0, 0, 1, 1, 0.22)) return [0, 0, 0, 0]
  const g = y
  let r = Math.round(59 + (37 - 59) * g)
  let gg = Math.round(130 + (99 - 130) * g)
  let b = Math.round(246 + (235 - 246) * g)
  let a = 255

  const L = PAD
  const T = PAD
  const R = 1 - PAD
  const B = 1 - PAD
  const cutX = R - FOLD
  const cutY = T + FOLD

  // 2. 纸片（切掉右上角）
  const inCut = (x - cutX) + (T - y) > 0        // 对角线右上侧
  if (inRoundRect(x, y, L, T, R, B, RAD) && !inCut) {
    r = 255; gg = 255; b = 255
  }

  // 3. 折角：对角线左上侧的三角形填浅色
  const inFlap = (x >= cutX && x <= R && y >= T && y <= cutY) && ((x - cutX) + (T - y) <= 0)
  if (inFlap) {
    r = 219; gg = 234; b = 254
  }

  return [r, gg, b, a]
}

/* ---------------- 渲染（4x4 超采样） ---------------- */
const SS = 4
const rgba = Buffer.alloc(SIZE * SIZE * 4)
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let ar = 0; let ag = 0; let ab = 0; let aa = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) / SIZE
        const y = (py + (sy + 0.5) / SS) / SIZE
        const c = sample(x, y)
        // 预乘 alpha 再平均，避免边缘出现深色描边
        const al = c[3] / 255
        ar += c[0] * al; ag += c[1] * al; ab += c[2] * al; aa += al
      }
    }
    const n = SS * SS
    const alpha = aa / n
    const i = (py * SIZE + px) * 4
    if (alpha > 0) {
      rgba[i] = Math.round(ar / aa)
      rgba[i + 1] = Math.round(ag / aa)
      rgba[i + 2] = Math.round(ab / aa)
      rgba[i + 3] = Math.round(clamp01(alpha) * 255)
    }
  }
}

writeFileSync(OUT, encodePng(SIZE, rgba))
console.log(`已生成 ${OUT}  ${SIZE}x${SIZE}  ${(encodePng(SIZE, rgba).length / 1024).toFixed(1)} KB`)
