/**
 * janus.js 를 런타임에 불러온다.
 *
 * 번들에 넣지 않고 <script> 로 불러오는 이유는 **버전을 맞추기 위해서**다.
 * setup-dashboard.sh --build 가 /opt/janus/share/janus/javascript/janus.js 를
 * web/public/ 로 복사하므로, 이 파일은 항상 지금 돌고 있는 Janus 의 것이다.
 * npm 으로 받거나 커밋해 두면 Janus 를 올릴 때 어긋날 수 있고, 그 어긋남은
 * 조용히 실패한다. (docs/plan.md 의 "janus.js 는 커밋하지 않는다")
 *
 * janus.js 는 UMD 라 <script> 로 부르면 window.Janus 가 생긴다.
 * 다만 전역 adapter(webrtc-adapter)를 요구하므로 먼저 심어 준다.
 */
import adapter from 'webrtc-adapter';

const SCRIPT_URL = `${import.meta.env.BASE_URL.replace(/\/+$/, '')}/janus.js`;

let loading = null;

export function loadJanus() {
  if (window.Janus) return Promise.resolve(window.Janus);
  if (loading) return loading;

  loading = new Promise((resolve, reject) => {
    window.adapter = adapter;

    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      if (window.Janus) resolve(window.Janus);
      else reject(new Error('janus.js 를 불러왔지만 Janus 전역이 없습니다'));
    };
    script.onerror = () => {
      loading = null;
      reject(new Error(
        `janus.js 를 불러오지 못했습니다 (${SCRIPT_URL}). `
        + 'services/janus/setup-dashboard.sh --build 를 실행했는지 확인하세요.'
      ));
    };
    document.head.appendChild(script);
  });

  return loading;
}

/** Janus.init 은 한 번만 부르면 된다. */
let initialized = null;

export function initJanus({ debug = false } = {}) {
  if (initialized) return initialized;

  initialized = loadJanus().then(
    (Janus) =>
      new Promise((resolve) => {
        Janus.init({ debug, callback: () => resolve(Janus) });
      })
  );

  return initialized;
}
