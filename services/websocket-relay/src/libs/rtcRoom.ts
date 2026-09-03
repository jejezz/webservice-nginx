/**
 * @file rtc_room.ts
 * @brief RTC Room implementation for managing client connections and message routing
 * @author CallFusion Team
 * @date 2024
 * @version 1.0.0
 * 
 * @description
 * This file contains the RtcRoom class which manages a single room in the CallFusion
 * WebRTC system. Each room can contain multiple clients and supports:
 * - Client connection management (both RTC and IoT clients)
 * - Message routing between clients
 * - Room lifecycle management (creation, cleanup)
 * - Timeout handling for disconnected clients
 * - IoT device integration and payload management
 * - Automatic room cleanup when empty
 */

import WebSocket from 'ws';
import { RtcRoomTable } from './rtcRoomTable';
import { RtcClient, findClientByWebsocket } from './rtcClient';
import { ClientMessage, IoTMessage } from './clientMessage';
import logger from './logger'; // Import your configured logger

/** @brief Maximum number of clients allowed in a single room */
const maxRoomCapacity = 6;

/**
 * @brief RTC 방의 정원. **둘뿐이다.**
 *
 * 홈넷 장치가 방을 만들고 같은 동/호의 모든 활성 단말에 푸시가 나가므로,
 * 두 대 이상이 동시에 반응하는 일이 실제로 생긴다. 규칙은 "가장 먼저 반응한
 * 한 대만 통화에 들어간다" 이고, 그 규칙을 여기서 강제한다.
 *
 * 예전에는 이 상한이 없어 maxRoomCapacity(6)까지 들어왔다. 늦게 온 단말은
 * 조용히 입장해서 — 대기 중이던 invite 를 못 받으니 화면에는 아무 일도 없는데 —
 * 자기가 보낸 offer·candidate 는 홈넷 장치에 그대로 전달됐다. 통화 중인 세션에
 * 남의 SDP 가 섞여 들어가는 것이다. 받는 쪽 sendMessage 는 상대 하나에게만
 * 보내므로 늦게 온 단말은 답을 받지도 못했다.
 */
const rtcRoomCapacity = 2;

/**
 * @brief 방의 종류.
 *
 * 같은 RtcRoom 이 두 가지 전혀 다른 용도로 쓰인다.
 *
 *   rtc   홈넷 장치 ↔ 모바일 **한 대**의 통화. 정원 2.
 *   iot   홈넷 장치 1대 ↔ 모바일 **여러 대**. 제어는 홈넷으로 모으고,
 *         홈넷의 상태는 구독한 모바일 전체에 뿌린다.
 *   admin 기동 때 만드는 관리용 방. 클라이언트가 붙지 않는다.
 *
 * 종류를 몰라서는 정원도 인가 규칙도 정할 수 없고, 대시보드도 두 용도를
 * 구분해 보여줄 수 없다.
 */
export type RoomKind = 'rtc' | 'iot' | 'admin' | 'unknown';

/** 늦게 온 단말에게 보내는 코드. SIP 486 Busy Here 와 같은 뜻으로 쓴다. */
export const RTC_ROOM_TAKEN = 'room-taken';


/** @brief Callback function type for client invitation results */
export type InviteCallback = (error: string | null, initiator: boolean) => void;

/** @brief Callback function type for room cleanup when empty */
export type EmptyCallback = () => void;

/**
 * @class RtcRoom
 * @brief Manages a single WebRTC room with multiple client connections
 * 
 * @details
 * The RtcRoom class handles all aspects of room management including:
 * - Client registration and deregistration
 * - Message routing between clients in the room
 * - Timeout management for disconnected clients
 * - IoT device integration and payload handling
 * - Automatic room cleanup when all clients leave
 * - Support for both call initiators and regular participants
 * 
 * Each room maintains a collection of RtcClient instances and provides
 * methods for client lifecycle management, message delivery, and room state tracking.
 */
export class RtcRoom {

    /** @brief Unique room identifier */
    public id: number = 0;

    /**
     * @brief 방의 종류. 만들 때 정해지고 바뀌지 않는다.
     * 처음 만든 쪽이 무엇이었는지에 따라 rtc / iot / admin 이 된다.
     */
    public kind: RoomKind = 'unknown';
    
    /** @brief Map of client ID to RtcClient instances in this room */
    public clients: Map<number, RtcClient> = new Map<number, RtcClient>();
    
