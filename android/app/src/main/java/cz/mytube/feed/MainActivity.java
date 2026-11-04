package cz.mytube.feed;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

/**
 * MyTube Feed pro Android – jen feed (žádné vestavěné prohlížení YouTube).
 *  - feed : WebView s feed.html (soubory z assets přes https://appassets.androidplatform.net)
 *  - bg   : skrytý WebView s background.html (synchronizace přes Nostr, kontrola aktualizací)
 * Videa a odkazy se otevírají ve zvoleném prohlížeči (Firefox, Brave, Chrome…).
 * Videa a kanály se přidávají vložením odkazu nebo sdílením z jiné aplikace.
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST;
    static final String UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    private WebView feed, bg;
    private Store store;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> chooser;
    private volatile String pendingShare;
    private String version = "0.0.0";
    private final ExecutorService io = Executors.newFixedThreadPool(6);

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        try {
            version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ignored) { /* ponechá 0.0.0 */ }

        prefs = getSharedPreferences("pt", MODE_PRIVATE);
        store = new Store(this);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF0F0F0F);
        feed = newWebView();
        bg = newWebView();
        feed.setBackgroundColor(0xFF0F0F0F);
        root.addView(feed, new FrameLayout.LayoutParams(-1, -1));
        root.addView(bg, new FrameLayout.LayoutParams(1, 1));
        setContentView(root);

        // změny v úložišti se rozešlou do obou WebView (jako chrome.storage.onChanged)
        store.listener = json -> runOnUiThread(() -> {
            String js = "window.__ptChanged&&window.__ptChanged(" + json + ")";
            feed.evaluateJavascript(js, null);
            bg.evaluateJavascript(js, null);
        });

        bg.loadUrl(ORIGIN + "/background.html");
        feed.loadUrl(ORIGIN + "/feed.html");
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    /** sdílení textu/odkazu z jiné aplikace (např. YouTube → Sdílet → MyTube Feed) */
    private void handleIntent(Intent i) {
        if (i == null || !Intent.ACTION_SEND.equals(i.getAction())) return;
        String t = i.getStringExtra(Intent.EXTRA_TEXT);
        if (t == null || t.trim().isEmpty()) return;
        pendingShare = t;
        feed.evaluateJavascript("window.dispatchEvent(new MessageEvent('message',{data:'pt-open'}))", null);
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private WebView newWebView() {
        WebView w = new WebView(this);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        w.setWebChromeClient(new Chrome());
        w.setWebViewClient(new Client());
        w.addJavascriptInterface(new Bridge(), "PTFull");   // WebView načítá jen vlastní soubory z assets
        return w;
    }

    @Override
    public void onBackPressed() {
        // zavře otevřený dialog / menu ve feedu, jinak ukončí aplikaci
        feed.evaluateJavascript("(function(){var d=document.querySelector('dialog[open]');if(d){d.close();return 1;}"
                + "var m=document.getElementById('menu');if(m&&!m.hidden){m.hidden=true;return 1;}return 0;})()",
                v -> { if (!"1".equals(v)) super.onBackPressed(); });
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == 1 && chooser != null) {
            chooser.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            chooser = null;
        }
    }

    /* ---------------- otevírání odkazů ve zvoleném prohlížeči ---------------- */
    private void openExternal(Uri u) {
        if (prefs.getString("browser", null) == null && chooseBrowser(() -> launch(u))) return;
        launch(u);
    }

    private void launch(Uri u) {
        String pkg = prefs.getString("browser", null);
        Intent i = new Intent(Intent.ACTION_VIEW, u);
        if (pkg != null) i.setPackage(pkg);
        try {
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            if (pkg != null) {                         // zvolený prohlížeč už není nainstalovaný
                prefs.edit().remove("browser").apply();
                openExternal(u);
            }
        }
    }

    /** dialog s nainstalovanými prohlížeči; vrací false, když žádný nenašel */
    private boolean chooseBrowser(Runnable after) {
        PackageManager pm = getPackageManager();
        List<ResolveInfo> found = pm.queryIntentActivities(
                new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com")), PackageManager.MATCH_ALL);
        final List<String> pkgs = new ArrayList<>();
        final List<CharSequence> names = new ArrayList<>();
        for (ResolveInfo ri : found) {
            String p = ri.activityInfo.packageName;
            if (p.equals(getPackageName()) || p.equals("com.google.android.youtube") || pkgs.contains(p)) continue;
            pkgs.add(p);
            names.add(ri.loadLabel(pm));
        }
        if (pkgs.isEmpty()) return false;
        new AlertDialog.Builder(this)
                .setTitle("Otevírat videa v prohlížeči")
                .setItems(names.toArray(new CharSequence[0]), (d, which) -> {
                    prefs.edit().putString("browser", pkgs.get(which)).apply();
                    if (after != null) after.run();
                })
                .show();
        return true;
    }

    /* ---------------- soubory z assets ---------------- */
    private static String mimeOf(String n) {
        if (n.endsWith(".html")) return "text/html";
        if (n.endsWith(".js")) return "application/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    private WebResourceResponse resp(int code, String reason, String mime, InputStream in) {
        return new WebResourceResponse(mime, "UTF-8", code, reason, new HashMap<String, String>(), in);
    }

    private WebResourceResponse serve(Uri u) {
        String p = u.getPath();
        if (p == null || p.equals("/")) p = "/feed.html";
        String name = p.substring(1);
        if (name.contains("..")) return resp(404, "Not Found", "text/plain", new ByteArrayInputStream(new byte[0]));
        try {
            InputStream in = getAssets().open(name);
            if (name.endsWith(".html")) {
                String html = new String(Store.readAll(in), StandardCharsets.UTF_8);
                String tag = "<script src=\"chrome-shim.js\"></script>";
                html = html.contains("<head>") ? html.replace("<head>", "<head>" + tag) : tag + html;
                return resp(200, "OK", "text/html", new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
            }
            return resp(200, "OK", mimeOf(name), in);
        } catch (IOException e) {
            return resp(404, "Not Found", "text/plain", new ByteArrayInputStream(new byte[0]));
        }
    }

    private static byte[] readLimited(InputStream in, int max) throws IOException {
        try {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            byte[] b = new byte[16384];
            int n;
            while ((n = in.read(b)) != -1) {
                o.write(b, 0, n);
                if (o.size() >= max) break;
            }
            return o.toByteArray();
        } finally {
            in.close();
        }
    }

    /** jen YouTube adresy, které feed potřebuje (RSS, oEmbed, stránky kanálů) */
    private static boolean fetchAllowed(String u) {
        if (u == null) return false;
        return u.startsWith("https://www.youtube.com/feeds/") || u.startsWith("https://www.youtube.com/oembed?")
                || u.startsWith("https://www.youtube.com/@") || u.startsWith("https://www.youtube.com/channel/")
                || u.startsWith("https://www.youtube.com/c/") || u.startsWith("https://www.youtube.com/user/");
    }

    /* ---------------- WebViewClient ---------------- */
    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
            Uri u = r.getUrl();
            if (HOST.equals(u.getHost())) return serve(u);
            return null;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
            Uri u = r.getUrl();
            if (HOST.equals(u.getHost())) return false;
            String sch = u.getScheme() == null ? "" : u.getScheme();
            if (sch.equals("http") || sch.equals("https")) openExternal(u);   // video / aktualizace → prohlížeč
            return true;                                                      // WebView nikdy neopouští vlastní stránky
        }
    }

    /* ---------------- WebChromeClient: dialogy a výběr souboru ---------------- */
    private class Chrome extends WebChromeClient {
        @Override
        public boolean onJsAlert(WebView v, String url, String msg, JsResult r) {
            new AlertDialog.Builder(MainActivity.this).setMessage(msg)
                    .setPositiveButton(android.R.string.ok, (d, w) -> r.confirm())
                    .setOnCancelListener(d -> r.cancel()).show();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView v, String url, String msg, JsResult r) {
            new AlertDialog.Builder(MainActivity.this).setMessage(msg)
                    .setPositiveButton(android.R.string.ok, (d, w) -> r.confirm())
                    .setNegativeButton(android.R.string.cancel, (d, w) -> r.cancel())
                    .setOnCancelListener(d -> r.cancel()).show();
            return true;
        }

        @Override
        public boolean onJsPrompt(WebView v, String url, String msg, String def, JsPromptResult r) {
            EditText et = new EditText(MainActivity.this);
            et.setSingleLine(true);
            et.setText(def == null ? "" : def);
            new AlertDialog.Builder(MainActivity.this).setMessage(msg).setView(et)
                    .setPositiveButton(android.R.string.ok, (d, w) -> r.confirm(et.getText().toString()))
                    .setNegativeButton(android.R.string.cancel, (d, w) -> r.cancel())
                    .setOnCancelListener(d -> r.cancel()).show();
            return true;
        }

        @Override
        public boolean onShowFileChooser(WebView w, ValueCallback<Uri[]> cb, FileChooserParams p) {
            if (chooser != null) chooser.onReceiveValue(null);
            chooser = cb;
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            try {
                startActivityForResult(Intent.createChooser(i, "Vyber soubor"), 1);
            } catch (ActivityNotFoundException e) {
                chooser = null;
                cb.onReceiveValue(null);
            }
            return true;
        }
    }

    /* ---------------- most JS <-> Java ---------------- */
    private class Bridge {
        @JavascriptInterface
        public String get(String keys) {
            return store.get(keys, true);
        }

        @JavascriptInterface
        public void set(String obj) {
            store.set(obj, true);
        }

        @JavascriptInterface
        public void remove(String keys) {
            store.remove(keys, true);
        }

        @JavascriptInterface
        public String version() {
            return version;
        }

        /** odkaz (video, aktualizace…) otevře ve zvoleném prohlížeči */
        @JavascriptInterface
        public void openUrl(String url) {
            if (url == null) return;
            Uri u = Uri.parse(url);
            String sch = u.getScheme() == null ? "" : u.getScheme();
            if (!sch.equals("http") && !sch.equals("https")) return;
            runOnUiThread(() -> openExternal(u));
        }

        /** menu: změna prohlížeče pro otevírání videí */
        @JavascriptInterface
        public void chooseBrowser() {
            runOnUiThread(() -> {
                if (!MainActivity.this.chooseBrowser(null))
                    Toast.makeText(MainActivity.this, "Nenalezen žádný prohlížeč", Toast.LENGTH_LONG).show();
            });
        }

        /** text ze schránky (pro tlačítko „Vložit“) */
        @JavascriptInterface
        public String clipboard() {
            FutureTask<String> t = new FutureTask<>(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (cm == null || !cm.hasPrimaryClip()) return "";
                ClipData d = cm.getPrimaryClip();
                if (d == null || d.getItemCount() == 0) return "";
                CharSequence s = d.getItemAt(0).coerceToText(MainActivity.this);
                return s == null ? "" : s.toString();
            });
            runOnUiThread(t);
            try {
                return t.get(2, TimeUnit.SECONDS);
            } catch (Exception e) {
                return "";
            }
        }

        /** text sdílený z jiné aplikace (vrací se jednou) */
        @JavascriptInterface
        public String takeShare() {
            String t = pendingShare;
            pendingShare = null;
            return t == null ? "" : t;
        }

        /** zpráva z feedu do background stránky (sync-status, sync-now, …) */
        @JavascriptInterface
        public void send(String msgJson, String cbId) {
            runOnUiThread(() -> bg.evaluateJavascript("window.__bgHandle&&window.__bgHandle("
                    + JSONObject.quote(msgJson) + "," + JSONObject.quote(cbId) + ")", null));
        }

        /** odpověď background stránky zpět do feedu */
        @JavascriptInterface
        public void reply(String cbId, String json) {
            runOnUiThread(() -> feed.evaluateJavascript("window.__ptReply&&window.__ptReply("
                    + JSONObject.quote(cbId) + "," + json + ")", null));
        }

        /** stažení RSS / oEmbed / stránky kanálu YouTube mimo CORS */
        @JavascriptInterface
        public void fetch(String url, String id) {
            if (!fetchAllowed(url)) {
                done(id, 0, "");
                return;
            }
            io.execute(() -> {
                int status = 0;
                String b64 = "";
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(15000);
                    c.setReadTimeout(20000);
                    c.setRequestProperty("User-Agent", UA);
                    c.setRequestProperty("Accept-Language", "cs,en;q=0.7");
                    c.setRequestProperty("Cookie", "SOCS=CAI");     // přeskočí souhlasovou stránku v EU
                    status = c.getResponseCode();
                    InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    if (in != null) {
                        int max = url.startsWith("https://www.youtube.com/feeds/") ? 8000000 : 700000;
                        b64 = Base64.encodeToString(readLimited(in, max), Base64.NO_WRAP);
                    }
                } catch (Exception e) {
                    status = 0;
                }
                done(id, status, b64);
            });
        }

        private void done(String id, int status, String b64) {
            runOnUiThread(() -> feed.evaluateJavascript("window.__ptFetchDone&&window.__ptFetchDone("
                    + JSONObject.quote(id) + "," + status + ",'" + b64 + "')", null));
        }

        /** export zálohy do složky Stažené soubory */
        @JavascriptInterface
        public void saveFile(String name, String text) {
            String msg;
            try {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.MIME_TYPE, "application/json");
                v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                Uri u = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (u == null) throw new IOException("insert");
                try (OutputStream o = getContentResolver().openOutputStream(u)) {
                    o.write(text.getBytes(StandardCharsets.UTF_8));
                }
                msg = "Záloha uložena do Stažených souborů";
            } catch (Exception e) {
                msg = "Export se nepodařil";
            }
            final String m = msg;
            runOnUiThread(() -> Toast.makeText(MainActivity.this, m, Toast.LENGTH_LONG).show());
        }
    }
}
