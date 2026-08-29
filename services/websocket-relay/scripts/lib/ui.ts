/**
 * 스크립트 공용 출력·입력.
 *
 * setup / doctor / db-* 가 같은 모양으로 보고하도록 여기에 모아 둔다.
 * Reporter 로 문제 수를 세어 마지막에 종료 코드를 정한다 (CI 에서도 쓸 수 있게).
 *
 * Reporter 는 구축 마법사가 읽는 판정도 낸다 (docs/check-contract.md).
 * contract() 를 부르지 않으면 예전과 똑같이 동작하므로, 이 통로를 쓰지 않는
 * setup·db-migrate·db-status 는 아무것도 달라지지 않는다.
 */

import readline from 'readline';

const tty = process.stdout.isTTY;
const c = (code: string) => (tty ? code : '');
const RED = c('\x1b[31m');
const GREEN = c('\x1b[32m');
const YELLOW = c('\x1b[33m');
const DIM = c('\x1b[2m');
const BOLD = c('\x1b[1m');
const RESET = c('\x1b[0m');

/**
 * 점검 규약의 네 레벨 (docs/check-contract.md).
 *
 *   ok       됐다
 *   skip     안 해도 되는 것 · 우리가 못 본 것 (판정에 영향 없음)
 *   pending  아직 안 한 것        → incomplete
 *   problem  잘못된 것            → problem
 */
type Level = 'ok' | 'skip' | 'pending' | 'problem';

export class Reporter {
  problems = 0;

  // ── 점검 규약 모드 ────────────────────────────────────────────────
  //
  // 구축 마법사가 판정을 읽으려면 별도의 통로가 필요하다 — 종료 코드로는
  // 안 된다 (docs/check-contract.md '종료 코드로는 안 됩니다').
  //
  // **사람이 보는 출력은 그대로 둔다.** contract() 를 부르지 않으면 이
  // 클래스는 예전과 똑같이 동작한다. setup·db-migrate·db-status 는 그대로다.
  private step_ = '';
  private json = false;
  private entries: { level: Level; text: string }[] = [];

  /** 이 보고를 마법사가 읽는 단계로 표시한다. asJson 이면 JSON 만 낸다. */
  contract(step: string, asJson: boolean): void {
    this.step_ = step;
    this.json = asJson;
  }

  private add(level: Level, text: string): void {
    if (this.step_) this.entries.push({ level, text });
  }

  /** JSON 모드에서는 사람용 줄을 찍지 않는다 — stdout 에 JSON 만 나가야 한다. */
  private say(line: string): void {
    if (!this.json) console.log(line);
  }

  step(title: string): void {
    this.say(`\n${BOLD}${title}${RESET}`);
  }

  ok(message: string): void {
    this.add('ok', message);
    this.say(`  ${GREEN}✓${RESET} ${message}`);
  }

  /**
   * 안 해도 되는 것, 또는 우리가 확인하지 못한 것.
   *
   * ⚠️ "확인할 수 없음" 을 problem 으로 두면 그 단계가 영원히 막힌다 —
   * 실제로 잘못된 것이 아니라 우리가 못 본 것뿐이다 (docs/check-contract.md).
   */
  warn(message: string): void {
    this.add('skip', message);
    this.say(`  ${YELLOW}!${RESET} ${message}`);
  }

  /**
   * **아직 안 한 것.** 순서가 아직 안 온 것이지 고장이 아니다.
   *
   * 사람이 보는 출력은 bad 와 똑같다 — 터미널에서 쓰던 눈에는 달라지는 것이
   * 없다. 갈라지는 것은 마법사가 읽는 판정뿐이다 (pending vs problem).
   */
  pend(message: string, fix?: string): void {
    this.problems++;
    this.add('pending', fix ? `${message} → ${fix}` : message);
    this.say(`  ${RED}✗${RESET} ${message}`);
    if (fix) this.fix(fix);
  }

  /** 고쳐야 하는 것 — **잘못돼 있는 것**. problems 를 올린다. */
  bad(message: string, fix?: string): void {
    this.problems++;
    this.add('problem', fix ? `${message} → ${fix}` : message);
    this.say(`  ${RED}✗${RESET} ${message}`);
    if (fix) this.fix(fix);
  }

  /** 해결 방법 한 줄. */
  fix(command: string): void {
    this.say(`    ${DIM}→ ${command}${RESET}`);
  }

