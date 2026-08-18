"use strict"

export class ClientMessage {

    public method: string;
    public sender: string;
    public receiver: string;
    public code: string;
    public device: string;
    public roomid: string;
    public clientid: string;
    public extendParam: string;

    constructor() {
        this.roomid = '0';
        this.method = '';
        this.sender = '';
        this.receiver = '';
        this.code = '';
        this.device = '';
        this.clientid = '0';
        this.extendParam = '';
    }
}

export class IoTMessage {
    public method: string;
    public roomid: string;
    public clientid: number;
    public address: string;
    public rescode: string;
    public payload: any;

    constructor() {
        this.method = '';
        this.roomid = '';
        this.clientid = 0;
        this.address = '';
        this.rescode = '0';
        this.payload = undefined;
    }

    public static build(method: string, roomid: string, clientid: number, code : string, payload: any) : IoTMessage {
        let message = new IoTMessage();
        message.method = method ? method : '';
        message.roomid = roomid ? roomid : '';
        message.clientid = clientid ? clientid : 0;
        message.rescode = code ? code : '0';
        message.address = '';
        message.payload = payload ? payload : '';
        return message;
    }
}

export class ServerMessage {

    public message: any = '';
    public error: string = '';

    constructor(message?: any, error?: string) {
        this.message = message ?? "";
        this.error = error ?? "";
    }
}


// sendServerMsg sends a wsServerMsg composed from |msg| to the connection.
function sendServerMsg(ws: WebSocket, message: any) {
    if(ws.OPEN) {
        let m = new ServerMessage(message, '');
        send(ws, m);
    }
}

// sendServerErr sends a wsServerMsg composed from |errMsg| to the connection.
function sendServerErr(ws: WebSocket, error: string) {
    if(ws.OPEN) {
        let m = new ServerMessage('', error);
        send(ws, m);
    }
}

function send(ws: WebSocket, message: ServerMessage) {
    if(ws.OPEN) {
        let encodedString: string = JSON.stringify(message);
        ws.send(encodedString);
    }
}

export default {
    sendServerMsg,
    sendServerErr,
    send
};