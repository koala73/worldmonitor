import satori from 'satori';
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import matter from 'gray-matter';

const BLOG_DIR = join(import.meta.dirname, '..', 'src', 'content', 'blog');
const OUT_DIR = join(import.meta.dirname, '..', 'public', 'og');
const WIDTH = 1200;
const HEIGHT = 630;

const interRegular = await fetch('https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfMZg.ttf').then(r => r.arrayBuffer());
const interBold = await fetch('https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuFuYMZg.ttf').then(r => r.arrayBuffer());

mkdirSync(OUT_DIR, { recursive: true });

const files = readdirSync(BLOG_DIR).filter(f => f.endsWith('.md'));
let generated = 0;

function h(type, style, children) {
  return { type, props: { style, children } };
}

for (const file of files) {
  const slug = basename(file, '.md');
  const outPath = join(OUT_DIR, `${slug}.png`);

  if (existsSync(outPath)) {
    console.log(`  skip ${slug} (exists)`);
    continue;
  }

  const raw = readFileSync(join(BLOG_DIR, file), 'utf-8');
  const { data } = matter(raw);
  const title = data.title || slug;
  const audience = data.audience || '';

  const titleChildren = [];
  if (audience) {
    titleChildren.push(
      h('div', {
        fontSize: 14,
        color: '#4ade80',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 2,
      }, audience)
    );
  }
  titleChildren.push(
    h('div', {
      fontSize: title.length > 60 ? 36 : 44,
      fontWeight: 700,
      lineHeight: 1.2,
      color: '#ffffff',
    }, title)
  );

  const element = h('div', {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    padding: '60px 72px',
    backgroundColor: '#050505',
    fontFamily: 'Inter',
    color: '#ffffff',
  }, [
    h('div', { display: 'flex', alignItems: 'center', gap: 16 }, [
      h('div', {
        width: 48,
        height: 48,
        borderRadius: 10,
        backgroundColor: '#4ade80',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 18,
        fontWeight: 700,
        color: '#050505',
      }, 'WM'),
      h('div', { display: 'flex', flexDirection: 'column' }, [
        h('span', { fontSize: 16, fontWeight: 700, letterSpacing: 3, color: '#e5e5e5' }, 'WORLD MONITOR'),
        h('span', { fontSize: 12, color: '#666666', letterSpacing: 1 }, 'BLOG'),
      ]),
    ]),
    h('div', {
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      flex: 1,
      justifyContent: 'center',
    }, titleChildren),
    h('div', {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      borderTop: '1px solid #222222',
      paddingTop: 24,
    }, [
      h('span', { fontSize: 14, color: '#666666' }, 'worldmonitor.app/blog'),
      h('div', { display: 'flex', alignItems: 'center', gap: 8 }, [
        h('div', { width: 8, height: 8, borderRadius: 4, backgroundColor: '#4ade80' }, ''),
        h('span', { fontSize: 14, color: '#4ade80' }, 'Real-time Global Intelligence'),
      ]),
    ]),
  ]);

  const svg = await satori(element, {
    width: WIDTH,
    height: HEIGHT,
    fonts: [
      { name: 'Inter', data: interRegular, weight: 400, style: 'normal' },
      { name: 'Inter', data: interBold, weight: 700, style: 'normal' },
    ],
  });

  const png = await sharp(Buffer.from(svg)).png({ quality: 90 }).toBuffer();
  writeFileSync(outPath, png);
  console.log(`  gen  ${slug}.png`);
  generated++;
}

console.log(`\nOG images: ${generated} generated, ${files.length - generated} skipped`);
