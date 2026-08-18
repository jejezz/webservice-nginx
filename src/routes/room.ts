/**
 * @file room.ts
 * @brief Room management routes for RTC communication and invitation system
 * @author jyahn
 * @date 2022-04-14
 * @version 1.0.0
 * 
 * @description
 * This module handles room-related operations for the CallFusion system.
 * It provides REST API endpoints for:
 * - Room invitation system with Firebase push notifications
 * - Mobile device notification for incoming calls/visitors
 * - Room ID generation for communication sessions
 * - Integration with interphone and doorbell systems
 * 
 * The system supports Korean localization for address formatting and
 * uses Firebase Cloud Messaging for real-time push notifications to
 * registered mobile devices.
 * 
 * @note Original description: RtcRoom 을 Control한다.???
 */

import express, { Request, Response, NextFunction } from 'express';
import mysql, { MysqlError } from 'mysql';
import { CallFusion } from '../index';
import { Utils } from '../libs/utils';
import { DbConn } from '../libs/dbConnection';
import { Firebase } from '../libs/firebaseAdmin';
import { TokenMessage } from 'firebase-admin/messaging';
import logger from '../libs/logger'; // Import your configured logger

/** @brief Express router instance for room management endpoints */
const Route2Room = express.Router();

/** 
 * @brief Firebase messaging options configuration
 * @details Default options for Firebase Cloud Messaging including
 * high priority delivery and 24-hour time-to-live for notifications
 */
let options = {
    priority: "high",
    timeToLive: 60 * 60 * 24
};

/**
 * @brief Middleware for logging incoming room requests
 * @param req Express request object
 * @param res Express response object  
 * @param next Next middleware function
 * 
 * @details
 * Logs all incoming requests to the room management module with timestamp
 * for debugging and monitoring purposes.
 */
Route2Room.use(function timeLog(req:Request, res:Response, next:NextFunction) {
    logger.info(`[register] ------ new request [ ${Date.now()} ]------`);
    next();
});

/**
 * @brief POST endpoint for room invitation with push notifications
 * @details Handles room invitation requests and sends Firebase notifications
 * @route POST /room/invite
 */
Route2Room.post('/invite', function (req:Request, res:Response) {
    handlePostInvite(req, res);
})

/**
 * @brief GET endpoint for room status information
 * @details Returns basic room information by room ID
 * @route GET /room/:roomId
 */
Route2Room.get('/:roomId', function (req:Request, res:Response) {
    res.send(`You are in ${req.params.roomId}`);
});


/**
 * @brief Generates a random room identifier
 * @param len Length of the room ID to generate
 * @return string Random numeric room identifier
 * 
 * @details
 * Creates a random room ID consisting of numeric digits for use in
 * RTC communication sessions. Each room ID is used to uniquely
 * identify a communication session between devices.
 * 
 * @note There's a bug in the implementation - should use 'len' instead of 'length'
 */
function generateRandomRoom(len: number): string {
    let no = '';
    for (let i = 0; i < len; i++) {
        no += Math.floor((Math.random() * 10));
    }
    return no;
}

/**
 * @brief Handles room invitation requests with Firebase push notifications
 * @param req Express request object containing invitation data
 * @param res Express response object for sending results
 * 
 * @details
 * Processes room invitation requests from interphone/doorbell systems:
 * 1. Validates required parameters (target and source addresses)
 * 2. Generates a random 8-digit room ID for the session
 * 3. Queries database for Firebase tokens of target devices
 * 4. Formats Korean address display (B→동, U→호)
 * 5. Sends Firebase push notifications to all registered devices
 * 6. Includes room invitation data for mobile app handling
 * 
 * Expected request body:
 * - target: Target device address to invite
 * - source: Source device address (caller identification)
 * 
 * Firebase notification includes:
 * - Korean localized title and body
 * - RTC connection parameters
 * - Room ID for session establishment
 * - Android-specific sound and channel configuration
 * 
 * @return HTTP status 200 on success, 400/401 on validation errors
 */
async function handlePostInvite(req: Request, res: Response) {
    if (req.body.target === undefined) {
        res.sendStatus(400);
        return;
    }
    else if (req.body.source === undefined) {
        res.sendStatus(401);
        return;
    }

    let roomId = generateRandomRoom(8);
    let db = await DbConn.createSqlConnection();
    let sql = `SELECT token FROM ${CallFusion.getTableForMobile()} WHERE address="${req.body.target}"`
    DbConn.sqlSelect(db, sql, (error:MysqlError, rows:any) => {
        if (error) {
            logger.error(error);
            res.status(401).send(error);
            return;
        }

        /**
         * @brief Korean address localization
         * @details Converts building/unit notation to Korean characters:
         * - 'B' (Building) → '동' (dong)
         * - 'U' (Unit) → '호' (ho)
         * This provides user-friendly Korean display in notifications
         */
        // Korean
        let koreanAddress = req.body.source;
        koreanAddress = koreanAddress.replace('B', '동');
        koreanAddress = koreanAddress.replace('U', '호');

        /**
         * @brief Firebase push notification message structure
         * @details Complete notification payload including:
         * - Korean localized title with timestamp
         * - Korean message asking user to accept the call
         * - RTC connection parameters for call establishment
         * - Android-specific configuration for sound and channel
         */
        const message : TokenMessage = {
            token: "",
            notification: {
                title: `방문자 (${Utils.getDateTime()})`,
                body: `새로운 방문자가 있습니다.지금 연결하시겠습니까? ${koreanAddress}`
            },
            data: {
                method: "invite",
                sender: "rtc:101B405U@192.168.0.157",
                receiver: "rtc:101B203U@192.168.0.167:8088",
                code: "100",
                device: "interphone",
                roomId: `${roomId}`
            },
            android: {
                priority: "high",
                notification: {
                    channelId: "callfusion_2_rtc",
                    sound: "doorbell.wav"
                }
            }
        };   
        /**
         * @brief Collect Firebase registration tokens from database results
         * @details Extracts valid Firebase tokens from the database query results
         * for sending multicast notifications to all registered devices of the target address
         */
        const registerationTokens = [];
        for (let i = 0; i < rows.length ; i++) {
            if (rows[i].token) {
                registerationTokens.push(rows[i].token);
            }
        }
        
        /**
         * @brief Create multicast message payload
         * @details Combines the base message with the array of registration tokens
         * for Firebase multicast delivery to multiple devices
         */
        // Add tokens property to payload for MulticastMessage
        const multicastPayload = {
            ...message,
            tokens: registerationTokens
        };

        /**
         * @brief Send Firebase multicast notification
         * @details Delivers the invitation notification to all registered devices
         * and logs the success/failure results. Uses Firebase Admin SDK for delivery.
         */
        Firebase.getMessaging().sendEachForMulticast(multicastPayload)
            .then((response: any) => {
                logger.info(`${response.successCount} messages were sent successfully`);
            })
            .catch(function (error: string) {
                logger.error("error sending message:", error);
                // do not stop!!
            });

        res.sendStatus(200);
    });
}

/** @brief Export the room management router for use in main application */
export default Route2Room;