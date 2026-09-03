package com.wsrelay.api;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.wsrelay.api.models.ClientMessage;
import com.wsrelay.api.models.IoTMessage;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.InputStream;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * WebSocket client for the websocket-relay server.
 *
 * Handles connection, automatic reconnection with backoff, ping/pong
 * heartbeat, and self-signed SSL certificates.
 *
 * Endpoints (behind nginx):
 *   wss://{host}/relay/rtc    RTC signalling  — see RtcSignalingClient
 *   wss://{host}/relay/iot   IoT devices     — see IotClient
 *
 * There is no authentication on these sockets. The relay decides what you may
 * do from the room you join, so treat the room id as a capability and do not
 * log it. Anything other than those two paths is closed immediately with
 * code 1008.
 *
 * Most callers want RtcSignalingClient or IotClient instead of this class —
 * they add the message vocabulary on top. Use this directly only if you want
 * raw frames.
 *
 * Usage:
 *   WsRelayWebSocketClient ws = new WsRelayWebSocketClient.Builder("https://relay.example.com")
 *       .path(WsRelayWebSocketClient.PATH_RTC)
 *       .sslCertificate(context, R.raw.server_cert)
 *       .listener(new WsRelayWebSocketClient.Listener() {
 *           public void onConnected() { ... }
 *           public void onJsonMessage(JSONObject json) { ... }
 *           public void onDisconnected(int code, String reason) { ... }
 *           public void onError(Exception e) { ... }
 *       })
 *       .build();
 *
 *   ws.connect();
 *   ws.sendJson(message.toJson());
 *   ws.disconnect();
 */
public class WsRelayWebSocketClient {

    private static final String TAG = "WsRelayWS";

    public static final String PATH_RTC = "/relay/rtc";
    public static final String PATH_IOT = "/relay/iot";

    /** The relay closes unknown paths with this code. Reconnecting will not help. */
    public static final int CLOSE_UNKNOWN_PATH = 1008;

    // ──────────────────────────────────────────────
    // Configuration
    // ──────────────────────────────────────────────

    private final String url;
    private final Listener listener;
    private final OkHttpClient httpClient;
    private final Handler mainHandler;

    private final boolean autoReconnect;
    private final int maxReconnectAttempts;
    private final long initialReconnectDelay;
    private final long maxReconnectDelay;
    private final boolean callbackOnMainThread;

    // ──────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────

    private WebSocket webSocket;
    private final AtomicBoolean connected = new AtomicBoolean(false);
    private final AtomicBoolean intentionalClose = new AtomicBoolean(false);
    private final AtomicInteger reconnectAttempts = new AtomicInteger(0);

    public enum ConnectionState {
        DISCONNECTED, CONNECTING, CONNECTED, RECONNECTING
    }
    private volatile ConnectionState state = ConnectionState.DISCONNECTED;

    // ──────────────────────────────────────────────
    // Listener
    // ──────────────────────────────────────────────

    public interface Listener {
        void onConnected();

        /** Every text frame, before parsing. */
        default void onMessage(String text) {}

        /** Text frames that parsed as JSON. Nearly everything the relay sends. */
        default void onJsonMessage(JSONObject json) {}

        void onDisconnected(int code, String reason);

        void onError(Exception e);

        /** Fired before each reconnect attempt. */
        default void onReconnecting(int attempt, long delayMs) {}
    }

    // ──────────────────────────────────────────────
    // Construction
    // ──────────────────────────────────────────────

    private WsRelayWebSocketClient(Builder b) {
        this.url = toWebSocketUrl(b.serverUrl, b.path);
        this.listener = b.listener;
        this.autoReconnect = b.autoReconnect;
        this.maxReconnectAttempts = b.maxReconnectAttempts;
        this.initialReconnectDelay = b.initialReconnectDelay;
        this.maxReconnectDelay = b.maxReconnectDelay;
        this.callbackOnMainThread = b.callbackOnMainThread;
        this.mainHandler = new Handler(Looper.getMainLooper());

        OkHttpClient.Builder http = (b.customClient != null ? b.customClient.newBuilder() : new OkHttpClient.Builder())
                .connectTimeout(15, TimeUnit.SECONDS)
                // No read timeout: an idle signalling socket is normal between calls.
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .pingInterval(b.pingInterval, TimeUnit.MILLISECONDS);

        if (b.sslSocketFactory != null && b.trustManager != null) {
            http.sslSocketFactory(b.sslSocketFactory, b.trustManager);
        }

        this.httpClient = http.build();
    }

