
import WebSocket from 'ws';
import { RtcRoom, InviteCallback, RoomKind } from './rtcRoom';
import { RtcClient, findClientByWebsocket } from './rtcClient';
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
     * @param {RoomKind} kind 새로 만들 때의 방 종류. 이미 있으면 무시한다.
     * @returns room instance
     */
    public createRoom(id: number, kind: RoomKind = 'unknown'): RtcRoom | null {
        if (id === undefined || id < 0) {
            logger.error(`Invalid room id \"${id}\"`);
            return null;
        }
        let room: RtcRoom | null = this.findById(id);
        if (room) {
            // 종류를 나중에 바꾸지 않는다. 먼저 만든 쪽이 용도를 정한다.
            // 다만 아직 정해지지 않았다면(이전 판에서 만들어진 방) 채워 준다.
            if (room.kind === 'unknown' && kind !== 'unknown') {
                room.kind = kind;
            }
            return room;
        } else {
            room = new RtcRoom(this, id, this.registerTimeout, () => {
                // Callback to remove the room when it is empty
                this.roomTable.delete(id);
                logger.info(`Room with \"${id}\" removed`);
            });

            room.kind = kind;
            this.roomTable.set(id, room);
            logger.info(`Room created with id \"${id}\" (${kind}) -> rooms:${this.roomTable.size}`);
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
     * 소켓으로 발신자를 정해 같은 방의 상대에게 넘긴다.
     *
     * 발신자를 메시지의 `clientid` 가 아니라 **소켓**으로 정하는 것이 핵심이다.
     * 이 한 번의 조회가 소속 확인까지 겸하므로, 부르는 쪽에서 따로
     * isJoinedToRoom 을 볼 필요가 없다.
     *
     * @param {Number} rid 방 번호
     * @param {WebSocket} ws 보낸 쪽 소켓
     * @param {any} message 넘길 메시지
     * @returns 넘겼으면 true, 방이 없거나 그 방 소속이 아니면 false
     */
    public sendFromWebsocket(rid: number, ws: WebSocket, message: any): boolean {
        let room:RtcRoom | null = this.findById(rid);
        if (!room) {
            logger.warn(`cannot find room for ${rid}`);
            return false;
        }
        let sender:RtcClient | null = room.findByWebsocket(ws);
        if (!sender) {
            logger.warn(`room ${rid} 에 들어오지 않은 소켓의 메시지를 버린다`);
            return false;
        }
        room.sendFrom(sender, message);
        return true;
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
        let room: RtcRoom | null = this.createRoom(rid, 'rtc');
        if(room) {
            room.inviteClient(cid, agent, device, ws, callback);
        }
        return room;
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
     * 소켓에 묶인 RtcClient 를 찾는다. pong 마다 불리므로 O(1) 이어야 한다.
     * @param {WebSocket} ws
     * @returns RtcClient instance
     */
    public findClient(ws:WebSocket):RtcClient | null {
        return findClientByWebsocket(ws);
    }

    /**
     * remove RtcClient with WebSocket from all rooms.
     * 연결 종료마다 불리므로 O(1) 이어야 한다 — 클라이언트가 자기 방 번호를
     * 들고 있으니 역참조로 찾아 그 방만 건드린다.
     * @param {WebSocket} ws
     */
    public removeClientFromRooms(ws:WebSocket):void {
        const client = findClientByWebsocket(ws);
        if (!client) {
            return;
        }
        const room = this.findById(client.rid);
        if (room) {
            room.removeClientIfJoined(client.cid, ws);
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
        let room: RtcRoom | null = this.createRoom(rid, 'iot');
        if(room) {
            client = room.createClientForIot(cid, address, ipv4, true, payload, ws);
        }
        return client;
    }
}

export default RtcRoomTable;