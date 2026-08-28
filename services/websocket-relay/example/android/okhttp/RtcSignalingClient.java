package com.wsrelay.api;

import android.content.Context;
import android.util.Log;

import com.wsrelay.api.models.ClientMessage;
import com.wsrelay.api.models.ResponseParser;
import com.wsrelay.api.models.ServerMessage;
import com.wsrelay.api.models.WsMethod;

import org.json.JSONObject;

import okhttp3.OkHttpClient;

/**
 * RTC signalling over /relay/rtc.
 *
 * Wraps WsRelayWebSocketClient with the room protocol so callers deal in
 * offers and answers rather than raw frames.
 *
 * The protocol has one rule that is easy to get wrong: **you must send INVITE
 * first and wait for the relay's reply before sending anything else.** The
 * relay answers with {"method":"update","clientid":"12345678"}; every later
 * message must carry that clientid, and messages sent before it arrives are
 * dropped without any error. This class enforces that by queueing nothing —
 * onJoined() is your signal that the room is ready.
 *
 * Typical call flow (receiving a doorbell):
 *   1. FCM push arrives            -> InviteNotification.roomId
 *   2. connect()                   -> onConnected()
 *   3. join(roomId, myAddress, …)  -> onJoined(clientId)
 *   4. sendOffer / sendAnswer / sendCandidate as WebRTC negotiates
 *   5. leave()                     -> relay drops you and tells the peer
 *
 * Usage:
 *   RtcSignalingClient rtc = new RtcSignalingClient.Builder("https://relay.example.com")
 *       .sslCertificate(context, R.raw.server_cert)
 *       .listener(new RtcSignalingClient.Listener() {
 *           public void onConnected() { rtc.join(roomId, me, peer, "mobile"); }
 *           public void onJoined(String clientId) { ... start WebRTC ... }
 *           public void onSignal(ClientMessage msg) { ... }
 *           public void onServerMessage(ServerMessage msg) { ... }
 *           public void onDisconnected(int code, String reason) { ... }
 *           public void onError(Exception e) { ... }
 *       })
 *       .build();
 *   rtc.connect();
 */
public class RtcSignalingClient {

    private static final String TAG = "WsRelayRtc";

    private final WsRelayWebSocketClient socket;
    private final Listener listener;

    /** Assigned by the relay in its reply to INVITE. Null until then. */
    private volatile String clientId;
    private volatile String roomId;
    private volatile String selfAddress;

    // ──────────────────────────────────────────────
    // Listener
    // ──────────────────────────────────────────────

    public interface Listener {
        /** Socket is open. Call join() here. */
        void onConnected();

        /** The relay accepted the invite and assigned this client id. */
        void onJoined(String clientId);

        /** Signalling relayed from the peer: offer, answer, candidate, bye, … */
        void onSignal(ClientMessage message);

        /** The relay talking about itself, including errors. */
        default void onServerMessage(ServerMessage message) {}

        void onDisconnected(int code, String reason);

        void onError(Exception e);

        default void onReconnecting(int attempt, long delayMs) {}
    }

    // ──────────────────────────────────────────────
    // Construction
    // ──────────────────────────────────────────────

