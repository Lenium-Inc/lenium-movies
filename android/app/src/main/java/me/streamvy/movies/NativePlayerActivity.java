package me.streamvy.movies;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Full-screen playback that borrows the one thing the website cannot fake: a
 * Chrome network stack running on MovieBox's own player origin.
 *
 * MovieBox enforces a five-minute preview in its player script, so the page is
 * only used as a same-origin launchpad. Once it is loaded we resolve the signed
 * stream ourselves and replace the page with a plain <video>. Every media
 * request therefore carries the exact player-page Referer and the WebView's
 * Chromium TLS fingerprint, while the preview timer no longer exists.
 */
public class NativePlayerActivity extends Activity {

    public static final String EXTRA_SUBJECT_ID = "subjectId";
    public static final String EXTRA_DETAIL_PATH = "detailPath";
    public static final String EXTRA_SEASON = "season";
    public static final String EXTRA_EPISODE = "episode";
    public static final String EXTRA_TITLE = "title";

    private static final String BFF_DOMAIN_URL =
        "https://h5-api.aoneroom.com/wefeed-h5api-bff/media-player/get-domain";
    private static final String FALLBACK_PLAYER_DOMAIN = "https://mzfi.me";

    private WebView webView;
    private String playerDomain = FALLBACK_PLAYER_DOMAIN;
    private String playerHost = "mzfi.me";
    private String subjectId;
    private String detailPath;
    private String title;
    private int season = 1;
    private int episode = 1;
    private boolean injected = false;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        subjectId = getIntent().getStringExtra(EXTRA_SUBJECT_ID);
        detailPath = getIntent().getStringExtra(EXTRA_DETAIL_PATH);
        title = getIntent().getStringExtra(EXTRA_TITLE);
        // Films are addressed as season 0, episode 0. The BFF's 1/1 default is
        // a season a film does not have, so do not clamp the movie value up.
        season = Math.max(0, getIntent().getIntExtra(EXTRA_SEASON, 1));
        episode = Math.max(0, getIntent().getIntExtra(EXTRA_EPISODE, 1));

