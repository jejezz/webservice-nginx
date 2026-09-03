package com.wsrelay.api.models;

import org.json.JSONObject;

/**
 * GET /relay/health — the shared health contract of the orchestration repo
 * this service is checked out under. See [project root]/docs/health-contract.md.
 *
 * Worth checking before blaming the network: the relay answers "degraded"
 * (still HTTP 200) when its database is down. WebSocket signalling still works
 * in that state, but registration and push lookups do not.
 */
public class RelayHealth {

    public String service;
    public String status;       // "ok" | "degraded" | "error"
    public String version;
    public long uptimeSec;
    public int pid;
    public String timestamp;

    // details.*
    public int rooms;
    public int websockets;
    public boolean pushEnabled;
    public boolean dbReady;
    public String dbError;      // null when healthy
    public String env;

    public static RelayHealth fromJson(JSONObject json) {
        RelayHealth h = new RelayHealth();
        h.service = json.optString("service", null);
        h.status = json.optString("status", null);
        h.version = json.optString("version", null);
        h.uptimeSec = json.optLong("uptimeSec", 0);
        h.pid = json.optInt("pid", 0);
        h.timestamp = json.optString("timestamp", null);

        JSONObject d = json.optJSONObject("details");
        if (d != null) {
            h.rooms = d.optInt("rooms", 0);
            h.websockets = d.optInt("websockets", 0);
            h.pushEnabled = d.optBoolean("pushEnabled", false);
            h.dbReady = d.optBoolean("dbReady", false);
            h.dbError = d.isNull("dbError") ? null : d.optString("dbError", null);
            h.env = d.optString("env", null);
        }
        return h;
    }

    public boolean isOk() { return "ok".equals(status); }

    /** Up, but registration and push will fail. */
    public boolean isDegraded() { return "degraded".equals(status); }
}
