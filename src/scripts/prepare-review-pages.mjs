// 提审包：编译前生成一份「不含广场」的 pages.json，编译完恢复原文件。
//
// 为什么必须在编译前（广场下架令 2026-11-10 第三节第 1 条）：
// 1.0.7 被驳回的原因就是「只在产物里删目录」。审核看整个代码包，
// 页面一旦登记在 pages.json 里，uni 就会为它生成分包入口与公共引用，光删目录不够，
// 公共 JS 里仍会残留 /community/ 与广场相关字样。
//
// 做法：
//   1. 备份 src/pages.json → 内存字符串
//   2. 写一份去掉【广场三页 + 会员页 + 开发自测页】和【广场 tab】的版本
//   3. 交给后续构建
//   4. 无论成功失败，最后都恢复原文件（restore 由调用方在 finally 里保证）
//
// 用法（由 build-engine.mjs 调用，不手工执行）：
//   node scripts/prepare-review-pages.mjs prepare
//   node scripts/prepare-review-pages.mjs restore
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(HERE, '..', 'src');
const PAGES = path.join(SRC_DIR, 'pages.json');
const BACKUP = path.join(SRC_DIR, 'pages.json.review-backup');

// 提审包里必须一点都不能有的页面（广场是社交功能，个人主体不开放）
const DROP_PAGES = ['pages/square/index', 'pages/post/index', 'pages/post-create/index'];
// 会员页与开发自测页：D39 / D-05 既有口径，一并去掉
const DROP_EXTRA = ['pages/member/index', 'pages/dev/index'];
// tabBar 只保留这两项
const ALLOW_TABS = ['pages/index/index', 'pages/mine/index'];

function prepare() {
  const raw = fs.readFileSync(PAGES, 'utf8');
  fs.writeFileSync(BACKUP, raw, 'utf8');

  const cfg = JSON.parse(raw);
  const before = (cfg.pages || []).length;
  const drop = DROP_PAGES.concat(DROP_EXTRA);
  cfg.pages = (cfg.pages || []).filter((p) => !drop.includes(p.path));

  if (cfg.tabBar && Array.isArray(cfg.tabBar.list)) {
    cfg.tabBar.list = cfg.tabBar.list.filter((t) => ALLOW_TABS.includes(t.pagePath));
  }

  fs.writeFileSync(PAGES, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log(
    '  · 提审前 pages.json：' +
      before +
      ' → ' +
      cfg.pages.length +
      ' 页（去掉广场 ' +
      DROP_PAGES.length +
      ' 页 + 会员/开发 ' +
      DROP_EXTRA.length +
      ' 页）'
  );
  console.log('  · 提审前 tabBar：' + cfg.tabBar.list.map((t) => t.text).join(' / '));
}

function restore() {
  if (!fs.existsSync(BACKUP)) {
    console.log('  · pages.json 无备份，跳过恢复');
    return;
  }
  fs.writeFileSync(PAGES, fs.readFileSync(BACKUP, 'utf8'), 'utf8');
  fs.unlinkSync(BACKUP);
  console.log('  · 已恢复原 pages.json');
}

const cmd = process.argv[2];
if (cmd === 'prepare') prepare();
else if (cmd === 'restore') restore();
else {
  console.error('用法：node scripts/prepare-review-pages.mjs prepare|restore');
  process.exit(2);
}