    /**
     * http(s):// -> ws(s)://, then append the path.
     * Callers usually hold one base URL for both REST and WebSocket, so accept
     * either scheme rather than making them convert it.
     *
     * A bare host is accepted too and becomes wss://. The directory in Firestore
     * stores `host` without a scheme, and without this it fell through both
     * branches below and produced a scheme-less URL that never connects.
     */
    private static String toWebSocketUrl(String serverUrl, String path) {
        String base = serverUrl.endsWith("/") ? serverUrl.substring(0, serverUrl.length() - 1) : serverUrl;
        if (base.startsWith("https://")) base = "wss://" + base.substring(8);
        else if (base.startsWith("http://")) base = "ws://" + base.substring(7);
        else if (!base.contains("://")) base = "wss://" + base;
        return base + path;
    }

    // ──────────────────────────────────────────────
    // Connection
    // ──────────────────────────────────────────────

    public synchronized void connect() {
        if (state == ConnectionState.CONNECTING || state == ConnectionState.CONNECTED) {
            Log.d(TAG, "connect() ignored, already " + state);
            return;
        }

        intentionalClose.set(false);
        state = ConnectionState.CONNECTING;

        Request request = new Request.Builder().url(url).build();
        webSocket = httpClient.newWebSocket(request, new RelayListener());
    }

    /** Close for good. Suppresses auto-reconnect. */
    public synchronized void disconnect() {
        intentionalClose.set(true);
        reconnectAttempts.set(0);

        if (webSocket != null) {
            webSocket.close(1000, "client closing");
            webSocket = null;
        }

        connected.set(false);
        state = ConnectionState.DISCONNECTED;
    }

    /** Drop the socket and free the thread pool. Call from onDestroy. */
    public void shutdown() {
        disconnect();
        httpClient.dispatcher().executorService().shutdown();
        httpClient.connectionPool().evictAll();
    }

    public boolean isConnected() { return connected.get(); }
    public ConnectionState getState() { return state; }
    public String getUrl() { return url; }

    // ──────────────────────────────────────────────
    // Sending
    // ──────────────────────────────────────────────

    /** @return false when the socket is not open or the send queue is full. */
    public boolean sendMessage(String text) {
        WebSocket socket = webSocket;
        if (socket == null || !connected.get()) {
            Log.w(TAG, "send dropped, socket not connected");
            return false;
        }
        return socket.send(text);
    }

    public boolean sendJson(JSONObject json) {
        return sendMessage(json.toString());
    }

    public boolean send(ClientMessage message) {
        try {
            return sendJson(message.toJson());
        } catch (JSONException e) {
            emitError(e);
            return false;
        }
    }

    public boolean send(IoTMessage message) {
        try {
            return sendJson(message.toJson());
        } catch (JSONException e) {
            emitError(e);
            return false;
        }
    }

    // ──────────────────────────────────────────────
    // Socket callbacks
    // ──────────────────────────────────────────────

    private class RelayListener extends WebSocketListener {

        @Override
        public void onOpen(WebSocket socket, Response response) {
            connected.set(true);
            state = ConnectionState.CONNECTED;
            reconnectAttempts.set(0);
            Log.i(TAG, "connected: " + url);
            post(listener::onConnected);
        }

        @Override
        public void onMessage(WebSocket socket, String text) {
            post(() -> listener.onMessage(text));

            JSONObject json;
            try {
                json = new JSONObject(text);
            } catch (JSONException e) {
                // The relay echoes non-JSON input straight back, so this is not
                // necessarily a bug — just nothing a typed listener can use.
                Log.d(TAG, "non-JSON frame ignored");
                return;
            }
            post(() -> listener.onJsonMessage(json));
        }

        @Override
        public void onMessage(WebSocket socket, ByteString bytes) {
            // The relay never sends binary frames.
            Log.d(TAG, "binary frame ignored (" + bytes.size() + " bytes)");
        }

        @Override
        public void onClosing(WebSocket socket, int code, String reason) {
            socket.close(1000, null);
        }

        @Override
        public void onClosed(WebSocket socket, int code, String reason) {
            connected.set(false);
            state = ConnectionState.DISCONNECTED;
            Log.i(TAG, "closed " + code + " " + reason);
            post(() -> listener.onDisconnected(code, reason));

            // 1008 means the path is wrong. Reconnecting would just loop.
            if (code == CLOSE_UNKNOWN_PATH) {
                Log.e(TAG, "server rejected the path: " + url);
                return;
            }
            scheduleReconnect();
        }

        @Override
        public void onFailure(WebSocket socket, Throwable t, Response response) {
            connected.set(false);
            state = ConnectionState.DISCONNECTED;
            Log.w(TAG, "failure: " + t.getMessage());
            post(() -> listener.onError(t instanceof Exception ? (Exception) t : new Exception(t)));
            scheduleReconnect();
        }
    }

    // ──────────────────────────────────────────────
    // Reconnect
    // ──────────────────────────────────────────────

