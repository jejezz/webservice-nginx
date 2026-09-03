package com.wsrelay.api;

import android.content.Context;
import android.util.Log;

import com.wsrelay.api.models.IoTMessage;
import com.wsrelay.api.models.ServerMessage;
import com.wsrelay.api.models.WsMethod;

import org.json.JSONObject;

import okhttp3.OkHttpClient;

/**
 * IoT device control over /relay/iot.
 *
 * Same socket machinery as RtcSignalingClient, different vocabulary. Devices
 * live in rooms just like RTC clients do — a wall pad CREATEs a room, phones
 * SUBSCRIBE to it, and control commands are relayed to whoever is in it.
 *
 * Field requirements differ per method and the server rejects with a
 * ServerMessage rather than closing, so watch onServerMessage:
 *   create / modify / join / subscribe   need roomid
 *   iot-control / iot-status / unsubscribe  need roomid AND clientid
 *
 * Replies come back as IoTMessage with "rescode" set — "200" means accepted.
 *
 * Usage:
 *   IotClient iot = new IotClient.Builder("https://relay.example.com")
 *       .sslCertificate(context, R.raw.server_cert)
 *       .listener(new IotClient.Listener() {
 *           public void onConnected() { iot.subscribe(roomId); }
 *           public void onMessage(IoTMessage msg) { ... }
 *           public void onServerMessage(ServerMessage msg) { ... }
 *           public void onDisconnected(int code, String reason) { ... }
 *           public void onError(Exception e) { ... }
 *       })
 *       .build();
 *   iot.connect();
 */
public class IotClient {

    private static final String TAG = "WsRelayIot";

    /** rescode the relay sends when it accepted a request. */
    public static final String CODE_OK = "200";

    private final WsRelayWebSocketClient socket;
    private final Listener listener;

    private volatile String roomId;
    private volatile long clientId;

    // ──────────────────────────────────────────────
    // Listener
    // ──────────────────────────────────────────────

    public interface Listener {
        void onConnected();

        /** Any IoT frame: command replies, status pushes, relayed control. */
        void onMessage(IoTMessage message);

        /** The relay reporting a problem — usually a missing required field. */
        default void onServerMessage(ServerMessage message) {}

        void onDisconnected(int code, String reason);

        void onError(Exception e);

        default void onReconnecting(int attempt, long delayMs) {}
    }

    // ──────────────────────────────────────────────
    // Construction
    // ──────────────────────────────────────────────

    private IotClient(Builder b) {
        this.listener = b.listener;

        WsRelayWebSocketClient.Builder ws = new WsRelayWebSocketClient.Builder(b.serverUrl)
                .path(WsRelayWebSocketClient.PATH_IOT)
                .autoReconnect(b.autoReconnect)
                .callbackOnMainThread(b.callbackOnMainThread)
                .listener(new SocketListener());

        if (b.customClient != null) ws.httpClient(b.customClient);
        if (b.certContext != null) ws.sslCertificate(b.certContext, b.certResourceId);

        this.socket = ws.build();
    }

    // ──────────────────────────────────────────────
    // Lifecycle
    // ──────────────────────────────────────────────

    public void connect() { socket.connect(); }
    public void disconnect() { socket.disconnect(); }
    public void shutdown() { socket.shutdown(); }
    public boolean isConnected() { return socket.isConnected(); }

    public String getRoomId() { return roomId; }
    public long getClientId() { return clientId; }

    /** Remember the identity later calls need. Set after the relay confirms create/join. */
    public void bind(String roomId, long clientId) {
        this.roomId = roomId;
        this.clientId = clientId;
    }

    // ──────────────────────────────────────────────
    // Protocol
    // ──────────────────────────────────────────────

    /**
     * Create a room for this device, or rebind to it after a reconnect.
     *
     * Reconnecting only works when you pass the same clientid you were given
     * originally — the relay rejects a create for an existing room from an
     * unknown clientid ("Room already exists, not the same clientid").
     */
    public boolean create(String roomId, long clientId, Object payload) {
        this.roomId = roomId;
        this.clientId = clientId;
        return socket.send(IoTMessage.build(WsMethod.CREATE, roomId, clientId, "0", payload));
    }

