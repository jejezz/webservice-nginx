const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../config');
const log = require('../logger');

const execFileAsync = promisify(execFile);

/**
 * 문서 화면이 보여줄 목록 — **git 이 추적하는 `.md` 파일 전부.**
 *
 * 왜 이렇게 고르는가: 이 저장소는 비밀을 커밋하지 않는다는 규약이 이미
 * 있다 (settings.ini·secrets/·.env 는 전부 .gitignore 대상 — docs/db-conf.md,
 * database/README.md 등 곳곳에서 반복되는 원칙). 그 규약을 그대로 안전장치로
 * 쓴다 — **추적되지 않는 파일은 애초에 후보에 오르지 않는다.** 화면에 새
 * 문서를 노출하려고 이 파일을 고칠 일이 없다: 커밋하면 자동으로 보인다.
 *
 * `getContent()` 는 이 목록에 **정확히 있는 경로만** 읽는다 — 클라이언트가
 * 보낸 경로를 그대로 파일시스템에 넘기지 않으므로 상위 디렉토리 접근이
 * 불가능하다.
 */
async function listPaths() {
  const { stdout } = await execFileAsync('git', ['ls-files', '*.md'], {
    cwd: config.repoRoot,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
}

async function firstHeading(absPath) {
  try {
    const content = await fs.promises.readFile(absPath, 'utf8');
    const m = content.match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : null;
  } catch (err) {
    log.warn(`docs: ${absPath} 를 읽지 못했습니다 (${err.message})`);
    return null;
  }
}

/** 목록 — 경로마다 파일 첫 `# 제목`을 곁들인다. 없으면 경로 자체를 쓴다. */
async function list() {
  const paths = await listPaths();
  return Promise.all(
    paths.map(async (p) => ({
      path: p,
      title: (await firstHeading(path.join(config.repoRoot, p))) || p,
    }))
  );
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.code = 'NOT_FOUND';
  }
}

async function getContent(relPath) {
  const paths = await listPaths();
  if (!paths.includes(relPath)) {
    throw new NotFoundError(`문서 목록에 없습니다: ${relPath}`);
  }
  const content = await fs.promises.readFile(path.join(config.repoRoot, relPath), 'utf8');
  return { path: relPath, content };
}

module.exports = { list, getContent, NotFoundError };
