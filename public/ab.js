// AB Testing Client Script
(function() {
  // Hide page immediately
  document.documentElement.classList.add('ab-hide');
  
  // Add styles
  var style = document.createElement('style');
  style.textContent = 'html.ab-hide{opacity:0!important}html:not(.ab-hide){opacity:1!important;transition:opacity .1s}';
  document.head.appendChild(style);

  // Load the resolver script
  var script = document.createElement('script');
  script.src = 'https://ab-resolver.onrender.com/exp/resolve.js?url=' + encodeURIComponent(location.href);
  script.onload = function() {
    // Script loaded, check for redirect
    fetch('https://ab-resolver.onrender.com/exp/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: location.href })
    })
    .then(function(response) { return response.json(); })
    .then(function(exp) {
      console.log('[AB Test] Got response:', exp);
      
      if (exp.active && exp.variant === 'B') {
        var current = location.pathname.replace(/\/$/, '');
        var baseline = new URL(exp.baseline_url).pathname.replace(/\/$/, '');
        
        if (current === baseline) {
          console.log('[AB Test] Redirecting to test variant');
          var test = new URL(exp.test_url);
          test.search = location.search || '';
          test.hash = location.hash || '';
          location.replace(test.toString());
          return;
        }
      }
      
      // No redirect needed
      console.log('[AB Test] No redirect needed');
      document.documentElement.classList.remove('ab-hide');
    })
    .catch(function(err) {
      console.error('[AB Test] Error:', err);
      document.documentElement.classList.remove('ab-hide');
    });
  };
  script.onerror = function(err) {
    console.error('[AB Test] Failed to load resolver script:', err);
    document.documentElement.classList.remove('ab-hide');
  };
  document.head.appendChild(script);
})();