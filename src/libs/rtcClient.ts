/**
 * @file rtc_client.ts
 * @brief RTC Client implementation for WebSocket-based real-time communication
 * @author CallFusion Team
 * @date 2024
 * @version 1.0.0
 * 
 * @description
 * This file contains the RtcClient class which represents a client connection
 * in the CallFusion WebRTC system. Each client can be either an initiator or
 * a regular participant and supports:
 * - WebSocket connection management
 * - Message queuing and routing
 * - IoT device payload handling
 * - Connection lifecycle management
 * - Timeout and alive state tracking
 */

import logger from './logger'; // Import your configured logger
import WebSocket from 'ws';

/** @brief Maximum number of messages that can be queued for a client */
const maxQueuedMsgCount = 1024;

/**
 * @class RtcClient
 * @brief Represents a WebRTC client connection with message handling capabilities
 * 
 * @details
 * The RtcClient class manages individual client connections in the CallFusion system.
 * Each client maintains:
 * - WebSocket connection for real-time communication
 * - Message queue for offline message delivery
 * - IoT device payload storage and management
 * - Connection state and lifecycle tracking
 * - Timeout handling for connection management
 * 
 * Clients can be either initiators (who start calls) or regular participants.
 * The class supports both RTC (Real-Time Communication) and IoT messaging.
 */
export class RtcClient {

    /** @brief Room ID that this client belongs to */
    public rid: number = 0;
    
    /** @brief Unique client ID within the system */
    public cid: number = 0;
    
    /** @brief Device address identifier (for IoT devices) */
    public address: string = "";
    
    /** @brief IP address of the client */
    public ipaddress: string = "";
    
    /** @brief Flag indicating if this client is the call initiator */
    public initiator: boolean = false;
    
    /** @brief Timeout handler for connection management */
    public timeout: NodeJS.Timeout;
    
    /** @brief User agent string from client */
    public agent: string;
    
    /** @brief Device type/name identifier */
    public device: string;
    
    /** @brief WebSocket connection instance */
    public websocket: WebSocket = {} as WebSocket;
    
    /** @brief Queue for messages when client is offline */
    public messageQueue: Array<any> = [];
    
    /** @brief Flag indicating if client is subscribed to notifications */
    public susbcription: boolean = false;
    
    /** @brief JSON string containing room-specific data for IoT devices */
    public roomSpecData: string = "";
    
    /** @brief JSON string containing IoT device-specific data */
    public iotSpecData: string = "";
    
    /** @brief Flag indicating if client connection is alive */
    public alive: boolean = true;

    /**
     * @brief Constructs a new RtcClient instance
     * @param rid Room ID that this client will belong to
     * @param cid Unique client identifier
     * @param initiator Flag indicating if this client initiates calls
     * @param agent User agent string from the client
     * @param device Device type/name identifier
     * @param ipaddress IP address of the client
     * @param timeout Timeout handler for connection management
     * 
     * @details
     * Initializes a new RTC client with the provided parameters. The client
     * starts in an unconnected state and must be bound to a WebSocket
     * connection using the bind() method.
     */
    constructor(rid: number, cid: number, initiator: boolean, agent: string, device: string, ipaddress:string, timeout: NodeJS.Timeout) {
        this.rid = rid;
        this.cid = cid;
        this.initiator = initiator;
        this.agent = agent;
        this.device = device;
        this.ipaddress = ipaddress;
        this.timeout = timeout;
    }

    /**
     * @brief Sets IoT device payload data for this client
     * @param rooms Room configuration data for IoT devices
     * @param gadgets Gadget/device-specific configuration data
     * 
     * @details
     * Stores IoT device configuration as JSON strings. This method is used
     * when the client represents an IoT device that needs to maintain
     * room and device-specific configuration data.
     */
    public setIoTPayload(rooms: any, gadgets: any): void {
        if(rooms != undefined ) {
            this.roomSpecData = JSON.stringify(rooms);
            // console.log("-------------------------------");
            // console.log(this.roomSpecData);
            // console.log("-------------------------------");
        }
        if(gadgets != undefined) {
            this.iotSpecData = JSON.stringify(gadgets);
            // console.log("-------------------------------");
            // console.log(this.iotSpecData);
            // console.log("-------------------------------");
        }
    }