    /** @brief Timeout duration in milliseconds for client registration */
    public registerTimeout: number = 0;
    
    /** @brief Callback function executed when room becomes empty */
    public emptyCallback: EmptyCallback = () => { /* do nothing */ };
    
    /** @brief Reference to the parent room table for cleanup operations */
    private rtcRoomTable: RtcRoomTable | null = null;

    /**
     * @brief Constructs a new RtcRoom instance
     * @param table Reference to the parent RtcRoomTable for cleanup operations
     * @param id Unique room identifier number
     * @param timeout Timeout duration in milliseconds for client registration
     * @param emptyCallback Function to call when room becomes empty for cleanup
     * 
     * @details
     * Initializes a new room with the specified parameters. The room starts
     * empty and clients can be added through invitation methods. The timeout
     * parameter controls how long disconnected clients remain in the room
     * before being automatically removed.
     */
    constructor(table: RtcRoomTable, id: number, timeout: number, emptyCallback: EmptyCallback) {
        this.rtcRoomTable = table;
        this.id = id;
        this.clients = new Map<number, RtcClient>();
        this.registerTimeout = timeout;
        this.emptyCallback = emptyCallback;
    }

    /**
     * @brief Creates or retrieves a call client for RTC communication
     * @param cid Unique client identifier
     * @param agent User agent string from the client
     * @param device Device type/name identifier
     * @return RtcClient The created or existing client instance
     * @throws Error if room has reached maximum capacity
     * 
     * @details
     * Creates a new RtcClient for voice/video calls or returns an existing one
     * if the client ID already exists in the room. The first client in a room
     * automatically becomes the initiator. For initiators, an automatic invite
     * message is queued to start the call process. Sets up a timeout for
     * automatic cleanup if the client doesn't connect within the timeout period.
     */
     private createCallClient(cid: number, agent: string, device: string): RtcClient {
        let c = this.clients.get(cid);
        if (c) {
            return c;
        }

        if (this.clients.size >= this.capacity()) {
            logger.error(`room ${this.id} is full, not adding client ${cid}`);
            throw Error("max room capacity reached");
        }
        const initiator = (this.clients.size === 0);
        c = new RtcClient(this.id, cid, initiator, agent, device, "", /* do not set ipaddress */
            setTimeout(() => { this.removeIfNotJoined(c as RtcClient); },
                this.registerTimeout));
        if (initiator) {
            // enqueue for automatic calling.
            // it works with only one client!!!
            let message = new ClientMessage();
            message.method = 'invite';
            message.sender = agent;
            message.code = "180";
            message.roomid = `${this.id}`;
            message.device = device;
            c.enqueue(message);
        }
        this.clients.set(cid, c);
        logger.info(`----- added client ${cid} to room ${this.id} ------`);
        return c;
    }

    /**
     * @brief Creates an IoT client for device communication
     * @param cid Unique client identifier
     * @param address IoT device address identifier
     * @param ipv4 IP address of the IoT device
     * @param controller Flag indicating if this device is a controller
     * @param payload IoT device configuration payload (rooms and gadgets)
     * @return RtcClient The created or existing IoT client instance
     * @throws Error if room has reached maximum capacity
     * 
     * @details
     * Creates a specialized RtcClient for IoT device communication. Unlike
     * call clients, IoT clients store device-specific payload data and use
     * address-based identification. The controller flag determines device
     * permissions within the IoT network. Sets up automatic cleanup timeout
     * for disconnected IoT devices.
     */
    public createIotClient(cid: number, address: string, ipv4: string, controller: boolean, payload: any) : RtcClient {
        let c = this.clients.get(cid);
        if (c) {
            return c;
        }
        if (this.clients.size >= this.capacity()) {
            logger.error(`room ${this.id} is full, not adding client ${cid}`);
            throw Error("max room capacity reached");
        }
        c = new RtcClient(this.id, cid, controller, "", "", ipv4,
            setTimeout(() => { this.removeIfNotJoined(c as RtcClient) },
                this.registerTimeout));
        if(payload != undefined && payload != null) {
            c.setIoTPayload(payload.rooms, payload.gadgets);
        }
        c.setAddress(address); /* TODO: make this private access */
        this.clients.set(cid, c);
        logger.info(`----- added iot client ${c.getAddress()}/${ipv4} to room ${this.id} ------`);
        return c;
    }

