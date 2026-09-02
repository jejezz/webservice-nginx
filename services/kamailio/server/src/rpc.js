/**
 * Kamailio JSON-RPC 클라이언트 (FIFO 전송).
 *
 * 왜 FIFO 인가 — 다른 경로는 다 막혔다.
 *
 *   HTTP    jsonrpcs.so 는 배포판 설정 259행에서 로드되는데, 우리 오버라이드는
 *           127행이라 jsonrpc_dispatch 를 모른다 ("failed to find command").
 *   binrpc  /run/kamailio/kamailio_ctl 이 srw------- 라 소유자만 쓸 수 있다.
 *           kamcmd 는 JSON 출력도 없어 파싱이 번거롭다.
 *   datagram  Node 의 dgram 은 유닉스 소켓을 지원하지 않는다.
 *   FIFO    prw-rw---- kamailio:kamailio → 그룹 권한으로 접근 가능. JSON 그대로.
 *
 * 그래서 이 프로세스는 kamailio 그룹으로 실행되어야 한다.
 *
 *     sudo usermod -aG kamailio <pm2 를 돌리는 사용자>
 *
 * Kamailio 설정은 전혀 건드리지 않는다 — transport=7 에 FIFO 가 이미 포함돼 있다.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FIFO = process.env.KAMAILIO_RPC_FIFO || '/run/kamailio/kamailio_rpc.fifo';
/** 응답 FIFO 를 둘 곳. Kamailio 의 fifo_reply_dir 과 같아야 한다 (기본 /tmp). */
const REPLY_DIR = process.env.KAMAILIO_RPC_REPLY_DIR || '/tmp';
/** 응답 FIFO 를 읽을 쪽. Kamailio 를 돌리는 그룹이다. */
const REPLY_GROUP = process.env.KAMAILIO_RPC_REPLY_GROUP || 'kamailio';
// 영숫자와 밑줄만 쓴다. Kamailio 가 이 이름으로 fifo_reply_dir 아래 파일을 찾는다.
const REPLY_NAME = `kamailio_dashboard_reply_${process.pid}`;
const REPLY_PATH = path.join(REPLY_DIR, REPLY_NAME);

const TIMEOUT_MS = parseInt(process.env.KAMAILIO_RPC_TIMEOUT_MS, 10) || 3000;

let replyFd = null;
/** 요청을 직렬화한다. 응답 FIFO 하나를 재사용하므로 동시에 보내면 섞인다. */
let chain = Promise.resolve();

/**
 * 응답 FIFO 를 만들고 연다.
 *
 * O_RDWR 로 여는 것이 핵심이다. O_RDONLY 로 열면 쓰는 쪽이 없는 동안 read() 가
 * 0(EOF)을 돌려주기 때문에, Kamailio 가 응답을 쓰기도 전에 스트림이 끝나 버린다.
 * 우리 자신이 쓰기 쪽으로도 열려 있으면 EOF 가 나지 않는다. (FIFO 를 오래 붙들고
 * 읽을 때 쓰는 관용적인 방법이다)
 */
