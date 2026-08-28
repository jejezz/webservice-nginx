/**
 * 스크립트 공용 출력·입력.
 *
 * setup / doctor / db-* 가 같은 모양으로 보고하도록 여기에 모아 둔다.
 * Reporter 로 문제 수를 세어 마지막에 종료 코드를 정한다 (CI 에서도 쓸 수 있게).
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

export class Reporter {
  problems = 0;

  step(title: string): void {
    console.log(`\n${BOLD}${title}${RESET}`);
  }

  ok(message: string): void {
    console.log(`  ${GREEN}✓${RESET} ${message}`);
  }

  warn(message: string): void {
    console.log(`  ${YELLOW}!${RESET} ${message}`);
  }

  /** 고쳐야 하는 것. problems 를 올린다. */
  bad(message: string, fix?: string): void {
    this.problems++;
    console.log(`  ${RED}✗${RESET} ${message}`);
    if (fix) this.fix(fix);
  }

  /** 해결 방법 한 줄. */
  fix(command: string): void {
    console.log(`    ${DIM}→ ${command}${RESET}`);
  }

  info(message: string): void {
    console.log(`    ${DIM}${message}${RESET}`);
  }

  /** 마지막 정리. 문제가 있으면 0이 아닌 코드로 끝낸다. */
  finish(nextCommand = 'npm run doctor'): never {
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
