package com.wsrelay.api.models;

import org.json.JSONObject;

/**
 * GET /relay/register/findip — where a device currently is.
 *
 * Only answers for devices that are connected to the relay right now; the
 * lookup walks live rooms, not the database. A device that is registered but
 * offline returns 401 with a plain-text body, not JSON.
 */
public class DeviceAddress {

    public String address;
    public String ipaddress;

    public static DeviceAddress fromJson(JSONObject json) {
        DeviceAddress d = new DeviceAddress();
        d.address = json.optString("address", null);
        d.ipaddress = json.optString("ipaddress", null);
        return d;
    }
}