  info(message: string): void {
    // 판정에 들어가지 않는 안내다 (check-report.sh 의 info 와 같다).
    this.say(`    ${DIM}${message}${RESET}`);
  }

  /**
   * 판정. problem 이 하나라도 있으면 problem, 아니면 pending 이 있으면
   * incomplete, 둘 다 없으면 complete. skip 은 판정에 영향을 주지 않는다.
   */
  private state(): 'complete' | 'incomplete' | 'problem' {
    if (this.entries.some((e) => e.level === 'problem')) return 'problem';
    if (this.entries.some((e) => e.level === 'pending')) return 'incomplete';
    return 'complete';
  }

  /** 마지막 정리. 문제가 있으면 0이 아닌 코드로 끝낸다. */
  finish(nextCommand = 'npm run doctor'): never {
    if (this.json) {
      const state = this.state();
      process.stdout.write(
        `${JSON.stringify({ step: this.step_, state, checks: this.entries }, null, 2)}\n`,
      );
      process.exit(state === 'complete' ? 0 : 1);
    }

    console.log('');
    if (this.problems === 0) {
      console.log(`${GREEN}모두 정상입니다.${RESET}`);
      process.exit(0);
    }
    console.log(
      `${YELLOW}해결할 항목 ${this.problems}개.${RESET} 위의 → 를 실행한 뒤 다시 확인하세요:`,
    );
    console.log(`  ${nextCommand}`);
    process.exit(1);
  }
}

/**
 * 입력은 readline 인터페이스 하나를 공유한다.
 *
 * 프롬프트마다 새로 만들면 첫 인터페이스가 입력을 통째로 버퍼링해 버려서,
 * 두 번째 프롬프트가 영영 응답을 못 받고 프로세스가 조용히 끝난다
 * (파이프로 값을 넘길 때 실제로 그랬다).
 */
let rl: readline.Interface | null = null;
let muted = false;

function prompt(): readline.Interface {
  if (rl) return rl;

  // terminal 은 실제 TTY 일 때만 켠다. 파이프 입력에 terminal:true 를 주면
  // 줄 단위 처리가 어긋나 두 번째 question 의 콜백이 아예 불리지 않는다.
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });

  // 비밀번호를 받을 때 화면에 찍히지 않게 한다.
  const iface = rl as unknown as { _writeToOutput: (text: string) => void; output: NodeJS.WriteStream };
  const original = iface._writeToOutput.bind(rl);
  iface._writeToOutput = (text: string) => {
    if (!muted) return original(text);
    // 프롬프트 자체는 보여 주고 입력만 가린다.
    const keep = text.split('\n').pop() ?? '';
    if (keep.endsWith(': ')) original(text);
  };

  return rl;
}

/** 더 물어볼 게 없을 때 닫는다. 안 닫으면 프로세스가 안 끝난다. */
export function closePrompt(): void {
  rl?.close();
  rl = null;
}

/** 한 줄 입력. 기본값이 있으면 엔터로 넘어갈 수 있다. */
export function ask(question: string, fallback = ''): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : '';
  return new Promise((resolve) => {
    const iface = prompt();
    // 입력이 먼저 끝나면(파이프가 닫히면) 질문 콜백은 영영 안 불린다.
    // 그대로 두면 프로세스가 조용히 종료돼 원인을 알 수 없다.
    const onClose = () => resolve(fallback);
    iface.once('close', onClose);
    iface.question(`${question}${suffix}: `, (answer) => {
      iface.off('close', onClose);
      resolve(answer.trim() || fallback);
    });
  });
}

/**
 * 비밀번호 입력. 화면에 찍히지 않는다.
 *
 * bash 였다면 stty 를 직접 만져야 하는 부분이다.
 */
export function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    const iface = prompt();
    muted = true;
    const finish = (value: string) => {
      muted = false;
      if (process.stdin.isTTY) process.stdout.write('\n');
      resolve(value);
    };
    const onClose = () => finish('');
    iface.once('close', onClose);
    iface.question(`${question}: `, (answer) => {
      iface.off('close', onClose);
      finish(answer);
    });
  });
}

/** 예/아니오. 기본은 아니오. */
export async function confirm(question: string, fallback = false): Promise<boolean> {
  const answer = await ask(`${question} (y/N)`, fallback ? 'y' : 'n');
  return /^y(es)?$/i.test(answer);
}

export const colors = { RED, GREEN, YELLOW, DIM, BOLD, RESET };
