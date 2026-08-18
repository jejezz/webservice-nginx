// logger.ts (or logger.js)
import winston from 'winston';
import 'winston-daily-rotate-file'; // Import for side effects (registers the transport)

// Define your custom log format
const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }), // Include stack trace for errors
    winston.format.splat(), // Handles string interpolation like %s
    winston.format.json() // Output logs as JSON
    // Or for pretty printing in development:
    // winston.format.printf(({ level, message, timestamp, stack }) => {
    //     return `${timestamp} [${level.toUpperCase()}]: ${stack || message}`;
    // })
);

const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug', // Log level based on environment
    format: logFormat,
    transports: [
        // Console transport (for development or general console output)
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(), // Add colors to console output
                winston.format.simple(), // Simple format for console
                // Or you can use a more custom printf for console as well:
                winston.format.printf(({ level, message, timestamp, stack }) => {
                    return `${timestamp} ${level}: ${stack || message}`;
                })
            )
        }),
        // File transport (for persistent logging to a file)
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' })
    ],
    exceptionHandlers: [
        new winston.transports.File({ filename: 'logs/exceptions.log' })
    ],
    rejectionHandlers: [
        new winston.transports.File({ filename: 'logs/rejections.log' })
    ]
});

// ... in your logger.ts
new winston.transports.DailyRotateFile({
    filename: 'logs/application-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m', // Rotate after 20MB
    maxFiles: '14d' // Keep logs for 14 days
})

export default logger;