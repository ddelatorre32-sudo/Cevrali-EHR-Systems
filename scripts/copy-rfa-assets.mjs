import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist-server/templates', { recursive: true });
for (const name of ['dwc-rfa-2014.pdf', 'rfa-font.ttf', 'FONT_LICENSE.txt'])
  await cp(`server/templates/${name}`, `dist-server/templates/${name}`);