    /** Same handler as create on the server; use it to refresh the payload. */
    public boolean modify(String roomId, long clientId, Object payload) {
        return socket.send(IoTMessage.build(WsMethod.MODIFY, roomId, clientId, "0", payload));
    }

    public boolean join(String roomId, long clientId) {
        this.roomId = roomId;
        this.clientId = clientId;
        return socket.send(IoTMessage.build(WsMethod.JOIN, roomId, clientId, "0", null));
    }

    /** Start receiving this room's status pushes. Needs only roomid. */
    public boolean subscribe(String roomId) {
        this.roomId = roomId;
        return socket.send(IoTMessage.build(WsMethod.SUBSCRIBE, roomId, clientId, "0", null));
    }

    /** Stop receiving them. Needs roomid and clientid. */
    public boolean unsubscribe() {
        return requireBound(WsMethod.UNSUBSCRIBE)
                && socket.send(IoTMessage.build(WsMethod.UNSUBSCRIBE, roomId, clientId, "0", null));
    }

    /**
     * Send a control command. The payload is device-specific and the relay
     * forwards it without looking inside.
     */
    public boolean control(Object payload) {
        return requireBound(WsMethod.IOT_CONTROL)
                && socket.send(IoTMessage.build(WsMethod.IOT_CONTROL, roomId, clientId, "0", payload));
    }

    /** Ask for current device status. The reply arrives via onMessage. */
    public boolean status() {
        return requireBound(WsMethod.IOT_STATUS)
                && socket.send(IoTMessage.build(WsMethod.IOT_STATUS, roomId, clientId, "0", null));
    }

    /** Escape hatch for anything this wrapper does not cover. */
    public boolean send(IoTMessage message) { return socket.send(message); }

    public WsRelayWebSocketClient socket() { return socket; }

    /**
     * These methods need both ids. Without them the relay answers with an error
     * ServerMessage, which is easy to miss — fail loudly on our side instead.
     */
    private boolean requireBound(String method) {
        if (roomId == null || roomId.isEmpty() || clientId == 0) {
            Log.w(TAG, method + " needs roomid and clientid; call create/join first");
            return false;
        }
        return true;
    }

    // ──────────────────────────────────────────────
    // Frame routing
    // ──────────────────────────────────────────────

    private class SocketListener implements WsRelayWebSocketClient.Listener {

        @Override
        public void onConnected() { listener.onConnected(); }

        @Override
        public void onJsonMessage(JSONObject json) {
            // IoT frames always carry "method"; the relay's own errors do not.
            if (json.has("method")) {
                listener.onMessage(IoTMessage.fromJson(json));
            } else if (ServerMessage.looksLike(json)) {
                listener.onServerMessage(ServerMessage.fromJson(json));
            } else {
                Log.d(TAG, "unrecognised frame: " + json);
            }
        }

        @Override
        public void onDisconnected(int code, String reason) { listener.onDisconnected(code, reason); }

        @Override
        public void onError(Exception e) { listener.onError(e); }

        @Override
        public void onReconnecting(int attempt, long delayMs) { listener.onReconnecting(attempt, delayMs); }
    }

    // ──────────────────────────────────────────────
    // Builder
    // ──────────────────────────────────────────────

    public static class Builder {
        private final String serverUrl;
        private Listener listener;
        private OkHttpClient customClient;
        private boolean autoReconnect = true;
        private boolean callbackOnMainThread = true;
        private Context certContext;
        private int certResourceId;

        public Builder(String serverUrl) { this.serverUrl = serverUrl; }

        public Builder listener(Listener listener) { this.listener = listener; return this; }
        public Builder httpClient(OkHttpClient client) { this.customClient = client; return this; }
        public Builder autoReconnect(boolean enabled) { this.autoReconnect = enabled; return this; }
        public Builder callbackOnMainThread(boolean enabled) { this.callbackOnMainThread = enabled; return this; }

        public Builder sslCertificate(Context context, int rawResourceId) {
            this.certContext = context;
            this.certResourceId = rawResourceId;
            return this;
        }

        public IotClient build() {
            if (listener == null) throw new IllegalStateException("listener is required");
            return new IotClient(this);
        }
    }
}