function ensureReplyFifo() {
  if (replyFd !== null) return;

  if (!fs.existsSync(REPLY_PATH)) {
    // Node 에 mkfifo 가 없다. 0660 으로 만든다.
    execFileSync('mkfifo', ['-m', '660', REPLY_PATH]);
  }

  // 그룹을 kamailio 로 **직접 바꾼다.**
  //
  // ⚠️ 새로 만든 파일의 그룹은 만든 프로세스의 **유효 gid** 로 정해진다.
  //    kamailio 그룹에 보조로 들어 있는 것만으로는 부족하다 — 그때 이 FIFO 는
  //    jejezz:jejezz 0660 으로 나오고, kamailio 는 그것을 열지 못한다:
  //
  //      ERROR: jsonrpcs jsonrpc_open_reply_fifo(): open error
  //             (/tmp/kamailio_dashboard_reply_<pid>): Permission denied
  //
  //    그러면 요청은 나가는데(그쪽 FIFO 는 그룹 권한으로 써진다) 응답만 오지
  //    않는다. 화면에는 "RPC 응답 시간 초과: 0바이트 받음" 으로만 보여서,
  //    권한 문제라는 것이 전혀 드러나지 않는다.
  //
  //    예전에는 `sg kamailio -c` 로 pm2 를 띄우면 유효 gid 까지 kamailio 가
  //    되어 우연히 맞았다. 그래서 **띄운 방법에 따라 되기도 하고 안 되기도
  //    했다.** 여기서 직접 맞추면 그 의존이 사라진다.
  //
  //    root 는 필요 없다 — 이 파일의 소유자이고 그 그룹의 구성원이면 된다.
  chgrpReply();
  // O_RDWR 인 이유: O_RDONLY 로 열면 쓰는 쪽이 없는 동안 read() 가 0(EOF)을
  // 돌려주어, Kamailio 가 응답을 쓰기도 전에 끝난 것으로 보인다. 우리 자신이
  // 쓰기 쪽으로도 열려 있으면 EOF 가 나지 않는다.
  //
  // O_NONBLOCK 인 이유: 막히는 read 는 libuv 워커를 붙들어 두는데, 타임아웃이
  // 나도 그 read 가 살아남아 **다음 요청의 응답을 가로챈다.** 논블로킹으로 열고
  // 짧게 폴링하면 그런 일이 없다.
  try {
    replyFd = fs.openSync(REPLY_PATH, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  } catch (err) {
    throw explain(err);
  }
}

/**
 * 응답 FIFO 의 그룹을 kamailio 로 맞춘다.
 *
 * 이미 맞으면 아무것도 하지 않는다. 못 바꾸면 그 이유를 사람이 조치할 수 있는
 * 문구로 바꿔 던진다 — 여기서 조용히 넘어가면 증상이 다시 '시간 초과' 가 되고,
 * 그것만 보고 권한까지 도달하기는 어렵다.
 */
function chgrpReply() {
  let gid;
  try {
    // getent 를 쓴다. /etc/group 만 읽으면 LDAP 같은 다른 백엔드를 놓친다.
    const line = execFileSync('getent', ['group', REPLY_GROUP], { encoding: 'utf8' }).trim();
    gid = Number(line.split(':')[2]);
  } catch {
    throw new Error(
      `${REPLY_GROUP} 그룹을 찾지 못했습니다. Kamailio 가 설치돼 있는지 확인하세요`
      + ' (getent group ' + REPLY_GROUP + ').'
    );
  }
  if (!Number.isInteger(gid)) throw new Error(`${REPLY_GROUP} 그룹의 gid 를 읽지 못했습니다.`);

  const st = fs.statSync(REPLY_PATH);
  if (st.gid === gid) return;

  try {
    fs.chownSync(REPLY_PATH, st.uid, gid);
  } catch (err) {
    throw new Error(
      `${REPLY_PATH} 의 그룹을 ${REPLY_GROUP} 으로 바꾸지 못했습니다 (${err.code}).\n`
      + `  이 프로세스가 ${REPLY_GROUP} 그룹에 들어 있어야 합니다. usermod 만으로는\n`
      + '  부족합니다 — 그룹은 로그인 때 정해져서, 이미 떠 있는 pm2 데몬은 옛 그룹\n'
      + '  집합을 그대로 씁니다. 해결: pm2/restart.sh --restart (또는 --sg).\n'
      + `  확인: grep ^Groups: /proc/${process.pid}/status  → ${gid} 가 있어야 합니다`
    );
  }
}

function cleanup() {
  if (replyFd !== null) {
    try { fs.closeSync(replyFd); } catch { /* 종료 중이다 */ }
    replyFd = null;
  }
  try { fs.unlinkSync(REPLY_PATH); } catch { /* 이미 없다 */ }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(0); });

/**
 * 권한 오류를 사람이 조치할 수 있는 문구로 바꾼다.
 *
 * 그냥 두면 화면에 "EACCES: permission denied" 만 뜨는데, 그것만 보고
 * "pm2 를 띄운 셸의 보조 그룹이 낡았다" 까지 도달하기는 어렵다. 실제로 한 번
 * 겪었다 — usermod 을 하고 pm2 를 재시작했는데도 안 되는 상황이었다.
 */
