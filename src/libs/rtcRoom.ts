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
import { RtcClient } from './rtcClient';
import { ClientMessage, IoTMessage } from './clientMessage';
import logger from './logger'; // Import your configured logger

/** @brief Maximum number of clients allowed in a single room */
const maxRoomCapacity = 6;


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

        if (this.clients.size >= maxRoomCapacity) {
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
        if (this.clients.size >= maxRoomCapacity) {
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
     * @brief Sends a message from one client to others in the room
     * @param cid Sender's client identifier
     * @param message Message object to send
     * 
     * @details
     * Routes a message from the specified sender to other clients in the room.
     * If only one client is in the room, the message is queued for later
     * delivery when another client joins. For multiple clients, the message
     * is sent to all other clients excluding the sender. Handles cases where
     * target clients are offline by using the client's sendTo method which
     * automatically queues messages for offline recipients.
     */
    public sendMessage(cid: number, message: any): void {
        let sender = this.clients.get(cid);

        if (sender) {
            if (this.clients.size === 1)
                return sender.enqueue(message);

            for (let oc of this.clients.values()) {
                if (oc.cid !== cid) {
                    return sender.sendTo(oc, message);
                }
            }
            return;
        }
        else {
            logger.error("connot find sender or any member in the room");
        }
    }

    /**
     * @brief Sends a message from a client identified by agent string
     * @param agent User agent string identifying the sender
     * @param message Message object to send
     * @throws Error if no client with the specified agent is found
     * 
     * @details
     * Routes a message from a client identified by their user agent string
     * to other clients in the room. Similar to sendMessage but uses agent
     * string instead of client ID for identification. If only one client
     * is in the room, the message is queued. For multiple clients, sends
     * the message to all other clients excluding the sender.
     * 
     * @note This method has a potential bug in the sender variable logic
     */
    public sendMessageTo(agent: string, message: any): void {
        let sender = null;
        for (const client of this.clients.values()) {
            logger.debug(`this client is ${client.agent}, other is ${agent}`);
            if(client.agent === agent) {
                if (this.clients.size === 1)
                    return client.enqueue(message);

                for (let oc of this.clients.values()) {
                    if (oc !== sender) {
                        return client.sendTo(oc, message);
                    }
                }
                return;
            }
        }

        throw Error("corrupted room " + this.id);
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
        for (let c of this.clients.values()) {
            if(c.compare(ws))
                return c;
        }
        return null;
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