    /**
     * @brief Sets the device address for this client
     * @param address Device address string (may include prefixes and suffixes)
     * 
     * @details
     * Processes and stores the device address with the following transformations:
     * - Removes "iot:" prefix if present
     * - Extracts the address portion before "@" symbol if present
     * - Validates the address is not null or undefined
     * 
     * @note Used primarily for IoT device identification
     */
    public setAddress(address: string): void {
        if (address === undefined || address === null) {
            logger.error("invalid address for client %s", this.cid);
            return;
        }
        if(address.startsWith("iot:")) {
            address = address.replace("iot:", ""); // remove the "iot:" prefix if it exists
        }
        const atIndex = address.indexOf('@');
         // If "@" is found (atIndex is not -1), return the substring before it
        if (atIndex !== -1) {
            this.address = address.substring(0, atIndex);
        } else {
            // If "@" is not found, return the original string
            this.address = address;
        }
    }

    /**
     * @brief Gets the device address for this client
     * @return string The processed device address, or empty string if invalid
     * 
     * @details
     * Retrieves the stored device address after validation. Logs an error
     * and returns empty string if the address is invalid (null, undefined, or empty).
     */
    public getAddress(): string {
        if (this.address === undefined || this.address === null || this.address === "") {
            logger.error("invalid address for client %s", this.cid);
            return "";
        }
        return this.address;
    }

    /**
     * @brief Retrieves the IoT device payload data
     * @return any Object containing parsed room and gadget data, or undefined if not set
     * 
     * @details
     * Parses and returns the stored IoT configuration data as JavaScript objects.
     * Returns an object with 'rooms' and 'gadgets' properties, or undefined
     * if either roomSpecData or iotSpecData is not available.
     */
    public getIoTPayload(): any {
        if(this.roomSpecData === undefined || this.iotSpecData === undefined) {
            return undefined;
        }
        return {
            rooms: JSON.parse(this.roomSpecData),
            gadgets: JSON.parse(this.iotSpecData)
        };
    }

    /**
     * @brief Sets the subscription status for this client
     * @param subscription Boolean flag indicating subscription status
     * 
     * @details
     * Controls whether this client is subscribed to receive notifications
     * or broadcast messages from the server.
     */
    public setSubscription(subscription: boolean): void {
        this.susbcription = subscription;
    }

    /**
     * @brief Checks if this client is subscribed to notifications
     * @return boolean True if client is subscribed, false otherwise
     */
    public isSubscribed(): boolean {
        return this.susbcription;
    }

    /**
     * @brief Sets the expiration timer for this client
     * @param timeout NodeJS timeout handler
     * 
     * @details
     * Sets a new timeout handler for this client, clearing any existing timeout.
     * This is used for connection management and automatic cleanup of
     * inactive clients.
     */
    public setTimeout(timeout: NodeJS.Timeout): void {
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
        this.timeout = timeout;
    }

    /**
     * @brief Removes the current timeout handler
     * 
     * @details
     * Clears the existing timeout to prevent automatic client cleanup.
     * Typically called when a client becomes active or is being manually managed.
     */
    public removeTimeout(): void {
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
    }

    /**
     * @brief Sets the alive status of this client
     * @param alive Boolean flag indicating if client is alive
     * 
     * @details
     * Updates the client's alive status. This is typically used in conjunction
     * with ping/pong mechanisms to track connection health.
     */
    public setAlive(alive: boolean): void {
        this.alive = alive;
    }

    /**
     * @brief Checks if this client is currently alive
     * @return boolean True if client is alive, false otherwise
     * 
     * @details
     * Returns the current alive status of the client connection.
     * Used for connection health monitoring and cleanup decisions.
     */
    public isAlive(): boolean {
        return this.alive;
    }

