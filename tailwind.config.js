/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
      },
      // 三种主题的色板。语义化命名，组件里只引用语义名，
      // 换肤时只改这里的 CSS 变量（见 index.css）。
      colors: {
        canvas: 'var(--mf-canvas)',
        panel: 'var(--mf-panel)',
        edge: 'var(--mf-edge)',
        ink: 'var(--mf-ink)',
        muted: 'var(--mf-muted)',
        faint: 'var(--mf-faint)',
        accent: 'var(--mf-accent)',
        // 折角熟悉度四级色阶
        fold0: '#9ca3af',
        fold1: '#3b82f6',
        fold2: '#f59e0b',
        fold3: '#ef4444',
      },
      boxShadow: {
        card: '0 4px 24px -4px rgba(0,0,0,.12), 0 2px 6px -2px rgba(0,0,0,.08)',
        pop: '0 24px 60px -12px rgba(0,0,0,.28)',
      },
      transitionDuration: { 200: '200ms' },
    },
  },
  plugins: [],
}