    /**
     * @brief Modifies an existing IoT client's configuration
     * @param cid Client identifier to modify
     * @param address New device address
     * @param controller New controller status (unused in current implementation)
     * @param payload New IoT device configuration payload
     * @return RtcClient|null The modified client or null if modification failed
     * 
     * @details
     * Updates an existing IoT client's address and payload configuration.
     * Only clients with initiator status can be modified. After successful
     * modification, broadcasts the updated configuration to all other clients
     * in the room via IoT modify messages. This ensures all clients stay
     * synchronized with device configuration changes.
     */
    public modifyIoTClient(cid: number, address: string, controller: boolean, payload: any) : RtcClient | null{
        let c = this.clients.get(cid);
        if (c && c.initiator) {
            c.address = address;
            c.setIoTPayload(payload.rooms, payload.gadgets);
            logger.info(`----- modified iot client ${cid} in room ${this.id} ------`);
            let message : IoTMessage = IoTMessage.build("modify", 
                                                        String(c.rid), 
                                                        0, // each client has its own id
                                                        '200', 
                                                        '');
            for (let oc of this.clients.values()) {
                if (oc.cid !== c.cid) {
                    message.clientid = oc.cid; // each client's id
                    message.payload = c.getIoTPayload(); // send the modified payload to each client
                    oc.send(message);
                }
            }
            return c;
        }
        logger.info(`----- failed to modify iot client ${cid} in room ${this.id} ------`);
        return null;
    }

    /**
     * @brief Invites a client to join the room with WebSocket connection
     * @param cid Unique client identifier
     * @param agent User agent string from the client
     * @param device Device type/name identifier
     * @param ws WebSocket connection to bind to the client
     * @param callback Function to call with invitation result (error, initiator)
     * 
     * @details
     * Processes a client invitation to join the room for RTC communication.
     * Creates or retrieves the client, binds the WebSocket connection, and
     * handles message delivery between clients. When the second client joins,
     * any queued messages from the first client are delivered to establish
     * the call. The callback indicates success/failure and whether the client
     * is the call initiator.
     */
    public inviteClient(cid: number, agent: string, device: string, ws: WebSocket, callback: InviteCallback): void {
        // 먼저 온 쪽을 유지한다 — 늦게 온 단말은 방에 넣지 않는다.
        //
        // 이미 있는 cid 로 다시 들어오는 것(같은 단말의 재접속)은 막지 않는다.
        // 끊긴 채 자리만 차지하고 있는 항목은 먼저 치운다. removeClientIfJoined 가
        // 로밍 재접속을 위해 registerTimeout 동안 자리를 남겨 두기 때문에, 그 사이에
        // 들어온 재접속이 '세 번째'로 몰려 거부되는 일이 생긴다.
        if (this.kind === 'rtc' && !this.clients.has(cid)) {
            if (this.clients.size >= rtcRoomCapacity) {
                this.pruneDisconnected();
            }
            if (this.clients.size >= rtcRoomCapacity) {
                logger.info(`room ${this.id} 은 이미 통화 중 — client ${cid}/${device} 를 받지 않는다`);
                callback(RTC_ROOM_TAKEN, false);
                return;
            }
        }
        // create or get the client
        let newbee = this.createCallClient(cid, agent, device);
        try {
            newbee.bind(ws);
        } catch (exception) {
            callback("failed to invite", false);
            return;
        }
        logger.info(`client ${cid}/${device} joined in room ${this.id}`);
        // Sends the queued messages of peers' in the room.
        // only two clients are allowed in the room. (first in first served)
        if (this.clients.size == 2) {
            for (let client of this.clients.values()) {
                // send messages to the other client (other than me)
                if (client.cid !== cid) {
                    client.sendQueued(newbee);
                }
            }
        }
        callback(null, newbee.isInitiator());
    }

    /**
     * @brief Removes a client's WebSocket registration while preserving client record
     * @param cid Client identifier to deregister
     * @param ws WebSocket connection to verify before removal
     * 
     * @details
     * Gracefully handles client disconnection by clearing the WebSocket binding
     * while keeping the client record for potential reconnection. This supports
     * seamless reconnection for users roaming between networks. Sets a timeout
     * for final cleanup if the client doesn't reconnect within the timeout period.
     * Only removes clients that are actually bound to the specified WebSocket.
     */
    public removeClientIfJoined(cid: number, ws: WebSocket): void {
        let c = this.clients.get(cid);
        if (c && c.boundWith(ws)) {
            c.leave();
            c.setTimeout(setTimeout(() => { this.removeIfNotJoined(c as RtcClient) },
                this.registerTimeout));
            logger.info(`deregisterd client ${cid} from room ${this.id}`);
        }
    }

