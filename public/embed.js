(function () {
  var script = document.currentScript;
  if (!script || !script.parentNode) return;

  var src = script.getAttribute('src') || '';
  var panel = script.getAttribute('data-panel') || 'map';
  var theme = script.getAttribute('data-theme') || 'dark';
  var heightRaw = parseInt(script.getAttribute('data-height') || '420', 10);
  var height = isFinite(heightRaw) ? Math.max(120, Math.min(1200, heightRaw)) : 420;
  var key = (script.getAttribute('data-key') || '').trim();

  var origin;
  try {
    origin = new URL(src, window.location.href).origin;
  } catch (err) {
    return;
  }

  var iframe = document.createElement('iframe');
  var url = origin + '/embed?panel=' + encodeURIComponent(panel) + '&theme=' + encodeURIComponent(theme);
  iframe.src = url;
  iframe.title = 'World Monitor embed';
  iframe.loading = 'lazy';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.setAttribute('allowfullscreen', '');
  iframe.style.cssText = 'width:100%;height:' + height + 'px;border:0;display:block';

  script.parentNode.insertBefore(iframe, script.nextSibling);

  if (!key || key === 'YOUR_WM_API_KEY') return;

  iframe.addEventListener('load', function () {
    var win = iframe.contentWindow;
    if (!win) return;
    win.postMessage({ source: 'worldmonitor-embed', type: 'credential', key: key }, origin);
  });
})();
