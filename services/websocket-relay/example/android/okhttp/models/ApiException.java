package com.wsrelay.api.models;

import java.util.Collections;
import java.util.List;

/**
 * Structured exception for relay API errors.
 * Distinguishes network errors, HTTP errors, and API-level errors.
 */
public class ApiException extends Exception {

    public enum Kind {
        NETWORK,        // connection failed, timeout, DNS resolution, etc.
        HTTP,           // server returned 4xx/5xx
        VALIDATION,     // 400 — a required field was missing
        UNAVAILABLE,    // 503 — the relay is up but its database is not
        NOT_FOUND,      // 404 — no such registration
        PARSE,          // response body was not valid JSON
        UNKNOWN
    }

    private final Kind kind;
    private final int httpStatus;
    private final String serverMessage;
    private final List<ErrorResponse.ValidationError> validationErrors;
    private final String requestUrl;
    private final String requestMethod;

    private ApiException(Builder b) {
        super(b.buildMessage(), b.cause);
        this.kind = b.kind;
        this.httpStatus = b.httpStatus;
        this.serverMessage = b.serverMessage;
        this.validationErrors = b.validationErrors != null
                ? Collections.unmodifiableList(b.validationErrors)
                : Collections.emptyList();
        this.requestUrl = b.requestUrl;
        this.requestMethod = b.requestMethod;
    }

    public Kind getKind() { return kind; }
    public int getHttpStatus() { return httpStatus; }
    public String getServerMessage() { return serverMessage; }
    public List<ErrorResponse.ValidationError> getValidationErrors() { return validationErrors; }
    public String getRequestUrl() { return requestUrl; }
    public String getRequestMethod() { return requestMethod; }

    public boolean isNetworkError() { return kind == Kind.NETWORK; }
    public boolean isValidationError() { return kind == Kind.VALIDATION; }

    /**
     * True when retrying the same request could plausibly succeed.
     *
     * 503 counts as retryable on purpose: the relay answers 503 while its
     * database is unreachable, and that is usually a short outage — the
     * WebSocket relay itself keeps running through it.
     */
    public boolean isRetryable() {
        if (kind == Kind.NETWORK) return true;
        return httpStatus == 408 || httpStatus == 429 || httpStatus >= 500;
    }

    public static Builder builder() { return new Builder(); }

    public static class Builder {
        private Kind kind = Kind.UNKNOWN;
        private int httpStatus;
        private String serverMessage;
        private List<ErrorResponse.ValidationError> validationErrors;
        private String requestUrl;
        private String requestMethod;
        private Throwable cause;

        public Builder kind(Kind v) { this.kind = v; return this; }
        public Builder httpStatus(int v) { this.httpStatus = v; return this; }
        public Builder serverMessage(String v) { this.serverMessage = v; return this; }
        public Builder validationErrors(List<ErrorResponse.ValidationError> v) { this.validationErrors = v; return this; }
        public Builder request(String method, String url) { this.requestMethod = method; this.requestUrl = url; return this; }
        public Builder cause(Throwable v) { this.cause = v; return this; }

        /** Map an HTTP status onto a Kind so callers can switch on meaning, not numbers. */
        public Builder fromStatus(int status) {
            this.httpStatus = status;
            if (status == 400 || status == 401) this.kind = Kind.VALIDATION;
            else if (status == 404) this.kind = Kind.NOT_FOUND;
            else if (status == 503) this.kind = Kind.UNAVAILABLE;
            else this.kind = Kind.HTTP;
            return this;
        }

        String buildMessage() {
            StringBuilder sb = new StringBuilder();
            sb.append(kind);
            if (httpStatus > 0) sb.append(" ").append(httpStatus);
            if (serverMessage != null && !serverMessage.isEmpty()) sb.append(": ").append(serverMessage);
            if (requestMethod != null) sb.append(" [").append(requestMethod).append(" ").append(requestUrl).append("]");
            return sb.toString();
        }

        public ApiException build() { return new ApiException(this); }
    }
}