    /**
     * @brief Removes a client that has not established a connection within timeout
     * @param client RtcClient instance to potentially remove
     * 
     * @details
     * Called by timeout handlers to clean up clients that failed to establish
     * or re-establish WebSocket connections within the allotted time. Only
     * removes clients that don't have active connections and are still the
     * same instance in the room. Triggers the empty callback if this removal
     * makes the room empty, allowing for room cleanup.
     */
    public removeIfNotJoined(client: RtcClient): void {
        logger.info(`remove client ${client.cid} from room ${this.id} due to timeout`);
        if (client === this.clients.get(client.cid)) {
            if (!client.isOpened()) {
                client.unbind(); // 소켓 역참조를 끊는다 (RtcRoomTable.findClient 가 쓴다)
                this.clients.delete(client.cid);
                if (this.isEmpty() && this.emptyCallback) {
                    this.emptyCallback();
                }
            }
        }
    }

    /**
     * @brief 이미 확인된 발신자로부터 상대에게 메시지를 넘긴다.
     * @param sender 이 방에 속한 것이 확인된 발신자
     * @param message 넘길 메시지
     *
     * @details
     * **발신자는 소켓으로 정한다.** 예전에는 메시지에 실려 온 `clientid` 로
     * `clients.get()` 을 했다. 그러면 두 가지가 생긴다 — 같은 방 안에서 남의
     * cid 를 적어 보낼 수 있고, 값이 어긋나면 메시지가 조용히 사라진다
     * ("connot find sender"). 소켓은 바꿔치기할 수 없으므로 그쪽을 기준으로 삼고,
     * 나가는 메시지의 `clientid` 도 실제 발신자로 덮어쓴다 — 받는 쪽이 그 값을
     * 상대의 식별자로 쓰기 때문에 릴레이가 참인 값을 보장하는 편이 맞다.
     *
     * 방에 혼자면 대기열에 넣어 두었다가 상대가 들어올 때 전달한다.
     * 통화 방은 정원이 둘이므로 '상대'는 최대 한 명이다.
     */
    public sendFrom(sender: RtcClient, message: any): void {
        if (message && typeof message === 'object') {
            message.clientid = `${sender.cid}`;
        }

        if (this.clients.size === 1) {
            return sender.enqueue(message);
        }

        for (let oc of this.clients.values()) {
            if (oc.cid !== sender.cid) {
                return sender.sendTo(oc, message);
            }
        }
    }

    /**
     * @brief Permanently removes a client from the room
     * @param cid Client identifier to remove
     * 
     * @details
     * Completely removes a client from the room, including cleanup of timeouts
     * and WebSocket connections. Unlike removeClientIfJoined, this method
     * immediately and permanently removes the client without any grace period.
     * If this removal makes the room empty, triggers the empty callback for
     * room cleanup. This is typically used for explicit client departures.
     */
    public remove(cid: number): void {
        let c = this.clients.get(cid);
        if (!c) return;
        c.removeTimeout();
        c.leave();
        c.unbind(); // 소켓 역참조를 끊는다 (RtcRoomTable.findClient 가 쓴다)
        this.clients.delete(cid);
        logger.info(`removed client ${cid} from room ${this.id}`);
        if (this.isEmpty() && this.emptyCallback) {
            this.emptyCallback();
        }
    }

    /**
     * @brief 이 방의 정원.
     * RTC 는 둘뿐이고(rtcRoomCapacity), IoT 는 홈넷 1 + 모바일 여럿이라 넉넉히 둔다.
     */
    public capacity(): number {
        return this.kind === 'rtc' ? rtcRoomCapacity : maxRoomCapacity;
    }

