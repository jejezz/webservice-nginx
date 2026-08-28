package com.wsrelay.api.models;

import org.json.JSONObject;

/**
 * Reply from the register / unregister endpoints:
 * { "title": "CallFusion2RTC", "result": "success", "message": "..." }.
 *
 * Older relay builds returned this as a JSON-ish *string* rather than real
 * JSON. The current server returns proper JSON; the client tolerates both.
 */
public class RegisterResult {

    public String title;
    public String result;
    public String message;

    public static RegisterResult fromJson(JSONObject json) {
        RegisterResult r = new RegisterResult();
        r.title = json.optString("title", null);
        r.result = json.optString("result", null);
        r.message = json.optString("message", null);
        return r;
    }

    public boolean isSuccess() {
        return "success".equals(result);
    }
}
