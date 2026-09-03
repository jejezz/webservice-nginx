package com.ptype.rtcrelay;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONObject;

/**
 * RTC 시그널링 클라이언트.
 *
 *   RtcRelayClient client = new RtcRelayClient(http, "wss://c-a3f19c04.rtc.zoomon.art", listener);
 *   client.connect();
 *   client.invite("12345678",
 *                 RtcMessage.address("101B405U", "192.168.0.157"),
 *                 RtcMessage.address("101B203U", "192.168.0.167:8088"),
 *                 "interphone");
 *   // ClientIdAssigned 가 오면 그때부터 offer/answer/candidate 를 보낼 수 있다
 *
 * 스레드: OkHttp 가 자기 스레드에서 콜백을 부른다. UI 를 만지려면 받는 쪽에서
 * 메인 스레드로 옮겨야 한다.
 */
public final class RtcRelayClient {

    private static final String PREFIX_ERROR = "ERROR:";
    private static final String PREFIX_UNPARSED = "I don't know what to do with:";

    public interface Listener {
        void onOpen();
        void onEvent(@NonNull ServerEvent event);
        void onClosed(int code, @NonNull String reason);
        void onFailure(@NonNull Throwable t);
    }

    private final OkHttpClient http;
    private final String baseWsUrl;
    private final Listener listener;

    @Nullable private WebSocket socket;

    /** invite 응답으로 서버가 준 값. 이후 모든 메시지에 실어야 중계된다. */
    private volatile String clientId = "";

    private String roomId = "";
    private String sender = "";
    private String receiver = "";
    private String device = "";

    public RtcRelayClient(@NonNull OkHttpClient http, @NonNull String baseWsUrl,
                          @NonNull Listener listener) {
        this.http = http;
        this.baseWsUrl = baseWsUrl;
        this.listener = listener;
    }

    @NonNull
    public String getClientId() { return clientId; }

    public void connect() {
        // 경로는 반드시 /ws 다. 다른 경로면 서버가 이유 없이 닫는다.
        Request request = new Request.Builder().url(baseWsUrl + "/ws").build();
        socket = http.newWebSocket(request, new SocketListener());
    }

    public void close() {
        if (socket != null) socket.close(1000, "bye");
        socket = null;
    }

    /**
     * 방에 들어간다. 첫 참가자면 서버가 receiver 주소의 단말에 FCM 푸시를 보낸다.
     * 응답으로 clientid 가 오며, 그 전에 보낸 시그널링은 중계되지 않는다.
     */
    public void invite(String roomId, String sender, String receiver, String device) {
        invite(roomId, sender, receiver, device, "100");
    }

    public void invite(String roomId, String sender, String receiver, String device, String code) {
        this.roomId = roomId;
        this.sender = sender;
        this.receiver = receiver;
        this.device = device;
        send(new RtcMessage("invite", roomId, sender, receiver, device, "", code, ""));
    }

    /** 푸시를 받고 들어갈 때 쓴다. 착신 쪽 경로다. */
    public void inviteAck(@NonNull RtcMessage push) {
        this.roomId = push.roomid;
        // 푸시의 sender/receiver 는 발신자 기준이므로 뒤집어 쓴다
        this.sender = push.receiver;
        this.receiver = push.sender;
        this.device = push.device;
        send(new RtcMessage("invite-ack", roomId, sender, receiver, device, "", push.code, ""));
    }

    public void offer(String sdp) { relay("offer", sdp); }
    public void answer(String sdp) { relay("answer", sdp); }
    public void accept() { relay("accept", ""); }
    public void candidate(String candidateJson) { relay("candidate", candidateJson); }
    public void removeCandidates() { relay("remove-candidates", ""); }

    /** 통화 종료. 서버가 방에서 빼낸 뒤 상대에게 중계한다. */
    public void bye() { relay("bye", ""); }

    /**
     * SDP·ICE 는 extendParam 에 실어 보낸다.
     * 서버는 이 필드를 들여다보지 않고 원본 그대로 상대에게 넘긴다.
     */
    private void relay(String method, String payload) {
        if (clientId.isEmpty()) {
            listener.onEvent(new ServerEvent.Unknown("clientid 가 아직 없습니다. invite 응답을 기다리세요."));
            return;
        }
        send(new RtcMessage(method, roomId, sender, receiver, device, clientId, "", payload));
    }

    private void send(@NonNull RtcMessage msg) {
        WebSocket ws = socket;
        if (ws == null) {
            listener.onFailure(new IllegalStateException("연결되어 있지 않습니다"));
            return;
        }
        ws.send(msg.toJson());
    }

    private final class SocketListener extends WebSocketListener {
        @Override public void onOpen(@NonNull WebSocket webSocket, @NonNull Response response) {
            listener.onOpen();
        }

        @Override public void onMessage(@NonNull WebSocket webSocket, @NonNull String text) {
            listener.onEvent(parse(text));
        }

        @Override public void onMessage(@NonNull WebSocket webSocket, @NonNull ByteString bytes) {
            listener.onEvent(parse(bytes.utf8()));
        }

        @Override public void onClosed(@NonNull WebSocket webSocket, int code, @NonNull String reason) {
            clientId = "";
            listener.onClosed(code, reason);
        }

        @Override public void onFailure(@NonNull WebSocket webSocket, @NonNull Throwable t,
                                        @Nullable Response response) {
            clientId = "";
            listener.onFailure(t);
        }
    }

    /**
     * 서버가 보내는 세 가지를 구분한다.
     *
     *   {"method":"update","clientid":"..."}   invite 응답 (JSON)
     *   {...}                                  중계된 시그널링 (JSON)
     *   ERROR:&lt;사유&gt;                     평문. 직후 연결이 닫힌다
     *   I don't know what to do with:&lt;원본&gt;  평문. 보낸 형식이 틀렸다는 뜻
     */
    @NonNull
    private ServerEvent parse(@NonNull String text) {
        if (text.startsWith(PREFIX_ERROR)) {
            return new ServerEvent.ServerError(text.substring(PREFIX_ERROR.length()).trim());
        }
        if (text.startsWith(PREFIX_UNPARSED)) {
            return new ServerEvent.NotUnderstood(text.substring(PREFIX_UNPARSED.length()));
        }

        JSONObject json;
        try {
            json = new JSONObject(text);
        } catch (Exception e) {
            return new ServerEvent.Unknown(text);
        }

        if ("update".equals(json.optString("method")) && json.has("clientid")) {
            clientId = json.optString("clientid");
            return new ServerEvent.ClientIdAssigned(clientId);
        }

        return new ServerEvent.Signal(RtcMessage.fromJson(json), json);
    }
}
