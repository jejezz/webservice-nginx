# node.js로 RTC SIGNAL 서버 개발 환경 설정 (with TypeScript)


## > Pre-requisite 1 - 공유기 Port forward 설정 (외부 접속 시시)

```
HTTP TCP port - 28090
```


## > Pre-requisite 2 - Database 설정

```
 - mysql client
 - user id: jejezz
 - password: __REDACTED__
 - database: callfusion2rtc

 OR change the contents of src/config/database.ts file 
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
    "build": "tsc -p .",
    "dev": "nodemon --watch \"src/**/*.ts\" --exec \"ts-node\" src/index.ts"
  },
  ...
}
```

### - 개발 시작
```
npm run dev
```


