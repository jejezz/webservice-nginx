package com.ptype.rtcrelay;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.Map;

/**
 * RTC 시그널링 메시지.
 *
 * 서버의 ClientMessage(src/libs/clientMessage.ts)와 필드가 1:1로 맞는다.
 * roomid·sender·device·receiver 는 서버가 모든 메시지에서 검사하므로 비우면 안 된다.
 */
public final class RtcMessage {

    public final String method;
    public final String roomid;
    public final String sender;
    public final String receiver;
    public final String device;
    public final String clientid;
    public final String code;
    public final String extendParam;

    public RtcMessage(String method, String roomid, String sender, String receiver,
                      String device, String clientid, String code, String extendParam) {
        this.method = method;
        this.roomid = roomid;
        this.sender = sender;
        this.receiver = receiver;
        this.device = device;
        this.clientid = clientid == null ? "" : clientid;
        this.code = code == null ? "" : code;
        this.extendParam = extendParam == null ? "" : extendParam;
    }

    /** 서버가 요구하는 주소 형식: rtc:&lt;주소&gt;@&lt;호스트&gt; */
    public static String address(String addr, String host) {
        return "rtc:" + addr + "@" + host;
    }

    @NonNull
    public String toJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("method", method);
            o.put("roomid", roomid);
            o.put("sender", sender);
            o.put("receiver", receiver);
            o.put("device", device);
            o.put("clientid", clientid);
            o.put("code", code);
            o.put("extendParam", extendParam);
        } catch (JSONException e) {
            throw new IllegalStateException(e); // 문자열만 넣으므로 발생하지 않는다
        }
        return o.toString();
    }

    public static RtcMessage fromJson(@NonNull JSONObject j) {
        return new RtcMessage(
                j.optString("method"), j.optString("roomid"), j.optString("sender"),
                j.optString("receiver"), j.optString("device"), j.optString("clientid"),
                j.optString("code"), j.optString("extendParam"));
    }

    /**
     * FCM data 페이로드를 메시지로 옮긴다.
     *
     * 푸시는 roomId(대문자 I), WebSocket 규약은 roomid(소문자)를 쓴다.
     * 서버 쪽 철자가 갈려 있어 여기서 둘 다 받는다.
     */
    public static RtcMessage fromPushData(@NonNull Map<String, String> data) {
        String room = data.get("roomId");
        if (room == null) room = data.get("roomid");
        return new RtcMessage(
                or(data.get("method"), "invite"),
                or(room, ""),
                or(data.get("sender"), ""),
                or(data.get("receiver"), ""),
                or(data.get("device"), ""),
                "", or(data.get("code"), ""), "");
    }

    private static String or(@Nullable String v, String fallback) {
        return v == null ? fallback : v;
    }
}