    private RtcSignalingClient(Builder b) {
        this.listener = b.listener;

        WsRelayWebSocketClient.Builder ws = new WsRelayWebSocketClient.Builder(b.serverUrl)
                .path(WsRelayWebSocketClient.PATH_RTC)
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

    /** Leave the room politely, then close. */
    public void disconnect() {
        if (isJoined()) leave();
        socket.disconnect();
    }

    public void shutdown() { socket.shutdown(); }

    public boolean isConnected() { return socket.isConnected(); }

    /** True once the relay has answered INVITE. Sending before this is dropped. */
    public boolean isJoined() { return clientId != null; }

    public String getClientId() { return clientId; }
    public String getRoomId() { return roomId; }

    // ──────────────────────────────────────────────
    // Protocol
    // ──────────────────────────────────────────────

    /**
     * Join a room. Send this first; wait for onJoined() before anything else.
     *
     * @param roomId   from the push (InviteNotification.roomId)
     * @param self     your address, "rtc:101B203U@host"
     * @param peer     who you are talking to, "rtc:101B405U@host"
     * @param device   free-form device tag, e.g. "mobile"
     */
    public boolean join(String roomId, String self, String peer, String device) {
        this.roomId = roomId;
        this.selfAddress = self;

        ClientMessage m = new ClientMessage(WsMethod.INVITE, self, peer, roomId, "0");
        m.device = device == null ? "" : device;
        return socket.send(m);
    }

    /** Join and restrict the resulting push to one account. */
    public boolean joinTargeting(String roomId, String self, String peer, String device, String targetEmail) {
        this.roomId = roomId;
        this.selfAddress = self;

        ClientMessage m = new ClientMessage(WsMethod.INVITE, self, peer, roomId, "0");
        m.device = device == null ? "" : device;
        try {
            m.targetAgent(targetEmail);
        } catch (Exception e) {
            listener.onError(e);
            return false;
        }
        return socket.send(m);
    }

    public boolean sendOffer(String peer, String sdp) { return signal(WsMethod.OFFER, peer, sdp); }
    public boolean sendAnswer(String peer, String sdp) { return signal(WsMethod.ANSWER, peer, sdp); }
    public boolean sendAccept(String peer) { return signal(WsMethod.ACCEPT, peer, ""); }
    public boolean sendCandidate(String peer, String candidate) { return signal(WsMethod.CANDIDATE, peer, candidate); }
    public boolean removeCandidates(String peer) { return signal(WsMethod.REMOVE_CANDIDATES, peer, ""); }

    /** Hang up. The relay removes you from the room and forwards this to the peer. */
    public boolean leave() {
        String peer = "";
        boolean sent = signal(WsMethod.BYE, peer, "");
        clientId = null;
        roomId = null;
        return sent;
    }

    /**
     * Send an arbitrary signalling message.
     *
     * The payload rides in "code" — that is the only free field the relay
     * forwards untouched for these methods.
     */
    public boolean signal(String method, String peer, String payload) {
        if (!isJoined()) {
            Log.w(TAG, "not joined yet, dropping " + method);
            return false;
        }
        ClientMessage m = new ClientMessage(method, selfAddress, peer, roomId, clientId);
        m.code = payload == null ? "" : payload;
        return socket.send(m);
    }

    /** Escape hatch for anything this wrapper does not cover. */
    public boolean send(ClientMessage message) { return socket.send(message); }

    public WsRelayWebSocketClient socket() { return socket; }

    // ──────────────────────────────────────────────
    // Frame routing
    // ──────────────────────────────────────────────

    private class SocketListener implements WsRelayWebSocketClient.Listener {

        @Override
        public void onConnected() {
            // A reconnect gets a fresh client id, so the old one is void.
            clientId = null;
            listener.onConnected();
        }

        @Override
        public void onJsonMessage(JSONObject json) {
            switch (ResponseParser.classify(json)) {
                case UPDATE:
                    clientId = json.optString("clientid", null);
                    Log.i(TAG, "joined room " + roomId + " as " + clientId);
                    listener.onJoined(clientId);
                    break;

                case SIGNAL:
                    listener.onSignal(ClientMessage.fromJson(json));
                    break;

                case SERVER:
                    listener.onServerMessage(ServerMessage.fromJson(json));
                    break;

                default:
                    Log.d(TAG, "unrecognised frame: " + json);
            }
        }

        @Override
        public void onDisconnected(int code, String reason) {
            clientId = null;
            listener.onDisconnected(code, reason);
        }

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

        public RtcSignalingClient build() {
            if (listener == null) throw new IllegalStateException("listener is required");
            return new RtcSignalingClient(this);
        }
    }
}
