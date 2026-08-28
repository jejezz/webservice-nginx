package com.wsrelay.api.models;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Error body returned by the relay.
 *
 * The relay answers errors as { "error": "...", "message": "..." }.
 * Some older endpoints answer with a bare status code and no body at all,
 * so every field here is optional.
 */
public class ErrorResponse {

    public String error;
    public String message;
    public int httpStatus;

    /** The relay has no validation-error array today; kept so callers can share code with other services. */
    public List<ValidationError> validationErrors = new ArrayList<>();

    public static class ValidationError {
        public String field;
        public String message;
    }

    public static ErrorResponse fromJson(JSONObject json) throws JSONException {
        ErrorResponse r = new ErrorResponse();
        if (json == null) return r;
        r.error = json.optString("error", null);
        r.message = json.optString("message", null);
        r.httpStatus = json.optInt("_httpStatus", 0);
        return r;
    }

    /** Best available human-readable text, or null when the body was empty. */
    public String bestMessage() {
        if (message != null && !message.isEmpty()) return message;
        if (error != null && !error.isEmpty()) return error;
        return null;
    }
}
