package com.wsrelay.api.models;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * IoT message — the payload on /relay/iot.
 *
 * Shape differs from ClientMessage: clientid is a number here, there is a
 * "rescode" instead of "code", and "payload" carries the device-specific body
 * (free-form JSON — the relay passes it through without looking inside).
 *
 * Address format is "iot:{address}@{host}".
 */
public class IoTMessage {

    public String method = "";
    public String roomid = "";
    public long clientid = 0;
    public String address = "";
    public String rescode = "0";

    /** Device payload. The relay does not interpret this. */
    public Object payload;

    public IoTMessage() {}

    public static IoTMessage build(String method, String roomid, long clientid, String rescode, Object payload) {
        IoTMessage m = new IoTMessage();
        m.method = method;
        m.roomid = roomid == null ? "" : roomid;
        m.clientid = clientid;
        m.rescode = rescode == null ? "0" : rescode;
        m.payload = payload;
        return m;
    }

    public static IoTMessage fromJson(JSONObject json) {
        IoTMessage m = new IoTMessage();
        m.method = json.optString("method", "");
        m.roomid = json.optString("roomid", "");
        m.clientid = json.optLong("clientid", 0);
        m.address = json.optString("address", "");
        m.rescode = json.optString("rescode", "0");
        m.payload = json.opt("payload");
        return m;
    }

    public JSONObject toJson() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("method", method);
        o.put("roomid", roomid);
        o.put("clientid", clientid);
        o.put("address", address);
        o.put("rescode", rescode);
        if (payload != null) o.put("payload", payload);
        return o;
    }

    public JSONObject payloadAsJson() {
        return payload instanceof JSONObject ? (JSONObject) payload : null;
    }

    /** Build "iot:{address}@{host}". */
    public static String address(String address, String host) {
        return "iot:" + address + "@" + host;
    }

    @Override
    public String toString() {
        return "IoTMessage{" + method + " room=" + roomid + " client=" + clientid + " " + address + "}";
    }
}