    /**
     * @brief Binds a WebSocket connection to this client
     * @param websocket The WebSocket instance to bind to this client
     * 
     * @details
     * Associates a WebSocket connection with this client. If there's already
     * an active connection, it closes the old one before establishing the new one.
     * This method also:
     * - Removes any existing timeout
     * - Sets the client as alive
     * - Logs a warning if replacing an existing connection
     */
     public bind(websocket: WebSocket): void {
        // If there's already an open connection, close it first
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            logger.warn("Client %s already has an open connection, closing old connection and replacing with new one", this.cid);
            this.websocket.close();
        }
        this.removeTimeout();
        this.alive = true;
        this.websocket = websocket;
    }

    /**
     * @brief Disconnects the client and closes the WebSocket connection
     * 
     * @details
     * Gracefully disconnects this client by:
     * - Setting the alive status to false
     * - Closing the WebSocket connection if it exists
     * This method is typically called when a client leaves a room or
     * when cleaning up inactive connections.
     */
     public leave(): void {
        this.alive = false;
        if (this.websocket) {
            this.websocket.close();
        }
    }

    /**
     * @brief Checks if the WebSocket connection is currently open
     * @return boolean True if WebSocket is open, false otherwise
     * 
     * @details
     * Verifies that the WebSocket connection is in the OPEN state,
     * indicating that it's ready to send and receive messages.
     */
     public isOpened(): boolean {
        return this.websocket.readyState == WebSocket.OPEN;
    }

    /**
     * @brief Checks if this client is bound to a specific WebSocket
     * @param websocket The WebSocket instance to compare against
     * @return boolean True if the client is bound to the given WebSocket, false otherwise
     * 
     * @details
     * Performs a reference equality check to determine if this client
     * is associated with the specified WebSocket connection.
     */
     public boundWith(websocket: WebSocket): boolean {
        return this.websocket === websocket;
    }

    /**
     * @brief Adds a message to the client's message queue
     * @param message The message object to queue for later delivery
     * @throws Error if the queue exceeds maximum allowed messages
     * 
     * @details
     * Stores messages in a queue for later delivery when the client comes online.
     * This ensures messages are not lost when clients are temporarily disconnected.
     * The queue has a maximum size limit to prevent memory overflow.
     */
     public enqueue(message: any): void {
        if (this.messageQueue.length >= maxQueuedMsgCount) {
            throw Error("too many messages queued for the client");
        }
        this.messageQueue.push(message);
    }

    /**
     * @brief Sends all queued messages to another client
     * @param peer The target RtcClient to receive the queued messages
     * @throws Error if peer is invalid (same client or no WebSocket)
     * 
     * @details
     * Delivers all messages from this client's queue to the specified peer.
     * Each message is modified to include the peer's agent as the receiver
     * before sending. After successful delivery, the queue is cleared.
     * This method is typically called when a peer comes online.
     */
     public sendQueued(peer: RtcClient): void {
        // 
        if (this.cid === peer.cid || !peer.websocket) {
            throw Error("invalid client");
        }
        for (let msg of this.messageQueue) {
            msg.receiver = peer.agent;
            return peer.websocket.send(JSON.stringify(msg));
        }
        this.messageQueue = [];
        logger.info("sent queued messages from %s to %s", this.cid, peer.cid);
    }

    /**
     * @brief Sends a message to another client or queues it for later delivery
     * @param peer The target RtcClient to receive the message
     * @param message The message object to send
     * 
     * @details
     * Attempts to immediately send a message to the specified peer client.
     * If the peer has an active WebSocket connection, the message is sent
     * immediately. If the peer is offline, the message is queued for later
     * delivery when the peer comes online. Prevents sending to self.
     */
    public sendTo(peer: RtcClient, message: any): void {
        if (this.cid === peer.cid) {
            logger.error("invalid client send nothing");
            return;
        }
        if (peer.websocket) {
            peer.websocket.send(JSON.stringify(message));
            return;
        }
        // if websocket is not opened, queue the message
        this.enqueue(message);
    }

    /**
     * @brief Sends a message directly to this client
     * @param message The message object to send to this client
     * 
     * @details
     * Sends a message immediately to this client's WebSocket connection
     * if the connection exists. The message is serialized to JSON before sending.
     */
    public send(message: any): void {
        if(this.websocket) {
            this.websocket.send(JSON.stringify(message));
        }
    }

    /**
     * @brief Checks if this client is the call initiator
     * @return boolean True if this client initiated the call, false otherwise
     * 
     * @details
     * Returns the initiator flag that was set during client construction.
     * Initiators typically have special privileges in call management.
     */
    public isInitiator(): boolean {
        return this.initiator;
    }

    /**
     * @brief Compares if this client is bound to a specific WebSocket
     * @param ws The WebSocket instance to compare against
     * @return boolean True if this client's WebSocket matches the given one
     * 
     * @details
     * Performs a reference equality check between this client's WebSocket
     * and the provided WebSocket instance. Used for client identification.
     */
    public compare(ws:WebSocket):boolean {
        return (this.websocket === ws);
    }
}