    /**
     * Exponential backoff, capped. Doorbell traffic is bursty and the relay
     * restarts on deploy, so give up slowly rather than hammering.
     */
    private void scheduleReconnect() {
        if (!autoReconnect || intentionalClose.get()) return;

        int attempt = reconnectAttempts.incrementAndGet();
        if (maxReconnectAttempts > 0 && attempt > maxReconnectAttempts) {
            Log.e(TAG, "giving up after " + (attempt - 1) + " reconnect attempts");
            return;
        }

        long delay = Math.min(initialReconnectDelay * (1L << Math.min(attempt - 1, 16)), maxReconnectDelay);
        state = ConnectionState.RECONNECTING;
        Log.i(TAG, "reconnect #" + attempt + " in " + delay + "ms");
        post(() -> listener.onReconnecting(attempt, delay));

        mainHandler.postDelayed(() -> {
            if (!intentionalClose.get()) connect();
        }, delay);
    }

    // ──────────────────────────────────────────────
    // Callback dispatch
    // ──────────────────────────────────────────────

    private void post(Runnable action) {
        if (callbackOnMainThread) mainHandler.post(action);
        else action.run();
    }

    private void emitError(Exception e) {
        post(() -> listener.onError(e));
    }

    // ──────────────────────────────────────────────
    // Builder
    // ──────────────────────────────────────────────

    public static class Builder {
        private final String serverUrl;
        private String path = PATH_RTC;
        private Listener listener;
        private OkHttpClient customClient;

        private boolean autoReconnect = true;
        private int maxReconnectAttempts = 0;          // 0 = forever
        private long initialReconnectDelay = 1000;
        private long maxReconnectDelay = 60000;
        private long pingInterval = 30000;
        private boolean callbackOnMainThread = true;

        private SSLSocketFactory sslSocketFactory;
        private X509TrustManager trustManager;

        /**
         * @param serverUrl e.g. "https://relay.example.com" (http/https or ws/wss),
         *                  or a bare host as stored in the directory
         *                  ("c-a3f19c04.rtc.example.com") — that becomes wss://.
         */
        public Builder(String serverUrl) {
            this.serverUrl = serverUrl;
        }

        /** PATH_RTC or PATH_IOT. Anything else is closed by the server with 1008. */
        public Builder path(String path) { this.path = path; return this; }

        public Builder listener(Listener listener) { this.listener = listener; return this; }
        public Builder httpClient(OkHttpClient client) { this.customClient = client; return this; }
        public Builder autoReconnect(boolean enabled) { this.autoReconnect = enabled; return this; }

        /** 0 means keep trying forever. */
        public Builder maxReconnectAttempts(int attempts) { this.maxReconnectAttempts = attempts; return this; }
        public Builder reconnectDelay(long initialMs, long maxMs) {
            this.initialReconnectDelay = initialMs;
            this.maxReconnectDelay = maxMs;
            return this;
        }

        /**
         * OkHttp ping interval. The relay also pings from its side every 60s and
         * closes clients that miss a pong, so keep this below that.
         */
        public Builder pingInterval(long ms) { this.pingInterval = ms; return this; }

        /** Set false to receive callbacks on OkHttp's thread instead of the main looper. */
        public Builder callbackOnMainThread(boolean enabled) { this.callbackOnMainThread = enabled; return this; }

        /**
         * Trust a self-signed server certificate, e.g. R.raw.server_cert.
         *
         * The relay sits behind nginx with the stack's own CA, so a stock
         * Android trust store will reject it. Pin the certificate here rather
         * than disabling verification.
         */
        public Builder sslCertificate(Context context, int rawResourceId) {
            try (InputStream in = context.getResources().openRawResource(rawResourceId)) {
                CertificateFactory factory = CertificateFactory.getInstance("X.509");
                Certificate certificate = factory.generateCertificate(in);

                KeyStore keyStore = KeyStore.getInstance(KeyStore.getDefaultType());
                keyStore.load(null, null);
                keyStore.setCertificateEntry("relay", certificate);

                TrustManagerFactory tmf = TrustManagerFactory.getInstance(
                        TrustManagerFactory.getDefaultAlgorithm());
                tmf.init(keyStore);

                TrustManager[] managers = tmf.getTrustManagers();
                if (managers.length != 1 || !(managers[0] instanceof X509TrustManager)) {
                    throw new IllegalStateException("unexpected trust managers: " + managers.length);
                }

                SSLContext sslContext = SSLContext.getInstance("TLS");
                sslContext.init(null, managers, null);

                this.trustManager = (X509TrustManager) managers[0];
                this.sslSocketFactory = sslContext.getSocketFactory();
            } catch (Exception e) {
                throw new IllegalArgumentException("could not load certificate", e);
            }
            return this;
        }

        public WsRelayWebSocketClient build() {
            if (listener == null) throw new IllegalStateException("listener is required");
            return new WsRelayWebSocketClient(this);
        }
    }
}
