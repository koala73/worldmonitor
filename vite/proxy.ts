export const proxyConfig = () => ({
  // Yahoo Finance API
  '/api/yahoo': {
    target: 'https://query1.finance.yahoo.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/yahoo/, ''),
  },
  // Polymarket handled by polymarketPlugin() — no prod proxy needed
  // USGS Earthquake API
  '/api/earthquake': {
    target: 'https://earthquake.usgs.gov',
    changeOrigin: true,
    timeout: 30000,
    rewrite: (path: string) => path.replace(/^\/api\/earthquake/, ''),
    configure: (proxy: any) => {
      proxy.on('error', (err: any) => {
        console.log('Earthquake proxy error:', err.message);
      });
    },
  },
  // PizzINT - Pentagon Pizza Index
  '/api/pizzint': {
    target: 'https://www.pizzint.watch',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/pizzint/, '/api'),
    configure: (proxy: any) => {
      proxy.on('error', (err: any) => {
        console.log('PizzINT proxy error:', err.message);
      });
    },
  },
  // FRED Economic Data - handled by Vercel serverless function in prod
  // In dev, we proxy to the API directly with the key from .env
  // NOTE: Reads FRED_API_KEY from process.env at proxy-creation time.
  // The key must be set in .env before starting the dev server.
  '/api/fred-data': {
    target: 'https://api.stlouisfed.org',
    changeOrigin: true,
    rewrite: (path: string) => {
      const url = new URL(path, 'http://localhost');
      const seriesId = url.searchParams.get('series_id');
      const start = url.searchParams.get('observation_start');
      const end = url.searchParams.get('observation_end');
      const apiKey = process.env.FRED_API_KEY || '';
      return `/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=10${start ? `&observation_start=${start}` : ''}${end ? `&observation_end=${end}` : ''}`;
    },
  },
  // RSS Feeds - BBC
  '/rss/bbc': {
    target: 'https://feeds.bbci.co.uk',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/bbc/, ''),
  },
  // RSS Feeds - Guardian
  '/rss/guardian': {
    target: 'https://www.theguardian.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/guardian/, ''),
  },
  // RSS Feeds - NPR
  '/rss/npr': {
    target: 'https://feeds.npr.org',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/npr/, ''),
  },
  // RSS Feeds - AP News
  '/rss/apnews': {
    target: 'https://rsshub.app/apnews',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/apnews/, ''),
  },
  // RSS Feeds - Al Jazeera
  '/rss/aljazeera': {
    target: 'https://www.aljazeera.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/aljazeera/, ''),
  },
  // RSS Feeds - CNN
  '/rss/cnn': {
    target: 'http://rss.cnn.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/cnn/, ''),
  },
  // RSS Feeds - Hacker News
  '/rss/hn': {
    target: 'https://hnrss.org',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/hn/, ''),
  },
  // RSS Feeds - Ars Technica
  '/rss/arstechnica': {
    target: 'https://feeds.arstechnica.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/arstechnica/, ''),
  },
  // RSS Feeds - The Verge
  '/rss/verge': {
    target: 'https://www.theverge.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/verge/, ''),
  },
  // RSS Feeds - CNBC
  '/rss/cnbc': {
    target: 'https://www.cnbc.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/cnbc/, ''),
  },
  // RSS Feeds - MarketWatch
  '/rss/marketwatch': {
    target: 'https://feeds.marketwatch.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/marketwatch/, ''),
  },
  // RSS Feeds - Defense/Intel sources
  '/rss/defenseone': {
    target: 'https://www.defenseone.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/defenseone/, ''),
  },
  '/rss/warontherocks': {
    target: 'https://warontherocks.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/warontherocks/, ''),
  },
  '/rss/breakingdefense': {
    target: 'https://breakingdefense.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/breakingdefense/, ''),
  },
  '/rss/bellingcat': {
    target: 'https://www.bellingcat.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/bellingcat/, ''),
  },
  // RSS Feeds - TechCrunch (layoffs)
  '/rss/techcrunch': {
    target: 'https://techcrunch.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/techcrunch/, ''),
  },
  // Google News RSS
  '/rss/googlenews': {
    target: 'https://news.google.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/googlenews/, ''),
  },
  // AI Company Blogs
  '/rss/openai': {
    target: 'https://openai.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/openai/, ''),
  },
  '/rss/anthropic': {
    target: 'https://www.anthropic.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/anthropic/, ''),
  },
  '/rss/googleai': {
    target: 'https://blog.google',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/googleai/, ''),
  },
  '/rss/deepmind': {
    target: 'https://deepmind.google',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/deepmind/, ''),
  },
  '/rss/huggingface': {
    target: 'https://huggingface.co',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/huggingface/, ''),
  },
  '/rss/techreview': {
    target: 'https://www.technologyreview.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/techreview/, ''),
  },
  '/rss/arxiv': {
    target: 'https://rss.arxiv.org',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/arxiv/, ''),
  },
  // Government
  '/rss/whitehouse': {
    target: 'https://www.whitehouse.gov',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/whitehouse/, ''),
  },
  '/rss/statedept': {
    target: 'https://www.state.gov',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/statedept/, ''),
  },
  '/rss/state': {
    target: 'https://www.state.gov',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/state/, ''),
  },
  '/rss/defense': {
    target: 'https://www.defense.gov',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/defense/, ''),
  },
  '/rss/justice': {
    target: 'https://www.justice.gov',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/justice/, ''),
  },
  '/rss/cdc': {
    target: 'https://tools.cdc.gov',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/cdc/, ''),
  },
  '/rss/fema': {
    target: 'https://www.fema.gov',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/fema/, ''),
  },
  '/rss/dhs': {
    target: 'https://www.dhs.gov',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/dhs/, ''),
  },
  '/rss/fedreserve': {
    target: 'https://www.federalreserve.gov',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/fedreserve/, ''),
  },
  '/rss/sec': {
    target: 'https://www.sec.gov',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/sec/, ''),
  },
  '/rss/treasury': {
    target: 'https://home.treasury.gov',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/treasury/, ''),
  },
  '/rss/cisa': {
    target: 'https://www.cisa.gov',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/cisa/, ''),
  },
  // Think Tanks
  '/rss/brookings': {
    target: 'https://www.brookings.edu',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/brookings/, ''),
  },
  '/rss/cfr': {
    target: 'https://www.cfr.org',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/cfr/, ''),
  },
  '/rss/csis': {
    target: 'https://www.csis.org',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/csis/, ''),
  },
  // Defense
  '/rss/warzone': {
    target: 'https://www.thedrive.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/warzone/, ''),
  },
  '/rss/defensegov': {
    target: 'https://www.defense.gov',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/defensegov/, ''),
  },
  // Security
  '/rss/krebs': {
    target: 'https://krebsonsecurity.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/krebs/, ''),
  },
  // Finance
  '/rss/yahoonews': {
    target: 'https://finance.yahoo.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/yahoonews/, ''),
  },
  // Diplomat
  '/rss/diplomat': {
    target: 'https://thediplomat.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/diplomat/, ''),
  },
  // VentureBeat
  '/rss/venturebeat': {
    target: 'https://venturebeat.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/venturebeat/, ''),
  },
  // Foreign Policy
  '/rss/foreignpolicy': {
    target: 'https://foreignpolicy.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/foreignpolicy/, ''),
  },
  // Financial Times
  '/rss/ft': {
    target: 'https://www.ft.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/ft/, ''),
  },
  // Reuters
  '/rss/reuters': {
    target: 'https://www.reutersagency.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/rss\/reuters/, ''),
  },
  // Cloudflare Radar - Internet outages
  '/api/cloudflare-radar': {
    target: 'https://api.cloudflare.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/cloudflare-radar/, ''),
  },
  // NGA Maritime Safety Information - Navigation Warnings
  '/api/nga-msi': {
    target: 'https://msi.nga.mil',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/nga-msi/, ''),
  },
  // GDELT GEO 2.0 API - Global event data
  '/api/gdelt': {
    target: 'https://api.gdeltproject.org',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/gdelt/, ''),
  },
  // AISStream WebSocket proxy for live vessel tracking
  '/ws/aisstream': {
    target: 'wss://stream.aisstream.io',
    changeOrigin: true,
    ws: true,
    rewrite: (path: string) => path.replace(/^\/ws\/aisstream/, ''),
  },
  // FAA NASSTATUS - Airport delays and closures
  '/api/faa': {
    target: 'https://nasstatus.faa.gov',
    changeOrigin: true,
    secure: true,
    rewrite: (path: string) => path.replace(/^\/api\/faa/, ''),
    configure: (proxy: any) => {
      proxy.on('error', (err: any) => {
        console.log('FAA NASSTATUS proxy error:', err.message);
      });
    },
  },
  // OpenSky Network - Aircraft tracking (military flight detection)
  '/api/opensky': {
    target: 'https://opensky-network.org/api',
    changeOrigin: true,
    secure: true,
    rewrite: (path: string) => path.replace(/^\/api\/opensky/, ''),
    configure: (proxy: any) => {
      proxy.on('error', (err: any) => {
        console.log('OpenSky proxy error:', err.message);
      });
    },
  },
  // ADS-B Exchange - Military aircraft tracking (backup/supplement)
  '/api/adsb-exchange': {
    target: 'https://adsbexchange.com/api',
    changeOrigin: true,
    secure: true,
    rewrite: (path: string) => path.replace(/^\/api\/adsb-exchange/, ''),
    configure: (proxy: any) => {
      proxy.on('error', (err: any) => {
        console.log('ADS-B Exchange proxy error:', err.message);
      });
    },
  },
});
