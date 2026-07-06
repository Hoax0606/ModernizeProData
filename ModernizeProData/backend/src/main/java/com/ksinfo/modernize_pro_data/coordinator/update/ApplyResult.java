package com.ksinfo.modernize_pro_data.coordinator.update;

import lombok.Data;

/** {@code POST /api/v1/updates/apply} response. */
@Data
public class ApplyResult {
    private boolean success;
    private String message;

    public static ApplyResult ok(String msg) {
        ApplyResult r = new ApplyResult();
        r.success = true;
        r.message = msg;
        return r;
    }

    public static ApplyResult fail(String msg) {
        ApplyResult r = new ApplyResult();
        r.success = false;
        r.message = msg;
        return r;
    }
}