    /**
     * @brief 소켓이 끊긴 클라이언트를 자리에서 치운다.
     * @return number 정리 후 남은 클라이언트 수
     *
     * 각 클라이언트의 타임아웃이 어차피 하는 일이지만, 정원을 판단하기 직전에는
     * 그 타이머를 기다릴 수 없다. **emptyCallback 은 부르지 않는다** — 이 직후
     * 새 클라이언트가 들어올 참인데 방이 먼저 지워지면 떨어져 나간 방에 붙게 된다.
     */
    private pruneDisconnected(): number {
        for (const c of Array.from(this.clients.values())) {
            if (!c.isOpened()) {
                logger.info(`room ${this.id}: 끊긴 client ${c.cid} 를 자리에서 치운다`);
                c.removeTimeout();
                c.unbind();
                this.clients.delete(c.cid);
            }
        }
        return this.clients.size;
    }

    /**
     * @brief Checks if the room has no clients
     * @return boolean True if room is empty, false otherwise
     * 
     * @details
     * Determines if the room contains any clients. Used for room cleanup
     * decisions and triggering empty callbacks when rooms become vacant.
     */
    public isEmpty(): boolean {
        return this.clients.size === 0;
    }

    /**
     * @brief Finds a client by their WebSocket connection
     * @param ws WebSocket connection to search for
     * @return RtcClient|null The client bound to the WebSocket, or null if not found
     * 
     * @details
     * Searches through all clients in the room to find the one associated
     * with the specified WebSocket connection. Used for identifying clients
     * during WebSocket event handling and message routing.
     */
    public findByWebsocket(ws:WebSocket): RtcClient | null {
        // 소켓 → 클라이언트는 WeakMap 으로 O(1) 이다. 다만 그 클라이언트가
        // **이 방** 소속인지는 따로 확인해야 한다 — 다른 방의 소켓일 수 있다.
        // 방의 Map 에 같은 인스턴스가 들어 있는지로 본다. rid 를 비교하지 않는
        // 것은, 자리에서 치워진 뒤에도 rid 는 남아 있기 때문이다.
        const c = findClientByWebsocket(ws);
        return (c && this.clients.get(c.cid) === c) ? c : null;
    }

    /**
     * @brief Finds a client by their client ID
     * @param cid Client identifier to search for
     * @return RtcClient|null The client with the specified ID, or null if not found
     * 
     * @details
     * Direct lookup of a client by their unique identifier. This is the most
     * efficient way to find a specific client when the ID is known.
     */
    public findByCid(cid: number): RtcClient | null {
        return this.clients.get(cid) || null;
    }

    /**
     * @brief Finds the call initiator in the room
     * @return RtcClient|null The initiator client, or null if no initiator exists
     * 
     * @details
     * Searches for the client marked as the call initiator. In most rooms,
     * there should be exactly one initiator (the first client to join).
     * Used for call management and determining client privileges.
     */
    public findInitiator(): RtcClient | null {
        for (let c of this.clients.values()) {
            if(c.isInitiator()) {
                return c;
            }
        }
        return null;
    }

    /**
     * @brief Counts the number of active WebSocket connections in the room
     * @return number The count of clients with open WebSocket connections
     * 
     * @details
     * Counts only clients that have active (open) WebSocket connections.
     * This number may be different from the total client count since clients
     * can be temporarily disconnected while remaining in the room for
     * potential reconnection. Used for monitoring room activity and
     * connection health.
     */
    public websocketCount(): number {
        let count = 0;
        for (let c of this.clients.values()) {
            count += (c.isOpened() ? 1 : 0);
        }
        return count;
    }

    /**
     * @brief Creates and connects an IoT client with WebSocket binding
     * @param cid Unique client identifier
     * @param address IoT device address identifier
     * @param ipv4 IP address of the IoT device
     * @param controller Flag indicating if this device is a controller
     * @param payload IoT device configuration payload
     * @param ws WebSocket connection to bind to the client
     * @return RtcClient|null The created and connected IoT client, or null on failure
     * 
     * @details
     * Creates an IoT client and immediately binds it to a WebSocket connection.
     * This is a convenience method that combines createIotClient() and bind()
     * operations. If WebSocket binding fails, returns null instead of leaving
     * an unconnected client. Used for IoT device registration and connection
     * establishment in a single operation.
     */
    public createClientForIot(cid: number, 
                                address: string, 
                                ipv4: string,
                                controller: boolean, 
                                payload: any,
                                ws: WebSocket): RtcClient | null {
        //create or get the client
        let newbee = this.createIotClient(cid, address, ipv4, controller, payload);
        try {
            newbee.bind(ws);
        } catch (exception) {
            return null;
        }
        logger.info(`client ${cid} created room ${this.id}`);
        return newbee;
    }
}
