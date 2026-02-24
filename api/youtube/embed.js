export const config = { runtime: 'edge' };

function parseFlag(value, fallback = '1') {
  if (value === '0' || value === '1') return value;
  return fallback;
}

function sanitizeVideoId(value) {
  if (typeof value !== 'string') return null;
  return /^[A-Za-z0-9_-]{11}$/.test(value) ? value : null;
}

const ALLOWED_ORIGINS = [
  /^https:\/\/(.*\.)?worldmonitor\.app$/,
  /^https:\/\/worldmonitor-[a-z0-9-]+-elie-habib-projects\.vercel\.app$/,
  /^https:\/\/worldmonitor-[a-z0-9-]+\.vercel\.app$/,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^tauri:\/\/localhost$/,
];

const ALLOWED_PARENT_ORIGINS = [
  ...ALLOWED_ORIGINS,
  /^https?:\/\/tauri\.localhost$/,
  /^https?:\/\/[a-z0-9-]+\.tauri\.localhost$/,
];

function sanitizeAllowedOrigin(raw, fallback, allowList = ALLOWED_ORIGINS) {
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw);
    if (!['https:', 'http:', 'tauri:'].includes(parsed.protocol)) {
      return fallback;
    }
    const origin = parsed.origin !== 'null' ? parsed.origin : raw;
    if (allowList.some(p => p.test(origin))) return origin;
  } catch { /* invalid URL */ }
  return fallback;
}

function sanitizeOrigin(raw) {
  return sanitizeAllowedOrigin(raw, 'https://worldmonitor.app', ALLOWED_ORIGINS);
}

function sanitizeParentOrigin(raw, fallback) {
  return sanitizeAllowedOrigin(raw, fallback, ALLOWED_PARENT_ORIGINS);
}

export default async function handler(request) {
  const url = new URL(request.url);
  const videoId = sanitizeVideoId(url.searchParams.get('videoId'));

  if (!videoId) {
    return new Response('Missing or invalid videoId', {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const autoplay = parseFlag(url.searchParams.get('autoplay'), '1');
  const mute = parseFlag(url.searchParams.get('mute'), '1');

  const origin = sanitizeOrigin(url.searchParams.get('origin'));
  const parentOrigin = sanitizeParentOrigin(url.searchParams.get('parentOrigin'), origin);

  const embedSrc = new URL(`https://www.youtube-nocookie.com/embed/${videoId}`);
  embedSrc.searchParams.set('autoplay', autoplay);
  embedSrc.searchParams.set('mute', mute);
  embedSrc.searchParams.set('playsinline', '1');
  embedSrc.searchParams.set('rel', '0');
  embedSrc.searchParams.set('controls', '1');
  embedSrc.searchParams.set('enablejsapi', '1');
  embedSrc.searchParams.set('origin', origin);
  embedSrc.searchParams.set('widget_referrer', origin);

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="referrer" content="strict-origin-when-cross-origin" />
  <style>
    html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden}
    #player{width:100%;height:100%}
    #play-overlay{position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;cursor:pointer;background:rgba(0,0,0,0.4)}
    #play-overlay svg{width:72px;height:72px;opacity:0.9;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.5))}
    #play-overlay.hidden{display:none}
  </style>
</head>
<body>
  <div id="player"></div>
  <div id="play-overlay"><svg viewBox="0 0 68 48"><path d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55C3.97 2.33 2.27 4.81 1.48 7.74.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z" fill="red"/><path d="M45 24L27 14v20" fill="#fff"/></svg></div>
  <script>
    var tag=document.createElement('script');
    tag.src='https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    var player,overlay=document.getElementById('play-overlay'),started=false,muteSyncIntervalId,parentOrigin=${JSON.stringify(parentOrigin)},allowedOrigin=${JSON.stringify(parentOrigin)};
    function hideOverlay(){overlay.classList.add('hidden')}
    function readMuted(){
      if(!player)return null;
      if(typeof player.isMuted==='function')return player.isMuted();
      if(typeof player.getVolume==='function')return player.getVolume()===0;
      return null;
    }
    function stopMuteSync(){if(muteSyncIntervalId){clearInterval(muteSyncIntervalId);muteSyncIntervalId=null}}
    function startMuteSync(){
      if(muteSyncIntervalId)return;
      var lastMuted=readMuted();
      if(lastMuted!==null)window.parent.postMessage({type:'yt-mute-state',muted:lastMuted},parentOrigin);
      muteSyncIntervalId=setInterval(function(){
        var m=readMuted();
        if(m!==null&&m!==lastMuted){lastMuted=m;window.parent.postMessage({type:'yt-mute-state',muted:m},parentOrigin)}
      },500);
    }
    function onYouTubeIframeAPIReady(){
      player=new YT.Player('player',{
        videoId:'${videoId}',
        host:'https://www.youtube-nocookie.com',
        playerVars:{autoplay:${autoplay},mute:${mute},playsinline:1,rel:0,controls:1,modestbranding:1,enablejsapi:1,origin:${JSON.stringify(origin)},widget_referrer:${JSON.stringify(origin)}},
        events:{
          onReady:function(){
            window.parent.postMessage({type:'yt-ready'},parentOrigin);
            if(${autoplay}===1){player.playVideo()}
            startMuteSync();
          },
          onError:function(e){stopMuteSync();window.parent.postMessage({type:'yt-error',code:e.data},parentOrigin)},
          onStateChange:function(e){
            window.parent.postMessage({type:'yt-state',state:e.data},parentOrigin);
            if(e.data===1||e.data===3){hideOverlay();started=true}
          }
        }
      });
    }
    overlay.addEventListener('click',function(){
      if(player&&player.playVideo){player.playVideo();player.unMute();hideOverlay()}
    });
    setTimeout(function(){if(!started)overlay.classList.remove('hidden')},3000);
    window.addEventListener('message',function(e){
      if(allowedOrigin!=='*'&&e.origin!==allowedOrigin)return;
      if(!player||!player.getPlayerState)return;
      var m=e.data;if(!m||!m.type)return;
      switch(m.type){
        case'play':player.playVideo();break;
        case'pause':player.pauseVideo();break;
        case'mute':player.mute();break;
        case'unmute':player.unMute();break;
        case'loadVideo':if(m.videoId)player.loadVideoById(m.videoId);break;
      }
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, s-maxage=60, stale-while-revalidate=300',
    },
  });
}
