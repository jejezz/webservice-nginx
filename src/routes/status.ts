import { Router, Request, Response } from 'express';
import { CallFusion } from '../index';

const router = Router();

// GET /status/rooms - 룸 테이블 정보를 JSON으로 반환
router.get('/rooms', (req: Request, res: Response) => {
    try {
        const callFusion = req.app.get('callFusion') as CallFusion;
        const roomTable = callFusion.roomTable;
        
        const roomsData = Array.from(roomTable.roomTable.entries()).map(([roomId, room]) => {
            const clients = Array.from(room.clients.entries()).map(([clientId, client]) => ({
                clientId: client.cid,
                roomId: client.rid,
                address: client.address,
                ipAddress: client.ipaddress,
                agent: client.agent,
                device: client.device,
                initiator: client.initiator,
                alive: client.alive,
                messageQueueLength: client.messageQueue.length,
                subscription: client.susbcription,
                roomSpecData: client.roomSpecData,
                iotSpecData: client.iotSpecData
            }));
            
            return {
                roomId: roomId,
                clientCount: room.clients.size,
                clients: clients,
                registerTimeout: room.registerTimeout
            };
        });
        
        const summary = {
            totalRooms: roomTable.roomTable.size,
            totalWebsocketConnections: roomTable.websocketCount(),
            rooms: roomsData
        };
        
        res.json(summary);
    } catch (error) {
        console.error('Error getting room status:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;