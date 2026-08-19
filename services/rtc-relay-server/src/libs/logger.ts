/**
 * @file logger.ts
 * @brief winston 로거.
 *
 * 이 서비스는 시그널링 릴레이라 로그가 요청량에 비례해 늘어난다. WebRTC 통화
 * 하나를 세우는 데 offer/answer(수 KB SDP) + ICE candidate 수십 개가 오가므로,
 * 메시지마다 파일에 쓰면 통화량이 아니라 로깅이 먼저 병목이 된다.
 *
 * 이관 전 설정의 문제 세 가지를 여기서 고쳤다.
 *
 *  1. 트랜스포트가 콘솔 + error.log + combined.log 3개라 로그 한 줄마다
 *     포맷팅 1회 + 파일 쓰기 2회를 했다. 프로덕션에서는 pm2 가 stdout 을
 *     받아 파일로 또 쓰므로 콘솔까지 켜 두면 같은 줄이 세 곳에 남았다.
 *  2. combined.log 에 로테이션이 없어 무한히 자랐다 (실제로 25MB 까지 컸다).
 *  3. 로테이션을 붙이려고 만든 DailyRotateFile 이 transports 배열에 등록되지
 *     않고 파일 끝에 덩그러니 new 만 되어 있었다. 그래서 application-*.log 는
 *     날마다 만들어지기만 하고 늘 0바이트였다.
 *
 * LOG_LEVEL / CONSOLE_LOGGING 은 .env.example 과 ENVIRONMENT_VARIABLES.md 에
 * 예전부터 적혀 있었지만 코드가 읽지 않았다. 이제 읽는다.
 */
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

const isProduction = process.env.NODE_ENV === 'production';

/** 로그 수준. 없으면 프로덕션 info, 그 외 debug. */
const level = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

/**
 * 콘솔 출력 여부.
 *
 * 프로덕션에서는 pm2 가 stdout 을 파일로 받으므로 기본으로 끈다. 아래 파일
 * 트랜스포트와 겹쳐 같은 내용을 두 번 쓰기 때문이다. 켜려면 CONSOLE_LOGGING=true.
 */
const consoleLogging = process.env.CONSOLE_LOGGING
    ? process.env.CONSOLE_LOGGING === 'true'
    : !isProduction;

// Define your custom log format
const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }), // Include stack trace for errors
    winston.format.splat(), // Handles string interpolation like %s
    winston.format.json() // Output logs as JSON
);

/** 회전 규칙은 모든 파일 트랜스포트가 같이 쓴다. */
const rotation = {
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m', // 20MB 마다 회전
    maxFiles: '14d', // 14일치만 보관
};

const transports: winston.transport[] = [
    // 평상시 로그. 회전하지 않던 combined.log 를 대체한다.
    new DailyRotateFile({ ...rotation, filename: 'logs/application-%DATE%.log' }),
    // 오류만 따로. 뒤져 볼 때 쓴다.
    new DailyRotateFile({ ...rotation, filename: 'logs/error-%DATE%.log', level: 'error' }),
];

if (consoleLogging) {
    transports.push(
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                // 예전에는 `stack || message` 라 Error 를 함께 넘긴 로그는
                // 스택만 보이고 정작 무슨 상황인지 적어 둔 문구가 사라졌다.
                // 둘 다 보여 준다.
                winston.format.printf(({ level, message, timestamp, stack }) => {
                    return `${timestamp} ${level}: ${message}${stack ? `\n${stack}` : ''}`;
                })
            ),
        })
    );
}

const logger = winston.createLogger({
    level,
    format: logFormat,
    transports,
    // 로그를 남긴 뒤 winston 이 프로세스를 죽이지 않게 한다.
    // 예외 하나로 접속자 전원이 끊기던 문제를 index.ts 에서 고쳤는데,
    // 이 값이 기본(true)이면 winston 이 대신 종료시켜 같은 일이 벌어진다.
    exitOnError: false,
    exceptionHandlers: [
        new DailyRotateFile({ ...rotation, filename: 'logs/exceptions-%DATE%.log' }),
    ],
    rejectionHandlers: [
        new DailyRotateFile({ ...rotation, filename: 'logs/rejections-%DATE%.log' }),
    ],
});

export default logger;
