package com.ptype.rtcrelay;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONObject;

/**
 * IoT 제어 채널.
 *
 * RTC 와 다른 경로(/iot)와 다른 메시지 형태를 쓴다. 서버의 IoTMessage 와 맞춘다.
 *
 *   { "method":"create", "roomid":"1234", "clientid":0,
 *     "address":"101B1001U", "rescode":"0", "payload":{} }
 *
 * 알려진 문제: 성공 응답이 서버의 sendOk() 를 거치면서 "I don't know what to do with:"
 * 접두사가 붙어 나온다. 아래 parse() 가 접두사가 있든 없든 처리한다.
 */
public final class IotRelayClient {

    private static final String PREFIX_ERROR = "ERROR:";
    private static final String PREFIX_UNPARSED = "I don't know what to do with:";

    public interface Listener {
        void onOpen();
        /** rescode "200" 이면 성공이다. */
        void onResponse(String method, String roomId, int clientId, String resCode, @Nullable Object payload);
        void onServerError(String reason);
        void onClosed(int code, String reason);
        void onFailure(Throwable t);
    }

    private final OkHttpClient http;
    private final String baseWsUrl;
    private final Listener listener;

    @Nullable private WebSocket socket;
    private volatile int clientId = 0;

    public IotRelayClient(@NonNull OkHttpClient http, @NonNull String baseWsUrl,
                          @NonNull Listener listener) {
        this.http = http;
        this.baseWsUrl = baseWsUrl;
        this.listener = listener;
    }

    public int getClientId() { return clientId; }

    public void connect() {
        Request request = new Request.Builder().url(baseWsUrl + "/iot").build();
        socket = http.newWebSocket(request, new SocketListener());
    }

    public void close() {
        if (socket != null) socket.close(1000, "bye");
        socket = null;
    }

    /** 방을 만든다. 이미 있으면 같은 clientid 일 때만 다시 붙는다. */
    public void create(String roomId, String address, @Nullable Object payload) {
        send("create", roomId, address, payload);
    }

    /** create 와 같은 처리다. 등록 정보를 갱신할 때 쓴다. */
    public void modify(String roomId, String address, @Nullable Object payload) {
        send("modify", roomId, address, payload);
    }

    public void join(String roomId, String address) { send("join", roomId, address, null); }
    public void subscribe(String roomId, String address) { send("subscribe", roomId, address, null); }
    public void unsubscribe(String roomId, String address) { send("unsubscribe", roomId, address, null); }

    /** 장치 제어 명령. payload 형식은 장치가 정한다. */
    public void control(String roomId, String address, @NonNull Object payload) {
        send("iot-control", roomId, address, payload);
    }

    /** 상태 조회. 응답이 비동기로 온다. */
    public void status(String roomId, String address) { send("iot-status", roomId, address, null); }

    private void send(String method, String roomId, String address, @Nullable Object payload) {
        WebSocket ws = socket;
        if (ws == null) {
            listener.onFailure(new IllegalStateException("연결되어 있지 않습니다"));
            return;
        }
        JSONObject json = new JSONObject();
        try {
            json.put("method", method);
            json.put("roomid", roomId);
            json.put("clientid", clientId);
            json.put("address", address);
            json.put("rescode", "0");
            json.put("payload", payload == null ? JSONObject.NULL : payload);
        } catch (Exception e) {
            listener.onFailure(e);
            return;
        }
        ws.send(json.toString());
    }

    private final class SocketListener extends WebSocketListener {
        @Override public void onOpen(@NonNull WebSocket webSocket, @NonNull Response response) {
            listener.onOpen();
        }

        @Override public void onMessage(@NonNull WebSocket webSocket, @NonNull String text) {
            parse(text);
        }

        @Override public void onClosed(@NonNull WebSocket webSocket, int code, @NonNull String reason) {
            clientId = 0;
            listener.onClosed(code, reason);
        }

        @Override public void onFailure(@NonNull WebSocket webSocket, @NonNull Throwable t,
                                        @Nullable Response response) {
            clientId = 0;
            listener.onFailure(t);
        }
    }

    private void parse(@NonNull String text) {
        if (text.startsWith(PREFIX_ERROR)) {
            listener.onServerError(text.substring(PREFIX_ERROR.length()).trim());
            return;
        }

        // 성공 응답에 붙어 나오는 접두사를 떼어낸다 (서버 sendOk 의 부작용)
        String body = text.startsWith(PREFIX_UNPARSED)
                ? text.substring(PREFIX_UNPARSED.length()) : text;

        JSONObject json;
        try {
            json = new JSONObject(body);
        } catch (Exception e) {
            listener.onServerError("파싱 실패: " + text);
            return;
        }

        // 서버가 배정한 clientid 를 보관한다. 이후 요청에 실어야 같은 세션으로 인식된다.
        int assigned = json.optInt("clientid", 0);
        if (assigned != 0) clientId = assigned;

        listener.onResponse(
                json.optString("method"),
                json.optString("roomid"),
                assigned,
                json.optString("rescode"),
                json.isNull("payload") ? null : json.opt("payload"));
    }
}
