package com.mindfold.app;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

/**
 * 安卓外壳的入口 Activity。
 *
 * ====================================================================
 * 为什么必须接管返回键（原来返回键是「摆设」）
 * ====================================================================
 * Capacitor 8.5.2 的 {@code com.getcapacitor.BridgeActivity extends AppCompatActivity}
 * **完全没有重写 onBackPressed**（整个 @capacitor/android 里搜不到
 * onBackPressed / handleBackButton / canGoBack，只有 cordova 的 Mock 里出现过
 * canGoBack 这个名字）。所以硬件返回键直接落到系统默认行为 ——
 * 直接 finish() 退出应用，**任何浮层开着也一样**。
 * 用户在手机上按返回键想看的是「关掉当前这个弹窗」，结果应用被关掉了。
 *
 * ====================================================================
 * 为什么用 OnBackPressedDispatcher，而不是重写 onBackPressed()
 * ====================================================================
 * 本项目的 targetSdkVersion = 36（见 android/variables.gradle）。
 * Android 16 起「预测性返回（predictive back）」对 targetSdk>=36 的
 * 应用**默认开启**，此时旧的 {@code onBackPressed()} 不再被调用 ——
 * 只重写它在新的系统上等于没写。
 *
 * {@code OnBackPressedDispatcher} 是 androidx 提供的官方入口，它自己会把
 * 下面这些差异全部抹平，我们不用去判 SDK_INT、也不用改 manifest：
 *   · API < 33                    → 走传统的 onBackPressed 通路
 *   · API 33+ 未开启预测性返回     → 同上
 *   · API 33+ 已开启（含 targetSdk 36 的默认开启）→ 走 OnBackInvokedCallback
 * 而且 appcompat 1.7.1 / androidx.activity 本来就在依赖里，不引入新库。
 *
 * ====================================================================
 * 决策为什么要绕一圈回 JS
 * ====================================================================
 * 「这一下返回键该关掉谁」的完整知识（浮层栈、优先级、绝不一按全关）
 * 在 `src/lib/hooks.js` 的 backLayers 注册表里，那是唯一的一份。
 * 如果在这里用 Java 再判一遍「现在有没有弹窗」，就成了两份会分叉的状态。
 * 所以原生只做一件事：问一句 JS；能关就吃掉，不能关就退出应用。
 *
 * evaluateJavascript 是异步的，这里因此先「吃掉」这次返回、再等 JS 的回话；
 * 回调在 UI 线程上执行，往返在同一帧量级，用户感觉不到。
 */
public class MainActivity extends BridgeActivity {

    /**
     * 问 JS：现在有没有可以关掉的浮层？
     * 返回字符串 "true" / "false"（evaluateJavascript 会把布尔值序列化成带引号的 JSON）。
     * 整段包在 try/catch 里 —— 页面还没加载完、JS 抛异常时一律当作「没有浮层」，
     * 于是返回键退化成系统默认行为（退出应用），不会卡成「按了没反应」。
     */
    private static final String ASK_JS =
        "(function(){try{return (window.__mfHardwareBack && window.__mfHardwareBack()) ? 'true' : 'false';}"
        + "catch(e){return 'false';}})()";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        /*
         * 注册一个**已启用**的回调。
         *
         * 注意：只要注册了回调，OnBackPressedDispatcher 就不会再走到
         * 「退出 Activity」的默认分支 —— 所以「什么都没开」那条路必须由
         * 我们自己在回调里 finish()，否则返回键会彻底失灵（比原来更糟）。
         */
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = null;
                try {
                    if (getBridge() != null) webView = getBridge().getWebView();
                } catch (Throwable ignored) {
                    // 桥还没建好：当「没有浮层」处理
                }

                if (webView == null) {
                    finish();
                    return;
                }

                try {
                    webView.evaluateJavascript(ASK_JS, value -> {
                        // JS 侧关掉了浮层 → 吃掉这次返回；否则交回系统退出应用
                        if (!"\"true\"".equals(value)) finish();
                    });
                } catch (Throwable ignored) {
                    // WebView 已销毁等异常：退化成系统默认行为
                    finish();
                }
            }
        });
    }
}
