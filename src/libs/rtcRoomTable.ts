
import WebSocket from 'ws';
import { RtcRoom, InviteCallback } from './rtcRoom';
import { RtcClient } from './rtcClient';
import logger from './logger'; // Import your configured logger


export class RtcRoomTable {

    public roomTable: Map<number, RtcRoom>;
    public registerTimeout: number;

    /**
     * @constructor
     * @param {Duration} to - default register timeout, ms.
     */
    constructor(timeout: number) {
        this.roomTable = new Map<number, RtcRoom>();
        this.registerTimeout = timeout;
    }

    /**
     * room returns the room specified by |id|, or creates the room if it does not exist.
     * @param {Number} id 
     * @returns room instance
     */
    public createRoom(id: number): RtcRoom | null {
        if (id === undefined || id < 0) {
            logger.error(`Invalid room id \"${id}\"`);
            return null;
        }
        let room: RtcRoom | null = this.findById(id);
        if (room) {
            return room;
        } else {
            room = new RtcRoom(this, id, this.registerTimeout, () => {
                // Callback to remove the room when it is empty
                this.roomTable.delete(id);
                logger.info(`Room with \"${id}\" removed`);
            });

            this.roomTable.set(id, room);
            logger.info(`Room created with id \"${id}\" -> rooms:${this.roomTable.size}`);
            return room;
        }
    }

    public findById(id: number) : RtcRoom | null {
        // Ensure id is a number
        id = Number(id);
        return this.roomTable.get(id) || null;
    }

    /**
     * remove forwards the remove request to the room. 
     * If the room becomes empty, it also removes the room.
     * @param {Number} rid RtcRoom's id
     * @param {Number} cid RtcClient's id 
     */
    public remove(rid: number, cid: number): void {
        let room:RtcRoom | null = this.findById(rid);
        if (room) {
            room.remove(cid);
        }
        else {
            logger.warn("cannot find room for ", rid);
        }

    }

    /**
     * send forwards the message to the room. 
     * If the room does not exist, it ignores the message.
     * @param {Number} rid room's id 
     * @param {Number} cid client's id  
     * @param {String} message message to send
     */
    public send(rid: number, cid: number, message: any): void {
        let room:RtcRoom | null = this.findById(rid);
        if (room) {
            room.sendMessage(cid, message);
        }
        else {
            logger.warn("cannot find room for ", rid);
        }
    }

    /**
     * send forwards the message to the room. 
     * If the room does not exist, it ignores the message.
     * @param {Number} rid room's id 
     * @param {String} sender client's sender signature
     * @param {String} message message to send
     */
    public sendTo(rid: number, sender: string, message: any): void {
        let room:RtcRoom | null = this.findById(rid);
        if (room) {
            room.sendMessageTo(sender, message);
        }
        else {
            logger.warn("cannot find room for ", rid);
        }
    }

    /**
     * invite the RtcClient forwards the register request to the room. 
     * If the room does not exist, it will create one.
     * @param {Number} rid room's id  
     * @param {Number} cid RtcClient's id   
     * @param {String} agent agent string
     * @param {String} device device string
     * @param {Websocket} ws Websocket object
     * @param {Callback} callback 
     */
    public inviteClientToRoom(rid: number, cid: number, agent: string, device:string, 
        ws: WebSocket, callback: InviteCallback): RtcRoom | null{
        let room: RtcRoom | null = this.createRoom(rid);
        if(room) {
            room.inviteClient(cid, agent, device, ws, callback);
        }
        return room;
    }

    /**
     * remove RtcClient from the room forwards the register request 
     * to the room to clears the RtcClient's websocket registration.
     * @param {Number} rid room's id   
     * @param {Number} cid RtcClient's id 
     * @param {Websocket} ws websocket object
     */
    public removeClientFromRoom(rid: number, cid: number, ws: WebSocket): void {
        let room : RtcRoom | null = this.findById(rid);
        if (room)
            room.removeClientIfJoined(cid, ws);
    }

    /**
     * 
     * @returns the number of RtcClients in the room
     */
    public websocketCount(): number {
        let count = 0;
        for (let room of this.roomTable.values())
            count += room.websocketCount();
        return count;
    }

    /**
     * 
     * @param {WebSocket} ws 
     * @returns true if RtcClient of Websocket is joined.
     */
    public isJoinedToRoom(rid:number, ws:WebSocket):boolean {
        let room:RtcRoom|null = this.findById(rid);
        if(room !== null) {
            let client:RtcClient | null = room.findByWebsocket(ws);
            return (client !== null);
        }
        else {
            // for (const [key, values] of this.roomTable) {
            //     logger.info(`KEY: ${key}, VALUE: ${values}`);
            // }
            logger.warn("cannot find room with rid (", rid, ")");
        }
        return false;
    }

    /**
     * 
     * @param {WebSocket} ws 
     * @returns RtcClient instance
     */
    public findClient(ws:WebSocket):RtcClient | null {
        for (let r of this.roomTable.values()) {
            if(r.findByWebsocket(ws))
                return r.findByWebsocket(ws);
        }
        return null;
    }

    /**
     * remove RtcClient with WebSocket from all rooms.
     * @param {WebSocket} ws 
     */
    public removeClientFromRooms(ws:WebSocket):void {
        for (let r of this.roomTable.values()) {
            let client:RtcClient | null= r.findByWebsocket(ws);
            if(client) {
                r.removeClientIfJoined(client.cid, ws);
                return;
            }
        }
    }

    /**
     * This is for IoT operation
     * Creates room and iot-client
     */
    public createRoomForIot(rid: number, 
                            cid: number, 
                            address: string, 
                            ipv4: string,
                            payload: any,
                            ws: WebSocket) : RtcClient | null {
        let client: RtcClient | null = null;
        let room: RtcRoom | null = this.createRoom(rid);
        if(room) {
            client = room.createClientForIot(cid, address, ipv4, true, payload, ws);
        }
        return client;
    }
}

export default RtcRoomTable;