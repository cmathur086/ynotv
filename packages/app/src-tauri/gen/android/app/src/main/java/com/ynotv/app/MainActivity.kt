package com.ynotv.app

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  // The app is a single page: Back on the remote means "close / go back" in
  // the UI, not WebView history. See onWebViewCreate.
  override val handleBackNavigation: Boolean = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    // Hand Back to the page's spatial navigation (services/tvRemote.ts). If the
    // page isn't ready or doesn't handle it, leave the app like Home would.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript(
          "(window.__ynotvTvBack ? window.__ynotvTvBack() : false)"
        ) { result ->
          if (result != "true") moveTaskToBack(true)
        }
      }
    })
  }
}