        if (subjectId == null || subjectId.trim().isEmpty() || detailPath == null || detailPath.trim().isEmpty()) {
            Toast.makeText(this, "This title is missing its playback id", Toast.LENGTH_LONG).show();
            finish();
            return;
        }

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        applyImmersiveMode();

        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setLoadsImagesAutomatically(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUserAgentString(
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
        );

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView.addJavascriptInterface(new NativeBridge(), "StreamVyNative");
        webView.setWebViewClient(
            new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    String host = request.getUrl().getHost();
                    return host != null && !host.equalsIgnoreCase(playerHost);
                }

                @Override
                public void onPageFinished(WebView view, String url) {
                    super.onPageFinished(view, url);
                    if (injected) return;
                    injected = true;
                    // The page sets its guest token during boot; a short pause
                    // avoids racing that assignment. The injected script can
                    // also mint its own token, so this is only a smoothing.
                    mainHandler.postDelayed(
                        () -> view.evaluateJavascript(buildInjectedScript(), null),
                        650
                    );
                }

                @Override
                public void onReceivedError(
                    WebView view,
                    WebResourceRequest request,
                    WebResourceError error
                ) {
                    super.onReceivedError(view, request, error);
                    if (request.isForMainFrame()) {
                        Toast.makeText(
                            NativePlayerActivity.this,
                            "Could not open the player. Check your connection and try again.",
                            Toast.LENGTH_LONG
                        ).show();
                    }
                }
            }
        );

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        root.addView(
            webView,
            new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        );
        setContentView(root);

        new Thread(
            () -> {
                String domain = resolvePlayerDomain();
                runOnUiThread(() -> loadPlayer(domain));
            }
        ).start();
    }

    private String resolvePlayerDomain() {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(BFF_DOMAIN_URL);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Referer", "https://moviebox.ph/");
            connection.setRequestProperty(
                "User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            );

            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) return FALLBACK_PLAYER_DOMAIN;

            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8)
            )) {
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
            }

            JSONObject payload = new JSONObject(body.toString());
            String data = payload.optString("data", "").trim();
            if (data.startsWith("https://") || data.startsWith("http://")) {
                return data.replaceAll("/+$", "");
            }
        } catch (Exception ignored) {
            // The fallback domain is the one get-domain has returned for the
            // entire life of this integration; a metadata hiccup must not stop
            // playback.
        } finally {
            if (connection != null) connection.disconnect();
        }
        return FALLBACK_PLAYER_DOMAIN;
    }

    private void loadPlayer(String domain) {
        try {
            playerDomain = domain;
            playerHost = new URL(domain).getHost();
        } catch (Exception ignored) {
            playerDomain = FALLBACK_PLAYER_DOMAIN;
            playerHost = "mzfi.me";
        }

        String url = playerDomain +
            "/spa/videoPlayPage/movies/" + detailPath +
            "?id=" + subjectId +
            "&type=/movie/detail" +
            "&detailSe=" + season +
            "&detailEp=" + episode +
            "&lang=en";

        webView.loadUrl(url);
    }

    private String buildInjectedScript() {
        String jsonSubject = JSONObject.quote(subjectId);
        String jsonDetail = JSONObject.quote(detailPath);
        String jsonTitle = JSONObject.quote(title == null ? "" : title);

        return "(function(){\n" +
            "  if (window.__streamVyInjected) return 'already';\n" +
            "  window.__streamVyInjected = true;\n" +
            "  const config = { subjectId: " + jsonSubject + ", detailPath: " + jsonDetail +
            ", season: " + season + ", episode: " + episode + ", title: " + jsonTitle + " };\n" +
            "  const apiBase = '/wefeed-h5api-bff';\n" +
            "  try { document.querySelectorAll('video').forEach(function(v){ try { v.pause(); v.muted = true; } catch(e){} }); } catch(e){}\n" +
            "  const old = document.getElementById('sv-native-player'); if (old) old.remove();\n" +
            "  const style = document.createElement('style');\n" +
            "  style.textContent = '#sv-native-player{position:fixed;inset:0;z-index:2147483647;background:#000;color:#fff;font-family:system-ui,-apple-system,sans-serif}' +\n" +
            "    '#sv-native-player #sv-video{position:absolute;inset:0;width:100%;height:100%;background:#000;display:none}' +\n" +
            "    '#sv-native-player .sv-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:24px}' +\n" +
            "    '#sv-native-player .sv-spinner{width:42px;height:42px;border:3px solid rgba(255,255,255,.22);border-top-color:#fff;border-radius:50%;animation:sv-spin .9s linear infinite}' +\n" +
            "    '@keyframes sv-spin{to{transform:rotate(360deg)}}' +\n" +
            "    '#sv-native-player .sv-btn{border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.1);color:#fff;border-radius:12px;padding:11px 18px;font-size:14px;font-weight:650}' +\n" +
            "    '#sv-native-player .sv-close{position:absolute;top:14px;right:14px;z-index:4;width:40px;height:40px;border-radius:999px;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.55);color:#fff;font-size:18px}' +\n" +
            "    '#sv-native-player .sv-title{position:absolute;top:16px;left:16px;z-index:3;max-width:70%;font-size:14px;font-weight:650;text-shadow:0 1px 10px #000;opacity:1;transition:opacity .5s}' +\n" +
            "    '#sv-native-player .sv-quality{position:absolute;top:16px;right:66px;z-index:4;background:rgba(0,0,0,.65);color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:10px;padding:8px 10px;font-size:13px}' +\n" +
            "    '#sv-native-player .sv-muted{position:absolute;bottom:90px;left:50%;transform:translateX(-50%);z-index:4;font-size:13px;color:#ddd;background:rgba(0,0,0,.6);padding:8px 12px;border-radius:10px;display:none}';\n" +
            "  document.documentElement.appendChild(style);\n" +
            "  const root = document.createElement('div'); root.id = 'sv-native-player';\n" +
            "  root.innerHTML = '<div id=\"sv-loading\" class=\"sv-center\"><div class=\"sv-spinner\"></div><p style=\"margin:0;color:#bbb;font-size:14px\">Loading stream…</p></div>' +\n" +
            "    '<video id=\"sv-video\" playsinline controls preload=\"metadata\"></video>' +\n" +
            "    '<div id=\"sv-error\" class=\"sv-center\" style=\"display:none\"><p id=\"sv-error-text\" style=\"margin:0;max-width:360px;line-height:1.5;color:#eee\"></p><button class=\"sv-btn\" id=\"sv-retry\">Try again</button></div>' +\n" +
            "    '<div class=\"sv-title\" id=\"sv-title\"></div>' +\n" +
            "    '<select class=\"sv-quality\" id=\"sv-quality\" aria-label=\"Quality\" style=\"display:none\"></select>' +\n" +
            "    '<div class=\"sv-muted\" id=\"sv-muted\">Muted — tap the volume icon to hear sound</div>' +\n" +
            "    '<button class=\"sv-close\" id=\"sv-close\" aria-label=\"Close player\">✕</button>';\n" +
            "  (document.body || document.documentElement).appendChild(root);\n" +
            "  const video = document.getElementById('sv-video');\n" +
            "  const loading = document.getElementById('sv-loading');\n" +
            "  const errorBox = document.getElementById('sv-error');\n" +
            "  const errorText = document.getElementById('sv-error-text');\n" +
            "  const quality = document.getElementById('sv-quality');\n" +
            "  const titleEl = document.getElementById('sv-title');\n" +
            "  if (config.title) titleEl.textContent = config.title;\n" +
            "  setTimeout(function(){ titleEl.style.opacity = '0'; }, 4200);\n" +
            "  document.getElementById('sv-close').addEventListener('click', function(){ try { StreamVyNative.close(); } catch(e){} });\n" +
            "  function fail(message) {\n" +
            "    loading.style.display = 'none'; video.style.display = 'none'; errorBox.style.display = 'flex';\n" +
            "    errorText.textContent = message;\n" +
            "    try { StreamVyNative.error(message); } catch(e){}\n" +
            "  }\n" +
            "  async function token() {\n" +
            "    try { const stored = localStorage.getItem('accessToken'); if (stored) return stored; } catch(e){}\n" +
            "    const response = await fetch(apiBase + '/home?host=moviebox.ph', { credentials: 'include', cache: 'no-store' });\n" +
            "    const raw = response.headers.get('x-user');\n" +
            "    if (!raw) return null;\n" +
            "    try { return JSON.parse(raw).token || null; } catch(e){ return null; }\n" +
            "  }\n" +
            "  function requestHeaders(bearer) {\n" +
            "    const headers = { Accept: 'application/json', 'X-Client-Info': JSON.stringify({ timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') }), 'X-Request-Lang': 'en' };\n" +
            "    if (bearer) headers.Authorization = 'Bearer ' + bearer;\n" +
            "    return headers;\n" +
            "  }\n" +
            "  async function start() {\n" +
            "    errorBox.style.display = 'none'; video.style.display = 'none'; loading.style.display = 'flex';\n" +
            "    try {\n" +
            "      const bearer = await token();\n" +
            "      const params = new URLSearchParams({ subjectId: config.subjectId, se: String(config.season), ep: String(config.episode), detailPath: config.detailPath, streamSignType: '1' });\n" +
            "      params.append('supportCodecs[hevc]', '1'); params.append('supportCodecs[h264]', '1');\n" +
            "      const response = await fetch(apiBase + '/subject/play?' + params.toString(), { credentials: 'include', cache: 'no-store', headers: requestHeaders(bearer) });\n" +
            "      const text = await response.text();\n" +
            "      let payload; try { payload = JSON.parse(text); } catch(e){ throw new Error('The stream service returned an unreadable response.'); }\n" +
            "      const data = payload && payload.data ? payload.data : {};\n" +
            "      const streams = Array.isArray(data.streams) ? data.streams.slice() : [];\n" +
            "      if (!streams.length) throw new Error('This episode has no stream yet. Try another episode or come back later.');\n" +
            "      streams.sort(function(a,b){ return Number(b.resolutions || 0) - Number(a.resolutions || 0); });\n" +
            "      quality.innerHTML = '';\n" +
            "      streams.forEach(function(stream, index) {\n" +
            "        const option = document.createElement('option'); option.value = stream.url;\n" +
            "        option.textContent = (stream.resolutions ? stream.resolutions + 'p' : 'Auto') + (stream.format ? ' · ' + stream.format : '');\n" +
            "        quality.appendChild(option);\n" +
            "        if (index === 0) video.src = stream.url;\n" +
            "      });\n" +
            "      quality.style.display = streams.length > 1 ? 'block' : 'none';\n" +
            "      quality.onchange = function(){ video.src = quality.value; video.play().catch(function(){}); };\n" +
            "      loading.style.display = 'none'; video.style.display = 'block';\n" +
            "      video.load();\n" +
            "      try { await video.play(); } catch (playError) {\n" +
            "        video.muted = true;\n" +
            "        document.getElementById('sv-muted').style.display = 'block';\n" +
            "        try { await video.play(); } catch(e2){ /* the native controls let the viewer start it */ }\n" +
            "      }\n" +
            "    } catch (error) { fail(error && error.message ? error.message : 'The stream could not be loaded.'); }\n" +
            "  }\n" +
            "  video.addEventListener('playing', function(){ loading.style.display = 'none'; errorBox.style.display = 'none'; });\n" +
            "  video.addEventListener('error', function(){ if (video.getAttribute('src')) fail('The stream could not be played. Check your connection and try again.'); });\n" +
            "  document.getElementById('sv-retry').addEventListener('click', start);\n" +
            "  start();\n" +
            "  return 'ok';\n" +
            "})();";
    }

    private void applyImmersiveMode() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                );
            }
            return;
        }
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
            View.SYSTEM_UI_FLAG_FULLSCREEN |
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersiveMode();
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    public void onBackPressed() {
        finish();
    }

    @Override
    protected void onDestroy() {
        mainHandler.removeCallbacksAndMessages(null);
        if (webView != null) {
            webView.removeJavascriptInterface("StreamVyNative");
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private class NativeBridge {
        @JavascriptInterface
        public void close() {
            runOnUiThread(NativePlayerActivity.this::finish);
        }

        @JavascriptInterface
        public void error(String message) {
            if (message == null || message.trim().isEmpty()) return;
            runOnUiThread(
                () -> Toast.makeText(
                    NativePlayerActivity.this,
                    message,
                    Toast.LENGTH_LONG
                ).show()
            );
        }

        @JavascriptInterface
        public String locale() {
            return Locale.getDefault().toLanguageTag();
        }
    }
}
