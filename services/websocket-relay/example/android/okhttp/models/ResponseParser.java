package com.wsrelay.api.models;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Turns raw JSONObject replies into typed models.
 *
 * Usage:
 *   JSONObject raw = client.register().mobile(uuid, email, complex, address, token);
 *   RegisterResult result = ResponseParser.registerResult(raw);
 *
 *   RelayHealth health = ResponseParser.health(client.health());
 */
public final class ResponseParser {

    private ResponseParser() {}

    public interface Parser<T> {
        T parse(JSONObject json) throws JSONException;
    }

    public static RegisterResult registerResult(JSONObject raw) {
        return RegisterResult.fromJson(raw);
    }

    public static RelayHealth health(JSONObject raw) {
        return RelayHealth.fromJson(raw);
    }

    public static DeviceAddress deviceAddress(JSONObject raw) {
        return DeviceAddress.fromJson(raw);
    }

    public static ErrorResponse error(JSONObject raw) throws JSONException {
        return ErrorResponse.fromJson(raw);
    }

    /**
     * Decide what a frame from /relay/rtc is.
     *
     * The relay multiplexes three shapes down one socket and does not tag them,
     * so every listener has to do this test. Order matters: the "update" reply
     * has a "method" field like relayed signalling does.
     */
    public static Frame classify(JSONObject json) {
        String method = json.optString("method", "");
        if (WsMethod.UPDATE.equals(method)) return Frame.UPDATE;
        if (!method.isEmpty()) return Frame.SIGNAL;
        if (ServerMessage.looksLike(json)) return Frame.SERVER;
        return Frame.UNKNOWN;
    }

    public enum Frame {
        /** Reply to INVITE, carrying the clientid you must use from now on. */
        UPDATE,
        /** Signalling relayed from the peer (offer/answer/candidate/bye/...). */
        SIGNAL,
        /** The relay talking about itself: {message, error}. */
        SERVER,
        UNKNOWN
    }
}
