package com.ptype.rtcrelay;

import org.json.JSONObject;

/** 서버가 보내온 것을 종류별로 나눈 결과. */
public abstract class ServerEvent {

    private ServerEvent() { }

    /** invite 응답. 이 clientId 를 이후 모든 메시지에 넣어야 한다. */
    public static final class ClientIdAssigned extends ServerEvent {
        public final String clientId;
        public ClientIdAssigned(String clientId) { this.clientId = clientId; }
    }

    /** 방의 상대가 보낸 시그널링이 중계된 것. */
    public static final class Signal extends ServerEvent {
        public final RtcMessage message;
        public final JSONObject raw;
        public Signal(RtcMessage message, JSONObject raw) { this.message = message; this.raw = raw; }
    }

    /** 서버가 평문 "ERROR:..." 를 보낸 경우. 이 직후 연결이 닫힌다. */
    public static final class ServerError extends ServerEvent {
        public final String reason;
        public ServerError(String reason) { this.reason = reason; }
    }

    /** 서버가 파싱하지 못한 입력에 응답한 것. 보낸 쪽 형식이 틀렸다는 뜻이다. */
    public static final class NotUnderstood extends ServerEvent {
        public final String echo;
        public NotUnderstood(String echo) { this.echo = echo; }
    }

    /** 위 어디에도 안 맞는 것. */
    public static final class Unknown extends ServerEvent {
        public final String raw;
        public Unknown(String raw) { this.raw = raw; }
    }
}
