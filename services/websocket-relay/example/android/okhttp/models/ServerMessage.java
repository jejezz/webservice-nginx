package com.wsrelay.api.models;

import org.json.JSONObject;

/**
 * What the relay sends when it is talking about itself rather than relaying:
 * {"message": ..., "error": ...}.
 *
 * Note the relay sends this shape for acknowledgements AND for errors — an
 * empty "error" means success. Peer signalling arrives as a plain
 * ClientMessage instead, so check for "method" first.
 */
public class ServerMessage {

    public String message = "";
    public String error = "";

    public static ServerMessage fromJson(JSONObject json) {
        ServerMessage m = new ServerMessage();
        m.message = json.optString("message", "");
        m.error = json.optString("error", "");
        return m;
    }

    public boolean isError() {
        return error != null && !error.isEmpty();
    }

    /** True when this JSON looks like a ServerMessage rather than a relayed ClientMessage. */
    public static boolean looksLike(JSONObject json) {
        return !json.has("method") && (json.has("message") || json.has("error"));
    }
}
