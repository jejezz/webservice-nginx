# 위치 공유 · 메시지 기능 계획

**상태: 미착수.** 2026-08-18 에 방향만 정하고 다음 기회로 미뤘습니다.
이 문서는 그때 확인한 사실과 결정을 남겨 두어, 다음 사람이 조사를 되풀이하지
않도록 하는 것이 목적입니다.

## 결정

위치 공유와 메시지를 **별도 기능으로 설계해 만든다.** 기존 시그널링이나 IoT 채널에
얹지 않는다.

세 갈래 중 고른 것입니다.

| | 방법 | 왜 안 골랐나 / 골랐나 |
|---|---|---|
| A | RTC 채널에 `location`·`message` method 추가 | 실시간 전파만 되고 이력이 남지 않는다 |
| B | IoT 채널(`/iot`)의 `payload` 에 얹기 | 채널 의미가 "장치 제어"라 이름과 실제가 어긋난다. 임시로 얹으면 나중에 걷어내기 어렵다 |
| **C** | **별도 기능으로 설계** | **이력·오프라인 전달·그룹 구성원 관리가 필요하다고 판단** |

## 지금 서버가 못 하는 것 (실측)

돌고 있는 서버에 직접 붙여 확인한 것입니다. 다음 작업 때 다시 재 볼 필요 없습니다.

**1. 모르는 `method` 는 조용히 버려진다.**
세 명이 든 방에서 `method:"location"` 에 좌표를 실어 보냈으나 아무도 받지 못했고
오류도 오지 않았다. RTC 디스패치(`websocketService.ts` 의 `handleRtcMessage`)는
`invite` `invite-ack` `offer` `answer` `accept` `candidate` `remove-candidates`
`bye` `error` 만 처리하고 나머지는 `default` 에서 로그만 남긴다.

**2. 방이 사실상 1:1 이다.**
A·B·C 가 든 방에서 A 가 `candidate` 를 보내면 **B 만 받고 C 는 못 받는다.**
`rtcRoom.ts` 의 `sendMessage` 가 반복문에서 첫 상대를 찾자마자 `return` 한다.

```ts
for (let oc of this.clients.values()) {
    if (oc.cid !== cid) {
        return sender.sendTo(oc, message);   // 첫 한 명에게 보내고 끝
    }
}
```

이것을 무조건 전체 전파로 바꾸면 `offer`/`answer` 까지 여러 명에게 가서 통화가
깨진다. method 별로 1:1과 전체 전파를 나누는 분기가 필요하다.

**3. 방은 휘발성이다.**
`RtcRoomTable` 이 `Map` 하나다. 프로세스가 재시작하면 방과 참가자가 사라진다.
이력을 남기려면 `rtc_relay` 스키마에 테이블이 필요하다.

**4. `/group/*` API 는 존재하지 않는다.**
`ANDROID_API_GUIDE.md` 가 `POST /group/create`, `/group/{id}/message`,
`/group/{id}/location`, `/group/{id}/upload` 를 상세히 문서화하고 있으나 **전부 404**
다. "Group Communication API Endpoints", "Location Services Integration",
"Photo Sharing Implementation", "Server Capacity Assessment" 절은 구현되지 않은
계획이다. 이 기능을 만들 때 가이드의 해당 절도 함께 정리해야 한다.

**5. 예전에 시작하다 만 흔적이 있었다.**
`RtcClient` 에 `CommunicationMode` 서브시스템이 있었다 — `canReceiveLocation()`,
`canReceiveMessages()`, `messageType === 'location'` 분기, `firebaseToken` 기반
오프라인 알림 전환까지. 이 기능을 겨냥한 설계로 보이나 어디서도 호출되지 않아
도달 불가능했고, 2026-08-18 에 제거했다 (커밋 `7f92d71`).
**되살릴 생각이면 그 커밋의 `src/libs/rtcClient.ts` 를 먼저 읽어 볼 것.**
설계 의도가 담겨 있어 처음부터 다시 그리는 것보다 빠를 수 있다.

```bash
git show 7f92d71^:src/libs/rtcClient.ts | less
```

## 만들 때 정해야 할 것

착수 전에 답이 필요한 질문들입니다. 이게 정해져야 스키마가 나옵니다.

1. **위치를 동시에 보는 인원** — 2명인가, 그룹인가. 그룹이면 최대 몇 명인가.
2. **이력 보관 기간** — 위치를 계속 쌓으면 금방 커진다. 며칠치를 남길 것인가,
   아니면 마지막 위치만 유지할 것인가.
3. **갱신 주기** — 5초마다인지 1분마다인지에 따라 저장 방식이 달라진다.
4. **오프라인 전달** — 앱이 꺼져 있을 때 온 메시지를 나중에 받아야 하는가.
   그렇다면 FCM 으로 깨울 것인가, 앱이 켜질 때 밀린 것을 가져갈 것인가.
5. **그룹 구성원 관리** — 누가 그룹을 만들고 누구를 넣는가. 초대·수락이 필요한가.
6. **사진 공유** — 가이드에는 있는데 저장소(디스크? DB?)와 용량 정책이 필요하다.
   1차 범위에 넣을지 뺄지.

## 대략의 작업 범위

정확한 설계는 위 질문에 답이 나온 뒤입니다. 규모 감만 적습니다.

- **스키마** — `schema/002-*.sql`. 그룹, 구성원, 메시지, 위치 이력.
  `database/README.md` 규약대로 멱등하게 작성하고 `schema_migrations` 에 버전 추가.
- **전송 경로** — 새 WebSocket 경로(`/share` 등)를 둘지, RTC 채널에 method 를
  추가하고 `sendMessage` 에 전파 분기를 넣을지 결정. 후자는 시그널링 회귀 시험 필요.
- **REST** — 그룹 관리와 이력 조회.
- **대시보드** — 그룹·메시지·위치를 보는 화면. 기존 대시보드에 탭 추가
  (`web/src/pages/`, `src/http/dashboardApi.ts`).
- **Android 예제** — `example/android/{java,kotlin}` 에 새 채널 클라이언트 추가.
- **문서** — `ANDROID_API_GUIDE.md` 의 미구현 절을 실제 구현에 맞게 교체.

## 참고

- 현재 프로토콜 전모: [example/android/README.md](example/android/README.md)
  (서버 소스에서 도출하고 실제로 붙여 확인한 것)
- DB 규약: [../../database/README.md](../../database/README.md)
- 대시보드 구조: [ReadMe.md](ReadMe.md) 의 "관리 대시보드" 절
