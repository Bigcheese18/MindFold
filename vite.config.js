import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// MindFold 是纯前端 SPA。
// base:'./' 用相对路径引用资源，便于 Tauri 打包（tauri://localhost）以及
// 部署到任意子路径；但**不能**因此就双击 dist/index.html ——
// ES module 在 file:// 下会被浏览器拦掉，本地预览请用 npm run preview。
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    // host:true = 监听 0.0.0.0，手机/平板才能通过局域网 IP 访问。
    // 默认只绑 ::1（IPv6 回环），手机连 192.168.x.x:5173 会被拒。
    host: true,
    port: 5173,
    strictPort: true,
    watch: {
      // Windows 上文件被写入时是排他的，chokidar 一碰就 EBUSY，
      // 而 Vite 的 watcher 遇到 EBUSY 会直接抛错退出（不是重试）。
      // 这里排除掉几类「不是源码」的路径：
      //   scripts/  本地校验脚本，运行时会产生临时文件
      //   dist/     构建产物
      //   .*.tmpdir/、.*.tmp  编辑器/工具做原子写入时留下的临时目录
      //   *~RF*.TMP          某些编辑器/工具保存时留下的临时文件（见下方说明）
      ignored: [
        '**/scripts/**',
        '**/dist/**',
        '**/.*.tmpdir/**',
        '**/.*.tmpdir',
        '**/.*.tmp',
        // 有些工具保存文件时先写一个 `xxx~RFxxxxxx.TMP` 再改名，
        // 这个临时文件在 Windows 上被短暂独占 —— watcher 一碰就 EBUSY 崩掉。
        // 实测：改 package.json 会让 dev server 直接退出。
        '**/~RF*.TMP',
        '**/*.TMP',
        // ★ 打包产物目录必须排除，否则 `npm run tauri build` / Gradle 一编译，
        // dev server 就被它们中途锁住的 .exe / .dll 拖死。
        // 实测：Rust 编译到 build_script_build-*.exe 时 watcher 直接
        // `EBUSY: resource busy or locked` 抛错退出，整个 dev server 挂掉，
        // 连带后面所有浏览器测试全部「找不到折角角标」。
        '**/src-tauri/target/**',
        '**/src-tauri/gen/**',
        '**/android/**',
        '**/ios/**',
        '**/.build/**',
      ],
    },
  },
  build: {
    outDir: 'dist',
    // Mermaid 体积较大，单独切块，方便后续内联导出时按需注入
    chunkSizeWarningLimit: 4000,
  },
})