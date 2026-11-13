// AI 版提审包自检（AI版上架令第六节第 2 条）：任何一条不过就报错退出。
//
// 查三件事：
//   1. 全包搜这些词结果为 0：内测、抖音用户、不得提审、/community/
//   2. 产物里有 wx.cloud.init（登录靠云托管身份头）
//   3. 版本号三处一致：manifest.json、brand.js、上传版本号，都是 1.1.0
//
// 为什么要有脚本：上线前改文案最容易漏。规则版有 check-rules-build.mjs，
// AI 版必须有对应的一把尺子，否则「不得提审」这种字样会随旧注释混进包。
//
// 用法：node scripts/check-ai-build.mjs dist/build/mp-weixin
import fs from 'node:fs';
import path from 'node:path';

const DIST = process.argv[2] || 'dist/build/mp-weixin';
// 「抖音用户」是抖音端的平台标签，微信提审包里不该出现任何抖音字样；
// 构建时由 strip-upload-card.mjs 一并把这类跨端文案摘掉，这里只负责核对结果。
const BANNED = ['内测', '抖音用户', '不得提审', '/community/'];
const EXPECT_VERSION = '1.1.0';

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function main() {
  if (!fs.existsSync(DIST)) {
    console.error('[FAIL] 找不到产物目录：' + DIST);
    return 2;
  }
  const files = walk(DIST);
  const textFiles = files.filter((f) => /\.(js|json|wxml|wxss)$/i.test(f));
  let bad = 0;

  console.log('AI 版提审包自检：' + DIST);
  console.log('');

  // 1. 禁用词
  console.log('① 禁用词（必须为 0）：');
  for (const w of BANNED) {
    const hit = textFiles.find((f) => {
      try {
        return fs.readFileSync(f, 'utf8').indexOf(w) >= 0;
      } catch (e) {
        return false;
      }
    });
    if (hit) {
      bad += 1;
      console.log('  [FAIL] 「' + w + '」出现在 ' + path.relative(DIST, hit));
    } else {
      console.log('  [OK]   无「' + w + '」');
    }
  }

  // 2. wx.cloud.init 必须在（登录走云托管身份头）
  console.log('');
  const hasCloudInit = textFiles.some((f) => {
    try {
      const c = fs.readFileSync(f, 'utf8');
      return c.indexOf('cloud.init') >= 0 || c.indexOf("cloud') && c.indexOf('.init('") >= 0;
    } catch (e) {
      return false;
    }
  });
  if (hasCloudInit) {
    console.log('  [OK]   产物里有 wx.cloud.init');
  } else {
    bad += 1;
    console.log('  [FAIL] 产物里没有 wx.cloud.init（登录依赖云托管身份头）');
  }

  // 3. 版本号三处一致
  console.log('');
  const manifestPath = path.join(DIST, '..', '..', '..', 'src', 'manifest.json');
  const brandPath = path.join(DIST, '..', '..', '..', 'src', 'common', 'brand.js');
  let manifestVer = '';
  let brandVer = '';
  try {
    manifestVer = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).versionName || '';
  } catch (e) {
    manifestVer = '';
  }
  try {
    const m = fs.readFileSync(brandPath, 'utf8').match(/APP_VERSION\s*=\s*'([^']+)'/);
    brandVer = m ? m[1] : '';
  } catch (e) {
    brandVer = '';
  }
  const checks = [
    ['manifest.json', manifestVer],
    ['brand.js', brandVer],
  ];
  checks.forEach(([name, v]) => {
    if (v === EXPECT_VERSION) {
      console.log('  [OK]   ' + name + ' = ' + v);
    } else {
      bad += 1;
      console.log('  [FAIL] ' + name + ' = ' + (v || '(读不到)') + '，应为 ' + EXPECT_VERSION);
    }
  });
  console.log('  [提醒]   上传时版本号也必须是 ' + EXPECT_VERSION + '（本脚本看不到上传动作，需人工核对）');

  console.log('');
  if (bad) {
    console.log('[FAIL] AI 版提审包有 ' + bad + ' 项不符合，不能提审');
    return 1;
  }
  console.log('[OK] AI 版提审包自检全部通过');
  return 0;
}

process.exit(main());
