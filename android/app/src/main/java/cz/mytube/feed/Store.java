package cz.mytube.feed;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/** Náhrada chrome.storage.local: hodnoty jsou uložené jako surový JSON text, jeden soubor na klíč. */
class Store {
    // klíče, ke kterým smí YouTube WebView (nedůvěryhodná stránka). Zbytek (sync klíč, cache…) jen feed/background.
    private static final Set<String> UNTRUSTED = new HashSet<>(Arrays.asList("db", "wl", "watched"));

    private final File dir;
    private final Map<String, String> mem = new HashMap<>();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    Consumer<String> listener;

    Store(Context c) {
        dir = new File(c.getFilesDir(), "store");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File[] files = dir.listFiles();
        if (files != null) {
            for (File f : files) {
                String n = f.getName();
                if (!n.endsWith(".json")) continue;
                try {
                    mem.put(n.substring(0, n.length() - 5), new String(readAll(new FileInputStream(f)), StandardCharsets.UTF_8));
                } catch (IOException ignored) { /* poškozený soubor přeskoč */ }
            }
        }
    }

    static byte[] readAll(InputStream in) throws IOException {
        try {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            byte[] b = new byte[16384];
            int n;
            while ((n = in.read(b)) != -1) o.write(b, 0, n);
            return o.toByteArray();
        } finally {
            in.close();
        }
    }

    private static boolean ok(String k, boolean trusted) {
        return k != null && k.matches("[A-Za-z0-9_-]{1,40}") && (trusted || UNTRUSTED.contains(k));
    }

    synchronized String get(String keysJson, boolean trusted) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        try {
            Collection<String> ks;
            if (keysJson == null || keysJson.equals("null")) {
                ks = new ArrayList<>(mem.keySet());
            } else {
                JSONArray a = new JSONArray(keysJson);
                ks = new ArrayList<>();
                for (int i = 0; i < a.length(); i++) ks.add(a.getString(i));
            }
            for (String k : ks) {
                if (!ok(k, trusted)) continue;
                String raw = mem.get(k);
                if (raw == null) continue;
                if (!first) sb.append(',');
                first = false;
                sb.append(JSONObject.quote(k)).append(':').append(raw);
            }
        } catch (JSONException ignored) { /* vrátí se to, co se stihlo */ }
        return sb.append('}').toString();
    }

    void set(String objJson, boolean trusted) {
        StringBuilder ch = new StringBuilder("{");
        boolean any = false;
        synchronized (this) {
            try {
                JSONObject o = new JSONObject(objJson);
                Iterator<String> it = o.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    if (!ok(k, trusted)) continue;
                    Object v = o.get(k);
                    String raw = v == JSONObject.NULL ? null : (v instanceof String ? JSONObject.quote((String) v) : v.toString());
                    any |= apply(ch, any, k, raw);
                }
            } catch (JSONException e) {
                return;
            }
        }
        dispatch(ch, any);
    }

    void remove(String keysJson, boolean trusted) {
        StringBuilder ch = new StringBuilder("{");
        boolean any = false;
        synchronized (this) {
            try {
                JSONArray a = new JSONArray(keysJson);
                for (int i = 0; i < a.length(); i++) {
                    String k = a.getString(i);
                    if (!ok(k, trusted)) continue;
                    any |= apply(ch, any, k, null);
                }
            } catch (JSONException e) {
                return;
            }
        }
        dispatch(ch, any);
    }

    /** zapíše hodnotu, uloží na disk a přidá záznam do JSONu změn; vrací true, pokud se změna má rozeslat */
    private boolean apply(StringBuilder ch, boolean any, String k, String raw) {
        String old = raw == null ? mem.remove(k) : mem.put(k, raw);
        persist(k, raw);
        if (k.equals("cache") || Objects.equals(old, raw)) return false;   // cache nikam nerozesíláme (velká)
        if (any) ch.append(',');
        ch.append(JSONObject.quote(k)).append(":{\"o\":").append(old == null ? "null" : old)
                .append(",\"n\":").append(raw == null ? "null" : raw).append('}');
        return true;
    }

    private void dispatch(StringBuilder ch, boolean any) {
        if (!any || listener == null) return;
        ch.append('}');
        listener.accept(ch.toString());
    }

    private void persist(String k, String raw) {
        io.execute(() -> {
            File f = new File(dir, k + ".json");
            if (raw == null) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
                return;
            }
            File tmp = new File(dir, k + ".tmp");
            try (FileOutputStream o = new FileOutputStream(tmp)) {
                o.write(raw.getBytes(StandardCharsets.UTF_8));
                o.getFD().sync();
            } catch (IOException e) {
                return;
            }
            //noinspection ResultOfMethodCallIgnored
            tmp.renameTo(f);
        });
    }
}
