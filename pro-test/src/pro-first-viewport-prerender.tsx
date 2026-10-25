import { renderToStaticMarkup } from 'react-dom/server';
import { ProHomeShell } from './App';
import { initStaticI18n } from './i18n';

export const PRO_CONTENT_SLOT = '<template data-wm-pro-content=""></template>';

/**
 * The /pro shell (nav, <main>, hero) as static English markup, with
 * PRO_CONTENT_SLOT where the page's curated crawlable content belongs inside
 * <main>. The client still mounts with createRoot, replacing all of it.
 */
export async function renderProFirstViewport(heroSrLead: string): Promise<string> {
  await initStaticI18n();
  return renderToStaticMarkup(
    <ProHomeShell heroSrLead={heroSrLead}>
      <template data-wm-pro-content="" />
    </ProHomeShell>,
  );
}
