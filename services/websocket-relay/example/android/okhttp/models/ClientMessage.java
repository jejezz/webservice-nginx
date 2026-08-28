package com.wsrelay.api.models;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * RTC signalling message — the payload on /relay/rtc.
 *
 * Address format is "rtc:{address}@{host}", e.g. "rtc:101B203U@192.168.0.167".
 * The relay strips the "rtc:" prefix and the "@..." suffix when it looks up
 * push tokens, so the middle part must match the address you registered with
 * (POST /relay/register/mobile).
 *
 * Every field is a String, including roomid and clientid. The relay compares
 * them loosely but the server-side validator rejects messages where sender,
 * roomid or clientid is missing, so fill them in.
 */
public class ClientMessage {

    public String method = "";
    public String sender = "";
    public String receiver = "";
    public String code = "";
    public String device = "";
    public String roomid = "0";
    public String clientid = "0";

    /**
     * Free-form JSON string passed through untouched, with one exception:
     * on INVITE the relay parses it and, if it finds
     * {"targetAgent":"someone@example.com"}, sends the push only to that
     * account's devices instead of every device at the address.
     */
    public String extendParam = "";

    public ClientMessage() {}

    public ClientMessage(String method, String sender, String receiver, String roomid, String clientid) {
        this.method = method;
        this.sender = sender;
        this.receiver = receiver;
        this.roomid = roomid;
        this.clientid = clientid;
    }

    public static ClientMessage fromJson(JSONObject json) {
        ClientMessage m = new ClientMessage();
        m.method = json.optString("method", "");
        m.sender = json.optString("sender", "");
        m.receiver = json.optString("receiver", "");
        m.code = json.optString("code", "");
        m.device = json.optString("device", "");
        m.roomid = json.optString("roomid", "0");
        m.clientid = json.optString("clientid", "0");
        m.extendParam = json.optString("extendParam", "");
        return m;
    }

    public JSONObject toJson() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("method", method);
        o.put("sender", sender);
        o.put("receiver", receiver);
        o.put("code", code);
        o.put("device", device);
        o.put("roomid", roomid);
        o.put("clientid", clientid);
        o.put("extendParam", extendParam == null ? "" : extendParam);
        return o;
    }

    /** Restrict an invite's push to one account. */
    public ClientMessage targetAgent(String email) throws JSONException {
        this.extendParam = new JSONObject().put("targetAgent", email).toString();
        return this;
    }

    /** Build "rtc:{address}@{host}". */
    public static String address(String address, String host) {
        return "rtc:" + address + "@" + host;
    }

    @Override
    public String toString() {
        return "ClientMessage{" + method + " room=" + roomid + " client=" + clientid
                + " " + sender + " -> " + receiver + "}";
    }
}
