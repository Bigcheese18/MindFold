//! MindFold 的桌面外壳。
//!
//! 这里**故意只有一件事**：起一个原生窗口，把已经构建好的前端（`dist/`）
//! 交给系统 WebView2 显示。
//!
//! 为什么不做更多：
//!   · 应用本身是纯前端、纯本地、零后端（数据全在 localStorage），
//!     Rust 侧不需要任何 command / IPC —— 少一层就少一类 bug。
//!   · 没有网络请求、没有文件系统访问，所以 capabilities 里只给
//!     `core:default`，不额外开任何权限。

/// 桌面端入口
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("MindFold 启动失败");
}
