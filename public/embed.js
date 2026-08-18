(function () {
  var script = document.currentScript;
  if (!script || !script.parentNode) return;

  var src = script.getAttribute('src') || '';
  var panel = script.getAttribute('data-panel') || 'map';
  var theme = script.getAttribute('data-theme') || 'dark';
  var heightRaw = parseInt(script.getAttribute('data-height') || '420', 10);
  var height = isFinite(heightRaw) ? Math.max(120, Math.min(1200, heightRaw)) : 420;
  var key = (script.getAttribute('data-key') || '').trim();
  var hasKey = key && key !== 'YOUR_WM_API_KEY';

  var origin;
  try {
    origin = new URL(src, window.location.href).origin;
  } catch (err) {
    return;
  }

  var iframe = document.createElement('iframe');
  var url = origin + '/embed?panel=' + encodeURIComponent(panel) + '&theme=' + encodeURIComponent(theme);
  iframe.title = 'World Monitor embed';
  if (!hasKey) iframe.loading = 'lazy';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.setAttribute('allowfullscreen', '');
  iframe.style.cssText = 'width:100%;height:' + height + 'px;border:0;display:block';

  function postCredential() {
    var win = iframe.contentWindow;
    if (!win || !hasKey) return;
    win.postMessage({ source: 'worldmonitor-embed', type: 'credential', key: key }, origin);
  }

  if (hasKey) {
    window.addEventListener('message', function (event) {
      if (event.origin !== origin) return;
      if (event.source !== iframe.contentWindow) return;
      var data = event.data;
      if (!data || data.source !== 'worldmonitor-embed' || data.type !== 'ready') return;
      postCredential();
    });
    iframe.addEventListener('load', function () {
      postCredential();
      var attempts = 0;
      var timer = setInterval(function () {
        attempts += 1;
        postCredential();
        if (attempts >= 10) clearInterval(timer);
      }, 200);
    });
  }

  iframe.src = url;
  script.parentNode.insertBefore(iframe, script.nextSibling);
})();
