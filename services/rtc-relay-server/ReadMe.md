# node.js로 RTC SIGNAL 서버 개발 환경 설정 (with TypeScript)


## > Pre-requisite 1 - 공유기 Port forward 설정 (외부 접속 시시)

```
HTTP TCP port - 28090
```


## > Pre-requisite 2 - Database 설정

DB 는 프로젝트가 관리합니다 — `database/README.md` 를 따릅니다.

- 스키마: `rtc_relay` (이 서비스의 `schema/*.sql` 이 정의하고 `database/database.ini`
  의 `[database:rtc_relay]` 가 가리킵니다)
- 계정: 공용 `jyahn` 하나
- **비밀번호는 소스나 문서에 쓰지 않습니다.** `database/secrets/jyahn.pw` 에 있고
  서비스가 그 파일을 읽습니다 (`.env` 의 `DB_PASSWORD_FILE`).

스키마를 만들거나 바꾸려면:

```bash
sudo ../../database/setup_mariadb.sh --dry-run   # 무엇이 바뀌는지 확인
sudo ../../database/setup_mariadb.sh             # 적용
```

## > Node 개발환경 설정

### - package.json 파일 생성 등의 프로젝트 생성

```
npm init -y
```

### - 개발에 필요한 패키지 설치

```
npm i -D typescript ts-node nodemon
```

### - tsconfig.json 파일 생성을 위해 다음 명령 수행
```
npx tsc --init
```
### - tsconfig.json에 다음 내용 추가
```
{
  ...
  "target": "es6",
  "module": "commonjs",
  "outDir": "./dist",
  "rootDir": "./src",
  "strict": true,
  "moduleResolution": "node",
  "esModuleInterop": true,
  ...
}
```

### - dist와 src 폴더를 생성하고 src에 index.ts 파일 생성하고 packagejson에 다음 내용 추가 (optional)
```
{
  ...
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "dev": "nodemon --watch \"src/**/*.ts\" --exec \"ts-node\" src/index.ts"
  },
  ...
}
```

### - 개발 시작
```
npm run dev
```




## 앞으로 할 일

위치 공유와 메시지 기능은 **아직 없습니다.** `ANDROID_API_GUIDE.md` 의 그룹 API
절(`/group/*`)은 구현되지 않은 계획이며 실제로는 404 입니다.

방향과 제약은 [LOCATION_MESSAGING_PLAN.md](LOCATION_MESSAGING_PLAN.md) 에 정리해
두었습니다. 착수 전에 그 문서의 "만들 때 정해야 할 것" 여섯 가지에 답이 필요합니다.

## 타입 검사

실행은 tsx 가 `src/index.ts` 를 직접 하므로 빌드 단계가 없습니다 (`pm2-conf/app.ini`
의 `script` 참고). 산출물을 만들지 않고 검사만 합니다.

```bash
npm run typecheck
```

tsx 는 타입을 확인하지 않으므로 이 명령이 유일한 타입 안전망입니다. 실제로
파라미터 바인딩 작업 때 `websocketService.ts` 에 남아 있던 인젝션 경로를
이 검사가 찾아냈습니다.

`emit` 하지 않는 이유는 아무도 쓰지 않는 `dist/` 가 남아 소스와 어긋나기 때문입니다.

## 관리 대시보드

`https://<서버>/rtc-relay/dashboard`

manager 로그인 하나로 들어갑니다 — 이 서비스는 계정을 두지 않고 세션만 검증합니다
(`src/auth/session.ts`, 시크릿은 `services/.session-secret`). 화면은 개요 · 방 ·
모바일 단말 · 홈넷 장치 네 가지입니다.

프론트엔드는 `web/` 에 있고 manager · ws-bridge 와 같은 구성입니다
(React 18 + Vite 6 + Tailwind 3 + shadcn/ui). 빌드 결과 `web/dist` 를 이 서비스가
직접 서빙하므로 별도 정적 서버가 없습니다.

```bash
cd web && npm install && npm run build   # 빌드. 빌드가 없으면 대시보드 경로가 503
cd web && npm run dev                    # 개발 서버 (5185, API 는 28099 로 프록시)
```

`web/vite.config.js` 의 `BASE`(`/rtc-relay/dashboard/`)가 라우터 basename 과 API
경로의 출처입니다. Nginx 라우트(`nginx-conf/service.ini` 의 `location`)나 대시보드
경로(`pm2-conf/app.ini` 의 `DASHBOARD_PATH`)를 바꾸면 이 값도 함께 바꿔야 합니다.

### 경로가 둘인 이유

Android 단말은 포트 28099 에 자체 인증서로 직접 붙고, 사람은 Nginx 를 거쳐
`/rtc-relay/...` 로 옵니다. 앱은 같은 라우터를 두 경로에 마운트해 양쪽에 응답합니다.

예외가 하나 있습니다. `/mobile-crud-operation` 은 **포트 직접 경로에만** 붙입니다.
Nginx 를 거친 요청은 소켓 주소가 항상 127.0.0.1 이라 이 라우트의 내부망 IP 제한이
무의미해지기 때문입니다. 사람이 쓰는 단말 관리는 세션을 요구하는 대시보드에 있습니다.
