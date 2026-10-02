// 发布版不要弹出控制台窗口（Windows 专属属性）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mindfold_lib::run()
}