function explain(err) {
  if (err.code === 'EACCES') {
    return new Error(
      `${FIFO} 에 접근할 수 없습니다 (EACCES). 이 프로세스가 kamailio 그룹이 아닙니다.\n`
      + '  usermod 만으로는 부족합니다 — 그룹은 로그인 때 정해져서, 이미 떠 있는 셸과\n'
      + '  그 셸이 띄운 pm2 데몬은 옛 그룹 집합을 그대로 씁니다.\n'
      + '  해결: 다시 로그인한 뒤 pm2 를 재시작하거나, 로그아웃 없이 하려면\n'
      + '    pm2 kill && sg kamailio -c "cd <프로젝트>/pm2 && pm2 start ecosystem.config.js && pm2 save"\n'
      + '  확인: grep ^Groups: /proc/$(pm2 pid kamailio-dashboard)/status  → 143 이 있어야 합니다'
    );
  }
  if (err.code === 'ENOENT') {
    return new Error(`${FIFO} 가 없습니다. kamailio 가 실행 중인지 확인하세요 (systemctl status kamailio).`);
  }
  return err;
}

/** 완결된 JSON 이 모일 때까지 읽는다. */
function readResponse() {
  const deadline = Date.now() + TIMEOUT_MS;
  const chunk = Buffer.alloc(64 * 1024);

  return new Promise((resolve, reject) => {
    let buf = '';
    const tick = () => {
      let bytes = 0;
      try {
        bytes = fs.readSync(replyFd, chunk, 0, chunk.length, null);
      } catch (err) {
        // 논블로킹 FIFO 가 비어 있으면 EAGAIN 이다. 오류가 아니라 "아직" 이다.
        if (err.code !== 'EAGAIN') return reject(err);
      }
      if (bytes > 0) {
        buf += chunk.toString('utf8', 0, bytes);
        // Kamailio 는 응답 하나를 통째로 쓴다. 다 모였는지는 파싱으로 판단한다.
        try {
          return resolve(JSON.parse(buf));
        } catch {
          /* 아직 덜 왔다 */
        }
      }
      if (Date.now() > deadline) {
        return reject(new Error(`Kamailio RPC 응답 시간 초과 (${TIMEOUT_MS}ms): ${buf.length}바이트 받음`));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

/**
 * @param {string} method  예: 'ul.dump'
 * @param {Array}  params  없으면 생략
 * @returns {Promise<any>} result 필드
 */
function call(method, params) {
  const run = async () => {
    ensureReplyFifo();

    const request = { jsonrpc: '2.0', method, reply_name: REPLY_NAME, id: 1 };
    if (params && params.length) request.params = params;

    const pending = readResponse();
    try {
      // Kamailio 는 이 FIFO 를 항상 읽고 있으므로 쓰기가 막히지 않는다.
      fs.writeFileSync(FIFO, `${JSON.stringify(request)}\n`);
    } catch (err) {
      throw explain(err);
    }

    const res = await pending;
    if (res.error) {
      const e = new Error(res.error.message || 'Kamailio RPC 오류');
      e.code = res.error.code;
      throw e;
    }
    return res.result;
  };

  // 앞 요청이 끝난 뒤에 보낸다. 실패해도 사슬이 끊기지 않게 한다.
  const next = chain.then(run, run);
  chain = next.then(() => {}, () => {});
  return next;
}

/** 여러 명령을 한 번에. 하나가 실패해도 나머지는 살린다. */
async function callAll(spec) {
  const out = {};
  for (const [key, [method, params]] of Object.entries(spec)) {
    try {
      out[key] = await call(method, params);
    } catch (err) {
      out[key] = { error: err.message };
    }
  }
  return out;
}

/** 접근 가능 여부. /health 와 대시보드의 오류 안내에 쓴다. */
async function ping() {
  if (!fs.existsSync(FIFO)) {
    return { ok: false, error: `FIFO 가 없습니다: ${FIFO} — kamailio 가 실행 중인지 확인하세요` };
  }
  try {
    fs.accessSync(FIFO, fs.constants.W_OK);
  } catch (err) {
    return { ok: false, error: explain(err).message };
  }
  try {
    const uptime = await call('core.uptime');
    return { ok: true, uptime: uptime.uptime };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { call, callAll, ping, explain, FIFO, REPLY_PATH };
